import { fetchNearby } from "../services/overpass.js";

const R = 6371000;

// Tier priority for road classification sorting (lower = more important)
const HIGHWAY_TIER = {
  motorway: 1,
  trunk: 2,
  primary: 3,
  motorway_link: 4,
  trunk_link: 5,
  primary_link: 6,
};

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

function minWayDist(way, lat, lng) {
  return Math.min(
    ...(way.geometry ?? []).map((p) => haversine(lat, lng, p.lat, p.lon)),
  );
}

/** Normalize OSM ref: semicolons → slash, "I 88" → "I-88" */
function normalizeRef(ref) {
  if (!ref) return null;
  return ref
    .replace(/;/g, "/")
    .replace(
      /\b(I|US|SR|IL|IN|CA|TX|NY|FL|OH|PA|VA|WA|OR|CO|AZ|GA|NC|MI|MN|WI|MO|TN|AL|SC|KY|LA|AR)\s+(\d)/g,
      "$1-$2",
    );
}

const HEADING_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const HEADING_LABELS = {
  N: 'Northbound', NE: 'Northeastbound', E: 'Eastbound', SE: 'Southeastbound',
  S: 'Southbound', SW: 'Southwestbound', W: 'Westbound', NW: 'Northwestbound',
};

/** Compute the compass bearing (0–360) between two lat/lon points. */
function bearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Snap a heading string (N/NE/E/…) to the nearest cardinal/intercardinal,
 * then return a label if the way's dominant bearing matches within 67.5°.
 */
function resolveDirectionLabel(heading, way) {
  const dir = heading?.toUpperCase();
  if (!dir || !HEADING_LABELS[dir]) return null;
  const geom = way?.geometry;
  if (!geom || geom.length < 2) return null;
  // Use first → last node for dominant orientation
  const wayBearing = bearing(geom[0].lat, geom[0].lon, geom[geom.length - 1].lat, geom[geom.length - 1].lon);
  // Convert heading string to degrees
  const targetDeg = HEADING_DIRS.indexOf(dir) * 45;
  const diff = Math.abs(((wayBearing - targetDeg + 540) % 360) - 180);
  return diff <= 67.5 ? HEADING_LABELS[dir] : null;
}

/** Build a human-ready display string for a highway way. */
function highwayDisplay(tags) {
  const ref = normalizeRef(tags?.ref);
  const name = tags?.name ?? null;
  if (ref && name) return `${ref} (${name})`;
  return ref ?? name ?? "Unknown Highway";
}

/** Build a human-ready display string for an exit junction. */
function exitDisplay(exit, highwayName) {
  const base = exit ? `Exit ${exit}` : "Exit";
  return highwayName ? `${base} — ${highwayName}` : base;
}

/**
 * POST/GET /nearest-milestone
 */
