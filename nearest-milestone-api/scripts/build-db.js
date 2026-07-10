/**
 * build-db.js — One-time script: NTAD NHS segments → milemarkers.db
 *
 * DATA SOURCE
 *   NTAD National Highway System (FHWA → BTS)
 *   https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Highway_System/FeatureServer/0
 *
 *   Each NHS feature is a polyline road segment with:
 *     SIGNT1 / SIGNN1  — route type + number (e.g. type "I", num "80" → "I-80")
 *     SIGN1            — compact form (e.g. "I76")
 *     BEGINPOINT       — local milepost at segment start (within this ROUTEID group)
 *     ENDPOINT         — local milepost at segment end
 *     MILES            — physical length of this segment in miles
 *     LNAME            — named highway (e.g. "Pennsylvania Tpke", "Lincoln Hwy")
 *     geometry.paths   — ordered [lng, lat] vertices of the road centerline
 *
 * THE MILEPOST PROBLEM
 *   The NTAD data has hundreds of ROUTEIDs per route+state (152 for I-76 PA
 *   alone). Each ROUTEID has its own local BEGINPOINT/ENDPOINT starting near 0.
 *   These are NOT statewide cumulative values — they can't be used directly
 *   as mile marker numbers.
 *
 *   SOLUTION: Geographic chain-stitching.
 *   For each (route, state) group:
 *     1. Fetch all segments WITH geometry.
 *     2. Identify the geographic terminus (westernmost end for east-west routes,
 *        southernmost end for north-south routes). This is mile 0.
 *     3. Chain segments together by matching geographic endpoints (nearest-
 *        neighbor search on segment ends vs. next segment starts).
 *     4. Accumulate MILES along the chain to get each segment's statewide
 *        milepost offset.
 *     5. Within each segment, use BEGINPOINT+offset as the base and walk
 *        the geometry to place integer mileposts.
 *
 * HOW MILEPOST POSITIONS ARE CALCULATED (per segment)
 *   For each integer mile N falling in [segStartMP, segEndMP]:
 *     1. Compute t = (N − segStartMP) / (segEndMP − segStartMP)
 *     2. Walk the polyline vertices accumulating haversine distances
 *        until the running total reaches t × total_segment_length
 *     3. Linearly interpolate [lng, lat] at that point
 *     4. Store { route, state, milepost: N, lat, lng, name } in SQLite
 *
 * FETCH STRATEGY
 *   Phase 1: Fetch ALL features without geometry (fast, ~492k records, ~30 batches).
 *            Groups them by (state, route) to build a route registry.
 *   Phase 2: For each (state, route) group, fetch those specific OBJECTIDs
 *            WITH geometry, chain-stitch, and generate mile markers.
 *
 * Usage:  node scripts/build-db.js
 * Output: data/milemarkers.db  (SQLite, ~300k+ rows)
 * Time:   ~20–30 min
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'milemarkers.db');
const NHS_URL = 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Highway_System/FeatureServer/0';
const BATCH        = 200;  // OBJECTIDs per request (phase 1 no-geom)
const GEOM_BATCH   = 50;   // OBJECTIDs per request (phase 2 with geometry)
const WORKERS      = 8;    // parallel requests

const FIPS = {
  1:'AL',2:'AK',4:'AZ',5:'AR',6:'CA',8:'CO',9:'CT',10:'DE',11:'DC',12:'FL',
  13:'GA',15:'HI',16:'ID',17:'IL',18:'IN',19:'IA',20:'KS',21:'KY',22:'LA',
  23:'ME',24:'MD',25:'MA',26:'MI',27:'MN',28:'MS',29:'MO',30:'MT',31:'NE',
  32:'NV',33:'NH',34:'NJ',35:'NM',36:'NY',37:'NC',38:'ND',39:'OH',40:'OK',
  41:'OR',42:'PA',44:'RI',45:'SC',46:'SD',47:'TN',48:'TX',49:'UT',50:'VT',
  51:'VA',53:'WA',54:'WV',55:'WI',56:'WY',72:'PR',
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

function get(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'mile-marker-build/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return get(res.headers.location, retries).then(resolve).catch(reject);
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', err => {
      if (retries > 0) {
        setTimeout(() => get(url, retries - 1).then(resolve).catch(reject), 2000);
      } else reject(err);
    });
  });
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

/** Haversine distance in metres between two [lng, lat] points. */
function dist([lng1, lat1], [lng2, lat2]) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Interpolate a [lng, lat] point at fractional distance t along a polyline. */
function interpolate(vertices, t) {
  if (vertices.length === 1) return vertices[0];
  const lens = [];
  let total = 0;
  for (let i = 1; i < vertices.length; i++) {
    const d = dist(vertices[i - 1], vertices[i]);
    lens.push(d);
    total += d;
  }
  if (total === 0) return vertices[0];
  const target = Math.min(t, 1) * total;
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    if (acc + lens[i] >= target) {
      const frac = lens[i] > 0 ? (target - acc) / lens[i] : 0;
      const [ax, ay] = vertices[i];
      const [bx, by] = vertices[i + 1];
      return [ax + (bx - ax) * frac, ay + (by - ay) * frac];
    }
    acc += lens[i];
  }
  return vertices[vertices.length - 1];
}

