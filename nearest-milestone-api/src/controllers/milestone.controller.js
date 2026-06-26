import { findNearest, isAvailable } from '../services/ntad.js';
import { fetchNearby } from '../services/overpass.js';

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

function buildDisplay(route, milepost, state) {
  const mp = Number.isInteger(milepost) ? milepost : parseFloat(milepost.toFixed(1));
  const statePart = state ? ` (${state})` : '';
  return `Mile Marker ${mp} — ${route}${statePart}`;
}

// ── NTAD path ─────────────────────────────────────────────────────────────────

async function ntadResults(lat, lng, limit, useKm) {
  const markers = await findNearest(lat, lng, limit, 5000);
  if (!markers.length) return null;

  return markers.map(m => {
    const mp = parseFloat(m.milepost.toFixed(1));
    const dist = useKm ? `${(m.distance_m / 1000).toFixed(2)} km` : `${m.distance_m} m`;
    return {
      route: m.route,
      state: m.state,
      milepost: mp,
      display_name: buildDisplay(m.route, mp, m.state),
      distance_m: m.distance_m,
      distance_display: dist,
      lat: m.lat,
      lng: m.lng,
    };
  });
}

// ── Overpass fallback path ────────────────────────────────────────────────────

const HIGHWAY_TIER = { motorway: 1, trunk: 2, primary: 3, motorway_link: 4, trunk_link: 5, primary_link: 6 };

function minWayDist(way, lat, lng) {
  return Math.min(...(way.geometry ?? []).map(p => haversine(lat, lng, p.lat, p.lon)));
}

function normalizeRef(ref) {
  if (!ref) return null;
  return ref
    .replace(/;/g, '/')
    .replace(/\b(I|US|SR|IL|IN|CA|TX|NY|FL|OH|PA|VA|WA|OR|CO|AZ|GA|NC|MI|MN|WI|MO|TN|AL|SC|KY|LA|AR)\s+(\d)/g, '$1-$2');
}

async function overpassResults(lat, lng, radius, limit, useKm) {
  const elements = await fetchNearby(lat, lng, radius);

  const milestones = elements.filter(e => e.type === 'node' && e.tags?.highway === 'milestone');
  const junctions  = elements.filter(e => e.type === 'node' && e.tags?.highway === 'motorway_junction');
  const ways       = elements.filter(e => e.type === 'way');

  const sortedWays = [...ways].sort((a, b) => {
    const ta = HIGHWAY_TIER[a.tags?.highway] ?? 9;
    const tb = HIGHWAY_TIER[b.tags?.highway] ?? 9;
    if (ta !== tb) return ta - tb;
    return minWayDist(a, lat, lng) - minWayDist(b, lat, lng);
  });

  if (milestones.length) {
    const results = milestones
      .map(node => {
        const { tags = {} } = node;
        const distance_m = Math.round(haversine(lat, lng, node.lat, node.lon));
        const markerRaw = tags.distance ?? tags.pk ?? tags.ref;
        if (markerRaw == null) return null;

        const closestWay = sortedWays[0] ?? null;
        const ref = normalizeRef(tags.ref ?? closestWay?.tags?.ref);
        const name = tags.name ?? closestWay?.tags?.name;
        if (!ref && !name) return null;

        const mp = parseFloat(markerRaw);
        const highwayPart = ref && name ? `${ref} (${name})` : ref ?? name;
        const dist = useKm ? `${(distance_m / 1000).toFixed(2)} km` : `${distance_m} m`;

        return {
          route: ref ?? name,
          milepost: isNaN(mp) ? markerRaw : mp,
          display_name: `Mile Marker ${isNaN(mp) ? markerRaw : mp} — ${highwayPart}`,
          distance_m,
          distance_display: dist,
          lat: node.lat,
          lng: node.lon,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance_m - b.distance_m)
      .slice(0, limit);

    if (results.length) return { type: 'milestones', results };
  }

  const mainWay = sortedWays.find(w => w.tags?.highway === 'motorway' || w.tags?.highway === 'trunk');
  const mainRef = normalizeRef(mainWay?.tags?.ref);
  const mainName = mainWay?.tags?.name;
  const mainLabel = mainRef && mainName ? `${mainRef} (${mainName})` : mainRef ?? mainName;

  const seen = new Set();
  const nearby_highways = sortedWays
    .filter(w => {
      const ref = normalizeRef(w.tags?.ref);
      const name = w.tags?.name;
      if (!ref && !name) return false;
      const key = `${w.tags?.highway}|${ref ?? ''}|${name ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(w => ({
      highway: w.tags.highway,
      ref: normalizeRef(w.tags?.ref),
      name: w.tags?.name ?? null,
      display_name: normalizeRef(w.tags?.ref) && w.tags?.name
        ? `${normalizeRef(w.tags.ref)} (${w.tags.name})`
        : normalizeRef(w.tags?.ref) ?? w.tags?.name,
    }));

  const nearby_exits = junctions
    .filter(j => j.tags?.ref != null)
    .map(j => ({
      exit: j.tags.ref,
      name: j.tags?.name ?? null,
      display_name: j.tags?.name ? `Exit ${j.tags.ref} — ${j.tags.name}` : `Exit ${j.tags.ref}`,
      distance_m: Math.round(haversine(lat, lng, j.lat, j.lon)),
      lat: j.lat,
      lng: j.lon,
    }))
    .sort((a, b) => a.distance_m - b.distance_m)
    .filter((j, _, arr) => arr.findIndex(x => x.exit === j.exit) === arr.indexOf(j));

  return { type: 'fallback', nearby_highways, nearby_exits, mainLabel };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function getNearestMilestone(req, res, next) {
  const { lat, lng, source_type, precision_tier } = req.coords;
  const limit  = Math.min(parseInt(req.query.limit) || 5, 20);
  const useKm  = req.query.units === 'km';
  const radius = precision_tier === 'low' ? 3000 : 1000;

  // 1. Try NTAD (local SQLite — covers all US states)
  if (isAvailable()) {
    try {
      const results = await ntadResults(lat, lng, limit, useKm);
      if (results) {
        return res.json({
          results,
          source: 'ntad',
          precision: { source_type, precision_tier, radius_m: 5000 },
        });
      }
    } catch (err) {
      console.warn('NTAD lookup failed, falling back to Overpass:', err.message);
    }
  }

  // 2. Overpass fallback (non-US or NTAD miss)
  let overpass;
  try {
    overpass = await overpassResults(lat, lng, radius, limit, useKm);
  } catch (err) {
    return next(err);
  }

  if (overpass.type === 'milestones') {
    return res.json({
      results: overpass.results,
      source: 'osm',
      precision: { source_type, precision_tier, radius_m: radius },
    });
  }

  const { nearby_exits, nearby_highways, mainLabel } = overpass;

  if (!nearby_exits.length && !nearby_highways.length) {
    return res.json({
      results: [],
      source: 'none',
      precision: { source_type, precision_tier, radius_m: radius },
      message: 'No highway infrastructure found near this location.',
    });
  }

  return res.json({
    results: [],
    source: 'none',
    precision: { source_type, precision_tier, radius_m: radius },
    message: mainLabel
      ? `No mile markers found on ${mainLabel} near this location.`
      : 'No mile markers found near this location.',
    ...(nearby_exits.length  && { nearby_exits }),
    ...(nearby_highways.length && { nearby_highways }),
  });
}
