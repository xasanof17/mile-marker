import { decodePlusCode, isFull, decodeShortCode } from '../services/plusCode.js';
import { geocodeAddress } from '../services/geocoder.js';

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

// Nominatim OSM types that indicate a broad/low-precision match
const LOW_PRECISION_TYPES = new Set(['postcode', 'city', 'town', 'village', 'county', 'state', 'country']);

function validRange(lat, lng) {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function precisionFromNominatim(result) {
  const type = result?.type ?? result?.addresstype ?? '';
  if (LOW_PRECISION_TYPES.has(type)) return 'low';
  // house_number, building, amenity → high; street/road → medium
  if (type === 'house' || result?.class === 'building') return 'high';
  return 'medium';
}

/**
 * Resolve req.body.location to req.coords = { lat, lng, source_type, precision_tier }.
 * Detection order: object coords → coord string → Plus Code → Nominatim.
 */
export async function normalizeLocation(req, _res, next) {
  const loc = req.body?.location;

  try {
    let lat, lng, source_type, precision_tier;

    // 1. Plain object with lat/lng
    if (loc !== null && typeof loc === 'object') {
      lat = Number(loc.lat);
      lng = Number(loc.lng);
      source_type = 'coordinate';
      precision_tier = 'high';
    }
    else if (typeof loc === 'string') {
      const m = loc.match(COORD_RE);
      // 2. Coordinate string "lat,lng"
      if (m) {
        lat = parseFloat(m[1]);
        lng = parseFloat(m[2]);
        source_type = 'coordinate';
        precision_tier = 'high';
      }
      // 3. Full Plus Code
      else if (isFull(loc)) {
        ({ lat, lng } = decodePlusCode(loc));
        source_type = 'plus_code';
        precision_tier = 'high';
      }
      // 4. Compound Plus Code: "PXRX+86 City, State"
      else if (/^[23456789CFGHJMPQRVWX]{4,}\+[23456789CFGHJMPQRVWX]{2,}\s+.+$/i.test(loc)) {
        const spaceIdx = loc.indexOf(' ');
        const shortCode = loc.slice(0, spaceIdx);
        const locality = loc.slice(spaceIdx + 1);
        const ref = await geocodeAddress(locality);
        ({ lat, lng } = decodeShortCode(shortCode, ref.lat, ref.lng));
        source_type = 'plus_code';
        precision_tier = 'high';
      }
      // 5. Free-text address → Nominatim
      else {
        const result = await geocodeAddress(loc);
        lat = result.lat;
        lng = result.lng;
        source_type = 'address';
        precision_tier = precisionFromNominatim(result._raw);
      }
    } else {
      return next();
    }

    if (!validRange(lat, lng)) {
      const err = new Error('Coordinates out of valid range');
      err.code = 'INVALID_COORDS';
      return next(err);
    }

    req.coords = { lat, lng, source_type, precision_tier };
    next();
  } catch (err) {
    next(err);
  }
}