// ── Route label ───────────────────────────────────────────────────────────────

function routeLabel(a) {
  const type = (a.SIGNT1 ?? '').trim();
  const num  = (a.SIGNN1 ?? '').trim();
  if (!num) return null;
  const prefix = { I: 'I', U: 'US', S: 'SR', C: 'CR' }[type] ?? type;
  return prefix ? `${prefix}-${num}` : null;
}

// ── Chain-stitching algorithm ─────────────────────────────────────────────────
//
// Each segment has a polyline. We need to order them so the end of one
// connects to the start of the next, forming a single continuous route.
//
// 1. Represent each segment as { startPt, endPt, vertices, miles, begin, end }
// 2. Find the global terminus (westernmost or southernmost endpoint across all segments)
// 3. Greedily chain: from current endpoint, find the nearest unvisited segment start/end
// 4. If we attach a segment in reverse, flip its vertices so it reads start→end
// 5. Return segments in chained order with their cumulative mile offset

function chainSegments(segs) {
  if (!segs.length) return [];

  // For each segment, extract the start and end of its path
  const items = segs.map(s => {
    const verts = s.vertices;
    return {
      ...s,
      startPt: verts[0],
      endPt:   verts[verts.length - 1],
    };
  });

  // Determine primary axis: if the route spans more east-west than north-south,
  // the terminus is the westernmost point; otherwise southernmost.
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const it of items) {
    for (const [lng, lat] of it.vertices) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  const lngSpan = maxLng - minLng;
  const latSpan = maxLat - minLat;
  // Primary axis: E-W if wider, N-S otherwise
  const isEW = lngSpan >= latSpan;

  // Find which item has the terminus endpoint (westernmost or southernmost)
  let terminusItem = null;
  let terminusPt   = null;
  let terminusBest = isEW ? Infinity : Infinity; // looking for min lng or min lat

  for (const it of items) {
    for (const pt of [it.startPt, it.endPt]) {
      const val = isEW ? pt[0] : pt[1]; // lng for EW, lat for NS
      if (val < terminusBest) {
        terminusBest = val;
        terminusPt   = pt;
        terminusItem = it;
      }
    }
  }

  // Orient terminus item so startPt is the terminus
  if (terminusPt !== terminusItem.startPt) {
    terminusItem.vertices = [...terminusItem.vertices].reverse();
    [terminusItem.startPt, terminusItem.endPt] = [terminusItem.endPt, terminusItem.startPt];
  }

  // Greedy chain
  const visited = new Set();
  const chain   = [terminusItem];
  visited.add(terminusItem);

  while (visited.size < items.length) {
    const last = chain[chain.length - 1];
    const cursor = last.endPt;

    // Find nearest unvisited segment (by start or end pt)
    let bestItem  = null;
    let bestDist  = Infinity;
    let bestFlip  = false;

    for (const it of items) {
      if (visited.has(it)) continue;
      const dStart = dist(cursor, it.startPt);
      const dEnd   = dist(cursor, it.endPt);
      if (dStart < bestDist) { bestDist = dStart; bestItem = it; bestFlip = false; }
      if (dEnd   < bestDist) { bestDist = dEnd;   bestItem = it; bestFlip = true;  }
    }

    if (!bestItem) break; // disconnected remainder — shouldn't happen on clean data

    if (bestFlip) {
      bestItem.vertices = [...bestItem.vertices].reverse();
      [bestItem.startPt, bestItem.endPt] = [bestItem.endPt, bestItem.startPt];
    }

    chain.push(bestItem);
    visited.add(bestItem);
  }

  // Accumulate cumulative mile offsets
  let cumOffset = 0;
  const result = [];
  for (const seg of chain) {
    result.push({ ...seg, cumOffset });
    cumOffset += seg.miles;
  }

  return result;
}

