import axios from 'axios';

// Simple TTL cache: key → { data, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];

export class OverpassError extends Error {
  constructor(msg, code = 'OVERPASS_ERROR') { super(msg); this.code = code; }
}

/**
 * Fetch milestone nodes, junction nodes, and nearby highway ways within 1000m.
 * Tries each endpoint in order until one succeeds.
 */
export async function fetchNearby(lat, lng, radius = 1000) {
  const cacheKey = `${lat.toFixed(5)},${lng.toFixed(5)},${radius}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const query = `[out:json][timeout:10];
(
  node(around:${radius},${lat},${lng})["highway"="milestone"];
  node(around:${radius},${lat},${lng})["highway"="motorway_junction"];
  way(around:${radius},${lat},${lng})["highway"~"motorway|trunk|primary"];
);
out geom;`;

  const body = `data=${encodeURIComponent(query)}`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'nearest-milestone-api/1.0',
  };

  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const { data } = await axios.post(url, body, { headers, timeout: 10000 });
      const elements = data.elements ?? [];
      cacheSet(cacheKey, elements);
      return elements;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // Only try next mirror on server-side errors; bail immediately on client errors
      if (status && status < 500) break;
    }
  }

  if (lastErr?.code === 'ECONNABORTED' || lastErr?.message?.includes('timeout')) {
    throw new OverpassError('Overpass API timed out', 'OVERPASS_TIMEOUT');
  }
  throw new OverpassError(lastErr?.message ?? 'Overpass request failed');
}
