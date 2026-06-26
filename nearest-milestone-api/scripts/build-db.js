/**
 * build-db.js — Generate milemarkers.db from NTAD NHS
 *
 * Fetches NTAD National Highway System segments in parallel OID batches,
 * interpolates one point per integer mile, writes to SQLite.
 *
 * Usage:  node scripts/build-db.js
 * Output: data/milemarkers.db  (~5-10 MB)
 * Time:   ~15-20 min (10 parallel workers)
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'milemarkers.db');
const NHS_URL = 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Highway_System/FeatureServer/0';
const BATCH = 200;   // features per request
const WORKERS = 10;  // parallel requests

const FIPS = {
  1:'AL',2:'AK',4:'AZ',5:'AR',6:'CA',8:'CO',9:'CT',10:'DE',11:'DC',12:'FL',
  13:'GA',15:'HI',16:'ID',17:'IL',18:'IN',19:'IA',20:'KS',21:'KY',22:'LA',
  23:'ME',24:'MD',25:'MA',26:'MI',27:'MN',28:'MS',29:'MO',30:'MT',31:'NE',
  32:'NV',33:'NH',34:'NJ',35:'NM',36:'NY',37:'NC',38:'ND',39:'OH',40:'OK',
  41:'OR',42:'PA',44:'RI',45:'SC',46:'SD',47:'TN',48:'TX',49:'UT',50:'VT',
  51:'VA',53:'WA',54:'WV',55:'WI',56:'WY',72:'PR',
};

function get(url, retries = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'mile-marker-build/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return get(res.headers.location, retries).then(resolve).catch(reject);
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', err => {
      if (retries > 0) {
        setTimeout(() => get(url, retries - 1).then(resolve).catch(reject), 1500);
      } else reject(err);
    });
  });
}

function dist(a, b) {
  const R = 6371000, lat1 = a[1]*Math.PI/180, lat2 = b[1]*Math.PI/180;
  const dLat = lat2-lat1, dLng = (b[0]-a[0])*Math.PI/180;
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

function interpolate(path, t) {
  const lens = []; let total = 0;
  for (let i = 1; i < path.length; i++) { const d = dist(path[i-1], path[i]); lens.push(d); total += d; }
  if (total === 0) return path[0];
  const target = t * total; let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    if (acc + lens[i] >= target) {
      const frac = (target - acc) / lens[i], a = path[i], b = path[i+1];
      return [a[0] + (b[0]-a[0])*frac, a[1] + (b[1]-a[1])*frac];
    }
    acc += lens[i];
  }
  return path[path.length - 1];
}

function routeLabel(a) {
  const type = (a.SIGNT1 ?? '').trim();
  const num  = (a.SIGNN1 ?? '').trim();
  if (!num) return null;
  const prefix = { I: 'I', U: 'US', S: 'SR', C: 'CR' }[type] ?? type;
  return prefix ? `${prefix}-${num}` : null;
}

function processFeatures(features) {
  const rows = [];
  for (const f of features) {
    const a = f.attributes;
    const paths = f.geometry?.paths ?? [];
    if (!paths.length) continue;
    const route = routeLabel(a);
    if (!route) continue;
    const state = FIPS[a.STFIPS] ?? null;
    const begin = a.BEGINPOINT ?? 0;
    const end   = a.ENDPOINT   ?? 0;
    const span  = end - begin;
    if (span <= 0) continue;
    const path = paths.flat();
    for (let mp = Math.ceil(begin); mp <= Math.floor(end); mp++) {
      const [lng, lat] = interpolate(path, (mp - begin) / span);
      rows.push([route, state, mp, lat, lng]);
    }
  }
  return rows;
}

async function fetchBatch(start, end) {
  const url = `${NHS_URL}/query?where=OBJECTID+BETWEEN+${start}+AND+${end}` +
    `&outFields=STFIPS,SIGNT1,SIGNN1,BEGINPOINT,ENDPOINT` +
    `&returnGeometry=true&outSR=4326&maxAllowableOffset=0.001&f=json`;
  const page = await get(url);
  return processFeatures(page.features ?? []);
}

(async () => {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  // Get max OID
  const stats = await get(`${NHS_URL}/query?where=1=1&outStatistics=[{"statisticType":"max","onStatisticField":"OBJECTID","outStatisticFieldName":"maxOID"}]&f=json`);
  const maxOID = stats.features?.[0]?.attributes?.maxOID ?? 492005;
  console.log(`Total OIDs: ${maxOID}, batches: ${Math.ceil(maxOID/BATCH)}, workers: ${WORKERS}`);

  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE mileposts (
      route TEXT NOT NULL, state TEXT, milepost REAL NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL
    );
    CREATE INDEX idx_ll ON mileposts (lat, lng);
    CREATE INDEX idx_rt ON mileposts (route);
  `);
  const ins = db.prepare('INSERT INTO mileposts VALUES (?,?,?,?,?)');

  let done = 0, totalMarkers = 0;
  const batches = [];
  for (let i = 1; i <= maxOID; i += BATCH) batches.push([i, Math.min(i + BATCH - 1, maxOID)]);
  const total = batches.length;

  // Worker pool
  async function worker(queue) {
    while (queue.length) {
      const [start, end] = queue.shift();
      let rows;
      try {
        rows = await fetchBatch(start, end);
      } catch (e) {
        // One more retry
        try { rows = await fetchBatch(start, end); } catch { rows = []; }
      }
      // Write to DB (single-threaded)
      if (rows.length) {
        db.run('BEGIN');
        for (const r of rows) ins.run(r);
        db.run('COMMIT');
        totalMarkers += rows.length;
      }
      done++;
      process.stdout.write(`\r  ${done}/${total} batches | ${totalMarkers} markers   `);
    }
  }

  const queue = [...batches];
  await Promise.all(Array.from({ length: WORKERS }, () => worker(queue)));

  ins.free();
  process.stdout.write('\n');

  const buf = Buffer.from(db.export());
  db.close();
  fs.writeFileSync(DB_PATH, buf);
  console.log(`\nDone! ${totalMarkers} mile markers → ${DB_PATH} (${(buf.length/1024/1024).toFixed(1)} MB)`);
})().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