// ── Generate integer milepost rows from a chained segment ────────────────────

function milesFromSegment(seg, route, state, lname) {
  const rows = [];
  // Statewide milepost at each local point within this segment:
  //   statewideMP = cumOffset + (localBEGIN + localSpan * t)
  // We want integer values, so:
  //   intMP = Math.ceil(segStartStatewise) to Math.floor(segEndStatewise)
  const segStartSW = seg.cumOffset + seg.begin; // statewide MP at segment start
  const segEndSW   = seg.cumOffset + seg.end;   // statewide MP at segment end
  const localSpan  = seg.end - seg.begin;
  const swSpan     = segEndSW - segStartSW;

  if (swSpan <= 0) return rows;

  for (let mp = Math.ceil(segStartSW); mp <= Math.floor(segEndSW); mp++) {
    // t is fraction along this segment where integer MP falls
    const t = (mp - segStartSW) / swSpan;
    const [lng, lat] = interpolate(seg.vertices, t);
    rows.push([route, state, mp, parseFloat(lat.toFixed(6)), parseFloat(lng.toFixed(6)), lname ?? '']);
  }
  return rows;
}

// ── Phase 1: collect all OBJECTIDs grouped by (route, state) ─────────────────

async function fetchAllMeta(maxOID) {
  // Map of "route|state" → array of OBJECTIDs
  const routeMap = new Map();
  const batches = [];
  for (let i = 1; i <= maxOID; i += BATCH) batches.push([i, Math.min(i + BATCH - 1, maxOID)]);

  let done = 0;
  const total = batches.length;

  async function worker(queue) {
    while (queue.length) {
      const [start, end] = queue.shift();
      let page;
      try {
        const url = `${NHS_URL}/query?where=OBJECTID+BETWEEN+${start}+AND+${end}` +
          `&outFields=OBJECTID,STFIPS,SIGNT1,SIGNN1,LNAME,BEGINPOINT,ENDPOINT,MILES` +
          `&returnGeometry=false&f=json`;
        page = await get(url);
      } catch (e) {
        try {
          const url = `${NHS_URL}/query?where=OBJECTID+BETWEEN+${start}+AND+${end}` +
            `&outFields=OBJECTID,STFIPS,SIGNT1,SIGNN1,LNAME,BEGINPOINT,ENDPOINT,MILES` +
            `&returnGeometry=false&f=json`;
          page = await get(url);
        } catch { page = { features: [] }; }
      }
      for (const f of page.features ?? []) {
        const a = f.attributes;
        const route = routeLabel(a);
        if (!route) continue;
        const state = FIPS[a.STFIPS] ?? null;
        if (!state) continue;
        const key = `${route}|${state}`;
        if (!routeMap.has(key)) routeMap.set(key, { route, state, lname: null, segs: [] });
        const entry = routeMap.get(key);
        // Keep first non-empty LNAME for this route
        if (!entry.lname && a.LNAME && a.LNAME.trim()) entry.lname = a.LNAME.trim();
        entry.segs.push({
          oid:   a.OBJECTID,
          begin: a.BEGINPOINT ?? 0,
          end:   a.ENDPOINT   ?? 0,
          miles: a.MILES      ?? 0,
        });
      }
      done++;
      if (done % 50 === 0 || done === total) {
        process.stdout.write(`\r  Phase 1: ${done}/${total} batches, ${routeMap.size} routes   `);
      }
    }
  }

  const queue = [...batches];
  await Promise.all(Array.from({ length: WORKERS }, () => worker(queue)));
  process.stdout.write('\n');
  return routeMap;
}

// ── Phase 2: fetch geometry for a route's segments and produce mile markers ───

async function fetchGeomBatch(oids) {
  const url = `${NHS_URL}/query?objectIds=${oids.join(',')}` +
    `&outFields=OBJECTID,BEGINPOINT,ENDPOINT,MILES` +
    `&returnGeometry=true&outSR=4326&f=json`;
  const page = await get(url);
  return page.features ?? [];
}

