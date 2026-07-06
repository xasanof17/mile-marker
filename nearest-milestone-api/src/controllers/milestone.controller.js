/**
 * milestone.controller.js
 *
 * Primary path  — NTAD SQLite (US locations)
 *   findNearest() queries data/milemarkers.db: bounding-box SQL pre-filter
 *   then haversine sort. Returns real mile markers for all US interstates,
 *   US routes, and state routes in all 50 states.
 *
 * Fallback path — Overpass OSM (non-US, or no NTAD hit within 5 km)
 *   fetchNearby() queries OpenStreetMap for highway=milestone nodes.
 *   OSM milestone coverage in the US is nearly zero, so this path mainly
 *   serves international locations. When no milestones exist at all,
 *   nearby motorway_junction exits and highway ways are returned instead.
 *
 * No result is returned with unknown/null route, milepost, or display_name.
 * Items missing complete data are filtered out before the response is built.
 */
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

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function toDegrees(rad) {
  return (rad * 180) / Math.PI;
}

function bearing(lat1, lng1, lat2, lng2) {
  const φ1 = toRadians(lat1);
  const φ2 = toRadians(lat2);
  const Δλ = toRadians(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function bearingLabel(deg) {
  const labels = [
    'Northbound',
    'Northeastbound',
    'Eastbound',
    'Southeastbound',
    'Southbound',
    'Southwestbound',
    'Westbound',
    'Northwestbound',
  ];
  const index = Math.floor((deg + 22.5) / 45) % 8;
  return labels[index];
}

function wayDirectionLabel(way, lat, lng) {
  const geometry = way?.geometry;
  if (!Array.isArray(geometry) || geometry.length < 2) return null;

  let bestIndex = 0;
  let bestDist = Infinity;
  for (let i = 0; i < geometry.length; i++) {
    const point = geometry[i];
    const d = haversine(lat, lng, point.lat, point.lon);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }

  const current = geometry[bestIndex];
  const next = bestIndex < geometry.length - 1 ? geometry[bestIndex + 1] : null;
  const prev = bestIndex > 0 ? geometry[bestIndex - 1] : null;

  if (next && prev) {
    const distNext = haversine(lat, lng, next.lat, next.lon);
    const distPrev = haversine(lat, lng, prev.lat, prev.lon);
    const chosen = distNext <= distPrev ? next : prev;
    const target = chosen === next ? next : current;
    const source = chosen === next ? current : prev;
    return bearingLabel(bearing(source.lat, source.lon, target.lat, target.lon));
  }

  if (next) return bearingLabel(bearing(current.lat, current.lon, next.lat, next.lon));
  if (prev) return bearingLabel(bearing(prev.lat, prev.lon, current.lat, current.lon));
  return null;
}

function buildRoadContext(lat, lng, elements) {
  const junctions = elements.filter(e => e.type === 'node' && e.tags?.highway === 'motorway_junction');
  const ways = elements.filter(e => e.type === 'way');

  const sortedWays = [...ways].sort((a, b) => {
    const ta = HIGHWAY_TIER[a.tags?.highway] ?? 9;
    const tb = HIGHWAY_TIER[b.tags?.highway] ?? 9;
    if (ta !== tb) return ta - tb;
    return minWayDist(a, lat, lng) - minWayDist(b, lat, lng);
  });

  const mainWay = sortedWays.find(w => w.tags?.highway === 'motorway' || w.tags?.highway === 'trunk');
  const mainRef = normalizeRef(mainWay?.tags?.ref);
  const mainName = mainWay?.tags?.name;
  const mainLabel = mainRef && mainName ? `${mainRef} (${mainName})` : mainRef ?? mainName;
  const direction_label = mainWay ? wayDirectionLabel(mainWay, lat, lng) : null;

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
      direction_label: wayDirectionLabel(w, lat, lng),
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

  return { nearby_highways, nearby_exits, mainLabel, direction_label };
}

// ── NTAD path ─────────────────────────────────────────────────────────────────

async function ntadResults(lat, lng, limit, useKm) {
  const markers = await findNearest(lat, lng, limit, 5000);
  if (!markers.length) return null;

  return markers.map(m => {
    const mp = parseFloat(m.milepost.toFixed(1));
    const dist = useKm
      ? `${(m.distance_m / 1000).toFixed(2)} km`
      : `${(m.distance_m / 1609.344).toFixed(2)} mi`;
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
  const context = buildRoadContext(lat, lng, elements);

  const milestones = elements.filter(e => e.type === 'node' && e.tags?.highway === 'milestone');
  if (milestones.length) {
    const results = milestones
      .map(node => {
        const { tags = {} } = node;
        const distance_m = Math.round(haversine(lat, lng, node.lat, node.lon));
        const markerRaw = tags.distance ?? tags.pk ?? tags.ref;
        if (markerRaw == null) return null;

        const closestWay = elements
          .filter(e => e.type === 'way')
          .sort((a, b) => minWayDist(a, lat, lng) - minWayDist(b, lat, lng))[0] ?? null;

        const ref = normalizeRef(tags.ref ?? closestWay?.tags?.ref);
        const name = tags.name ?? closestWay?.tags?.name;
        if (!ref && !name) return null;

        const mp = parseFloat(markerRaw);
        const highwayPart = ref && name ? `${ref} (${name})` : ref ?? name;
        const dist = useKm
          ? `${(distance_m / 1000).toFixed(2)} km`
          : `${(distance_m / 1609.344).toFixed(2)} mi`;
        const direction_label = closestWay ? wayDirectionLabel(closestWay, node.lat, node.lon) : null;

        return {
          route: ref ?? name,
          milepost: isNaN(mp) ? markerRaw : mp,
          display_name: `Mile Marker ${isNaN(mp) ? markerRaw : mp} — ${highwayPart}`,
          distance_m,
          distance_display: dist,
          lat: node.lat,
          lng: node.lon,
          direction_label,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance_m - b.distance_m)
      .slice(0, limit);

    if (results.length) return { type: 'milestones', results, ...context };
  }

  return { type: 'fallback', ...context };
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
        let context = { nearby_exits: [], nearby_highways: [], heading: null };
        try {
          const elements = await fetchNearby(lat, lng, 3000);
          context = buildRoadContext(lat, lng, elements);
        } catch (err) {
          console.warn('Overpass context fetch failed for NTAD result:', err.message);
        }

        return res.json({
          results,
          source: 'ntad',
          precision: { source_type, precision_tier, radius_m: 5000 },
          current_location: { lat, lng },
          heading: context.direction_label,
          nearby_exits: context.nearby_exits,
          nearby_highways: context.nearby_highways,
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
    // If Overpass is unreachable and NTAD already found nothing, return a graceful no-results
    if (err.code === 'OVERPASS_TIMEOUT' || err.code === 'OVERPASS_ERROR') {
      console.warn('Overpass unavailable for fallback path:', err.message);
      return res.json({
        results: [],
        source: 'none',
        precision: { source_type, precision_tier, radius_m: radius },
        current_location: { lat, lng },
        heading: null,
        message: 'No mile markers found near this location (road context service temporarily unavailable).',
        nearby_exits: [],
        nearby_highways: [],
      });
    }
    return next(err);
  }

  if (overpass.type === 'milestones') {
    return res.json({
      results: overpass.results,
      source: 'osm',
      precision: { source_type, precision_tier, radius_m: radius },
      current_location: { lat, lng },
      heading: overpass.direction_label,
      nearby_exits: overpass.nearby_exits,
      nearby_highways: overpass.nearby_highways,
    });
  }

  const { nearby_exits, nearby_highways, mainLabel, direction_label } = overpass;

  if (!nearby_exits.length && !nearby_highways.length) {
    return res.json({
      results: [],
      source: 'none',
      precision: { source_type, precision_tier, radius_m: radius },
      current_location: { lat, lng },
      heading: direction_label,
      message: 'No highway infrastructure found near this location.',
      nearby_exits,
      nearby_highways,
    });
  }

  return res.json({
    results: [],
    source: 'none',
    precision: { source_type, precision_tier, radius_m: radius },
    current_location: { lat, lng },
    heading: direction_label,
    message: mainLabel
      ? `No mile markers found on ${mainLabel} near this location.`
      : 'No mile markers found near this location.',
    nearby_exits,
    nearby_highways,
  });
}
