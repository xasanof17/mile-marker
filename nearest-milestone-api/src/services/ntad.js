/**
 * ntad.js — Local SQLite mile marker lookup
 *
 * The database (data/milemarkers.db) contains 307,600 rows built from the
 * NTAD National Highway System. Each row is one integer milepost:
 *   { route TEXT, state TEXT, milepost REAL, lat REAL, lng REAL }
 *
 * HOW NEAREST-MARKER LOOKUP WORKS
 *   A full table scan over 307k rows per request would be slow. Instead:
 *
 *   1. BOUNDING BOX PRE-FILTER (SQL, uses the lat/lng index)
 *      Convert maxDistM → degree padding:
 *        padLat = maxDistM / 111,000          (1° lat ≈ 111 km everywhere)
 *        padLng = maxDistM / (111,000 × cos(lat))  (1° lng shrinks near poles)
 *      SQL: WHERE lat BETWEEN (lat−padLat) AND (lat+padLat)
 *               AND lng BETWEEN (lng−padLng) AND (lng+padLng)
 *      This cuts candidates from 307k → typically a few hundred.
 *
 *   2. HAVERSINE EXACT DISTANCE (JS, on the small candidate set)
 *      For each candidate row, compute the true great-circle distance in metres.
 *      Filter to those within maxDistM, sort ascending, return top N.
 *
 * The database connection is opened once on first call and reused (module-level
 * singleton). sql.js loads the entire DB into a WASM SQLite instance in memory,
 * so queries are microseconds after the first cold open (~100ms).
 */

import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'milemarkers.db');

const R = 6371000; // Earth radius in metres

/** Haversine great-circle distance between two lat/lng points (metres). */
function haversine(lat1, lng1, lat2, lng2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Singleton DB connection — opened once, reused across all requests.
let _db = null;

async function getDb() {
  if (_db) return _db;
  if (!fs.existsSync(DB_PATH)) return null;
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  _db = new SQL.Database(buf);
  return _db;
}

/** Returns true if milemarkers.db exists on disk. */
export function isAvailable() {
  return fs.existsSync(DB_PATH);
}

/**
 * Find the nearest N mileposts to (lat, lng) within maxDistM metres.
 *
 * @param {number} lat       - Decimal degrees latitude
 * @param {number} lng       - Decimal degrees longitude
 * @param {number} limit     - Max results to return (default 5)
 * @param {number} maxDistM  - Search radius in metres (default 5000)
 * @returns {Array<{ route, state, milepost, lat, lng, distance_m }>}
 */
export async function findNearest(lat, lng, limit = 5, maxDistM = 5000) {
  const db = await getDb();
  if (!db) return [];

  // Step 1: bounding-box pre-filter using the SQL index
  const padLat = maxDistM / 111000;
  const padLng = maxDistM / (111000 * Math.cos((lat * Math.PI) / 180));

  const stmt = db.prepare(`
    SELECT route, state, milepost, lat, lng
    FROM mileposts
    WHERE lat BETWEEN $latMin AND $latMax
      AND lng BETWEEN $lngMin AND $lngMax
  `);

  const rows = [];
  stmt.bind({ $latMin: lat - padLat, $latMax: lat + padLat, $lngMin: lng - padLng, $lngMax: lng + padLng });
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  // Step 2: exact haversine distance, filter, sort, slice
  return rows
    .map(r => ({ ...r, distance_m: Math.round(haversine(lat, lng, r.lat, r.lng)) }))
    .filter(r => r.distance_m <= maxDistM)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);
}