export async function getNearestMilestone(req, res, next) {
  const { lat, lng, source_type, precision_tier } = req.coords;
  const limit = Math.min(parseInt(req.query.limit) || 5, 20);
  const practical = req.query.routing === "practical";
  const heading = req.query.heading?.toUpperCase() ?? null;
  const useKm = req.query.units === "km";

  // Expand search radius for low-precision inputs (zip/city)
  const radius = precision_tier === "low" ? 3000 : 1000;

  let elements;
  try {
    elements = await fetchNearby(lat, lng, radius);
  } catch (err) {
    return next(err);
  }

  const milestones = elements.filter(
    (e) => e.type === "node" && e.tags?.highway === "milestone",
  );
  const junctions = elements.filter(
    (e) => e.type === "node" && e.tags?.highway === "motorway_junction",
  );
  const ways = elements.filter((e) => e.type === "way");

  // Sort ways: mainline roads first (practical), then by distance
  const sortedWays = [...ways].sort((a, b) => {
    const ta = HIGHWAY_TIER[a.tags?.highway] ?? 9;
    const tb = HIGHWAY_TIER[b.tags?.highway] ?? 9;
    if (practical && ta !== tb) return ta - tb;
    return minWayDist(a, lat, lng) - minWayDist(b, lat, lng);
  });

  if (!milestones.length) {
    if (!ways.length && !junctions.length) {
      return res.json({
        results: [],
        precision: { source_type, precision_tier, radius_m: radius },
        message: "No highway infrastructure found near this location",
      });
    }

    // Deduplicate ways by highway+ref+name key
    const seen = new Set();
    const nearby_highways = sortedWays
      .filter((w) => {
        const key = `${w.tags?.highway}|${w.tags?.ref ?? ""}|${w.tags?.name ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((w) => ({
        osm_id: w.id,
        highway: w.tags?.highway ?? null,
        name: w.tags?.name ?? null,
        ref: normalizeRef(w.tags?.ref),
        display_name: highwayDisplay(w.tags),
      }));

    // Find the primary highway name for exit display_name context
    const mainHighway = sortedWays.find(
      (w) => w.tags?.highway === "motorway" || w.tags?.highway === "trunk",
    );
    const mainName = mainHighway ? highwayDisplay(mainHighway.tags) : null;

    const nearby_exits = junctions
      .map((j) => ({
        osm_id: j.id,
        exit: j.tags?.ref ?? null,
        name: j.tags?.name ?? null,
        display_name: exitDisplay(j.tags?.ref, mainName),
        distance_m: Math.round(haversine(lat, lng, j.lat, j.lon)),
        lat: j.lat,
        lon: j.lon,
      }))
      .sort((a, b) => a.distance_m - b.distance_m)
      .filter(
        (j, _, arr) =>
          arr.findIndex((x) => x.exit === j.exit) === arr.indexOf(j),
      );

    return res.json({
      results: [],
      precision: { source_type, precision_tier, radius_m: radius },
      message: `No mile markers mapped on ${normalizeRef(mainHighway?.tags?.ref) ?? mainHighway?.tags?.name ?? "the nearby highway"} near this location. Exit numbers on toll roads often correspond to mile positions.`,
      ...(nearby_exits.length && { nearby_exits }),
      ...(nearby_highways.length && { nearby_highways }),
    });
  }

  const results = milestones
    .map((node) => {
      const { tags = {} } = node;
      const distance_m = Math.round(haversine(lat, lng, node.lat, node.lon));

      let ref = tags.ref ?? null;
      let name = tags.name ?? null;

      // Bind highway context from closest (practical: mainline-first) way
      let closestWay = null;
      if (!ref && !name && sortedWays.length) {
        closestWay = practical
          ? sortedWays[0]
          : sortedWays.reduce((best, w) =>
              minWayDist(w, node.lat, node.lon) <
              minWayDist(best, node.lat, node.lon)
                ? w
                : best,
            );
        ref = closestWay.tags?.ref ?? ref;
        name = closestWay.tags?.name ?? name;
      } else if (sortedWays.length) {
        closestWay = practical
          ? sortedWays[0]
          : sortedWays.reduce((best, w) =>
              minWayDist(w, node.lat, node.lon) <
              minWayDist(best, node.lat, node.lon)
                ? w
                : best,
            );
      }

      const refFormatted = normalizeRef(ref);
      const markerVal = tags.distance ?? tags.pk ?? tags.ref ?? "?";
      const unit = useKm ? "km" : "";
      const markerLabel = unit ? `${markerVal}${unit}` : markerVal;
      const highwayPart =
        refFormatted && name
          ? `${refFormatted} (${name})`
          : refFormatted ?? name ?? "Unknown Highway";

      // Direction label from heading param
      const dirLabel = heading ? resolveDirectionLabel(heading, closestWay) : null;
      const dirPart = dirLabel ? ` ${dirLabel}` : "";

      // Side-of-road from OSM tag
      const SIDE_LABELS = { left: "Left Shoulder", right: "Right Shoulder" };
      const sidePart = SIDE_LABELS[tags.side] ? ` (${SIDE_LABELS[tags.side]})` : "";

      const display_name = `Mile Marker ${markerLabel}${sidePart} — ${highwayPart}${dirPart}`;

      return {
        osm_id: node.id,
        highway: tags.highway ?? "milestone",
        name,
        ref: refFormatted,
        marker: tags.distance ?? tags.pk ?? tags.ref ?? null,
        display_name,
        ...(dirLabel && { direction: dirLabel }),
        ...(tags.side && { side: tags.side }),
        distance_m,
        lat: node.lat,
        lon: node.lon,
      };
    })
    .sort((a, b) => {
      if (practical) {
        const ta = HIGHWAY_TIER[a.highway] ?? 9;
        const tb = HIGHWAY_TIER[b.highway] ?? 9;
        if (ta !== tb) return ta - tb;
      }
      return a.distance_m - b.distance_m;
    })
    .slice(0, limit);

  res.json({
    results,
    precision: { source_type, precision_tier, radius_m: radius, units: useKm ? "km" : "mi" },
  });
}