async function processRoute(entry) {
  const { route, state, lname, segs } = entry;
  if (!segs.length) return [];

  // Fetch geometry in batches
  const oids = segs.map(s => s.oid);
  const geomFeatures = [];
  for (let i = 0; i < oids.length; i += GEOM_BATCH) {
    const slice = oids.slice(i, i + GEOM_BATCH);
    let features;
    try {
      features = await fetchGeomBatch(slice);
    } catch {
      try { features = await fetchGeomBatch(slice); } catch { features = []; }
    }
    geomFeatures.push(...features);
  }

  // Build a map from OID to meta (begin/end/miles) using phase-1 data
  const metaByOid = new Map(segs.map(s => [s.oid, s]));

  // Merge geometry
  const segObjects = [];
  for (const f of geomFeatures) {
    const oid  = f.attributes.OBJECTID;
    const meta = metaByOid.get(oid);
    if (!meta) continue;
    const paths = f.geometry?.paths ?? [];
    if (!paths.length) continue;
    const vertices = paths.flat(); // flatten [[lng,lat],[lng,lat],...] from nested paths
    if (vertices.length < 2) continue;
    const begin = f.attributes.BEGINPOINT ?? meta.begin;
    const end   = f.attributes.ENDPOINT   ?? meta.end;
    const miles = f.attributes.MILES      ?? meta.miles;
    if ((end - begin) <= 0 || miles <= 0) continue;
    segObjects.push({ oid, begin, end, miles, vertices });
  }

  if (!segObjects.length) return [];

  // Chain segments geographically and compute cumulative offsets
  const chained = chainSegments(segObjects);

  // Generate integer milepost rows
  const rows = [];
  for (const seg of chained) {
    rows.push(...milesFromSegment(seg, route, state, lname));
  }
  return rows;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  // Get max OID
  console.log('Fetching max OBJECTID...');
  const stats = await get(`${NHS_URL}/query?where=1=1&outStatistics=[{"statisticType":"max","onStatisticField":"OBJECTID","outStatisticFieldName":"maxOID"}]&f=json`);
  const maxOID = stats.features?.[0]?.attributes?.maxOID ?? 500000;
  console.log(`Max OID: ${maxOID}`);

  // Phase 1: collect metadata for all segments, grouped by route+state
  console.log('\nPhase 1: collecting segment metadata...');
  const routeMap = await fetchAllMeta(maxOID);
  console.log(`Found ${routeMap.size} distinct route+state combinations\n`);

  // Initialise SQLite DB
  const SQL = await initSqlJs();
  const db  = new SQL.Database();
  db.run(`
    CREATE TABLE mileposts (
      route    TEXT NOT NULL,
      state    TEXT,
      milepost REAL NOT NULL,
      lat      REAL NOT NULL,
      lng      REAL NOT NULL,
      name     TEXT
    );
    CREATE INDEX idx_ll ON mileposts (lat, lng);
    CREATE INDEX idx_rt ON mileposts (route, state);
  `);
  const ins = db.prepare('INSERT INTO mileposts VALUES (?,?,?,?,?,?)');

  // Phase 2: fetch geometry per route+state, chain-stitch, generate rows
  console.log('Phase 2: fetching geometry and generating mile markers...');
  const routeEntries = [...routeMap.values()];
  let doneRoutes = 0;
  let totalMarkers = 0;
  const totalRoutes = routeEntries.length;

  async function routeWorker(queue) {
    while (queue.length) {
      const entry = queue.shift();
      let rows;
      try {
        rows = await processRoute(entry);
      } catch (e) {
        rows = [];
      }
      if (rows.length) {
        db.run('BEGIN');
        for (const r of rows) ins.run(r);
        db.run('COMMIT');
        totalMarkers += rows.length;
      }
      doneRoutes++;
      if (doneRoutes % 10 === 0 || doneRoutes === totalRoutes) {
        process.stdout.write(`\r  Phase 2: ${doneRoutes}/${totalRoutes} routes | ${totalMarkers} markers   `);
      }
    }
  }

  const queue = [...routeEntries];
  // Use fewer workers for phase 2 since each route fetches many batches
  await Promise.all(Array.from({ length: WORKERS }, () => routeWorker(queue)));

  ins.free();
  process.stdout.write('\n');

  const buf = Buffer.from(db.export());
  db.close();
  fs.writeFileSync(DB_PATH, buf);
  console.log(`\nDone! ${totalMarkers} mile markers → ${DB_PATH} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
})().catch(err => { console.error('\nFatal:', err.message, err.stack); process.exit(1); });
