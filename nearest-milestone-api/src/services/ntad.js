import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'milemarkers.db');

const R = 6371000;

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

let _db = null;

async function getDb() {
  if (_db) return _db;
  if (!fs.existsSync(DB_PATH)) return null;
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(DB_PATH);
  _db = new SQL.Database(buf);
  return _db;
}

export function isAvailable() {
  return fs.existsSync(DB_PATH);
}

/**
 * Find the nearest N mileposts to (lat, lng) within maxDistM metres.
 * Returns [{ route, state, milepost, lat, lng, distance_m }]
 */
export async function findNearest(lat, lng, limit = 5, maxDistM = 5000) {
  const db = await getDb();
  if (!db) return [];

  const padLat = maxDistM / 111000;
  const padLng = maxDistM / (111000 * Math.cos((lat * Math.PI) / 180));

  const stmt = db.prepare(`
    SELECT route, state, milepost, lat, lng
    FROM mileposts
    WHERE lat BETWEEN $latMin AND $latMax
      AND lng BETWEEN $lngMin AND $lngMax
  `);

  const rows = stmt.getAsObject
    ? (() => {
        const results = [];
        stmt.bind({ $latMin: lat - padLat, $latMax: lat + padLat, $lngMin: lng - padLng, $lngMax: lng + padLng });
        while (stmt.step()) results.push(stmt.getAsObject());
        stmt.free();
        return results;
      })()
    : [];

  return rows
    .map(r => ({ ...r, distance_m: Math.round(haversine(lat, lng, r.lat, r.lng)) }))
    .filter(r => r.distance_m <= maxDistM)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);
}
