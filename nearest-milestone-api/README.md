# Nearest Mile Marker API

A Node.js/Express REST API that returns the **nearest real highway mile markers** for any US location — by coordinate, address, or Plus Code.

Mile marker data comes from the **NTAD National Highway System** (Federal Highway Administration via BTS), interpolated to exact lat/lng points for every integer milepost on all US interstates, US routes, and state routes in all 50 states. No OSM, no crowdsourcing — authoritative federal data.

---

## How Mile Markers Are Calculated

The API does not look up pre-placed pins. It **interpolates** milepost positions from the NTAD NHS road geometry using a two-phase geographic chain-stitching approach:

1. **Source:** The NTAD NHS dataset stores each highway as hundreds of short polyline segments, each with a local `BEGINPOINT`/`ENDPOINT` and a `MILES` field (physical segment length). The `BEGINPOINT` values are *segment-local* — they restart near 0 for each internal route section and cannot be used directly as mile marker numbers.

2. **Chain-stitching:** For each route+state combination, all segments are fetched with geometry. The build script identifies the geographic terminus (westernmost point for E-W routes, southernmost for N-S routes), then greedily chains segments together by nearest endpoint, accumulating `MILES` to compute a true statewide cumulative milepost offset for each segment.

3. **Interpolation:** Within each segment, for every integer statewide milepost that falls in its range, the script walks the polyline vertex-by-vertex using the haversine formula and places a point at the exact fractional position on the road centerline.

4. **Result:** Each record in the database is `{ route, state, milepost, lat, lng, name }` — the precise coordinate where that mile marker sign stands, with the correct statewide number (plus the named highway where available, e.g. "Pennsylvania Tpke").

5. **Lookup:** At query time, a bounding-box SQL pre-filter narrows candidates, then haversine sorts by actual distance from your location. The nearest N markers are returned.

**Example:** `40.00572, -78.68660` (I-76 near Breezewood, PA) → `Mile Marker 135 — I-76 (PA) / Pennsylvania Tpke` at 0.20 mi.

---

## Coverage

| Network | Coverage |
|---|---|
| US Interstates (I-xx) | ✅ All 50 states |
| US Routes (US-xx) | ✅ All 50 states |
| State Routes (SR-xx) | ✅ Where in NHS |
| Territories (PR) | ✅ Included |
| Non-US locations | Overpass OSM fallback |

**293,000+ mile markers** across 5,200+ route+state combinations. Database: ~26 MB SQLite, loaded into memory at startup.

---

## Quick Start

### Local

```bash
cp .env.example .env
npm install
npm start
```

### Docker

```bash
cp .env.example .env
docker compose up
```

Server runs on `http://localhost:3000`.

### Rebuild the mile marker database (optional)

The `data/milemarkers.db` file is included and ready to use. To regenerate from the latest NTAD data:

```bash
npm run build-db
```

This downloads ~492k NHS segments from the BTS ArcGIS REST service, chain-stitches segments geographically per route to produce accurate statewide mileposts, then interpolates all integer milepost positions. Takes ~20–30 minutes.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port |
| `NOMINATIM_COUNTRY_CODE` | No | *(global)* | Restrict address geocoding to a country (e.g. `us`) |

---

## API Reference

### `GET /health`

```json
{ "status": "ok" }
```

---

### `POST /nearest-milestone` · `GET /nearest-milestone`

Returns the nearest highway mile markers to a location.

#### Query Parameters

| Parameter | Values | Description |
|---|---|---|
| `limit` | integer, max 20 | Number of results (default 5) |
| `units` | `km` | Return kilometre values instead of miles |
| `routing` | `practical` | Sort mainline roads above ramps |
| `heading` | `N` `NE` `E` `SE` `S` `SW` `W` `NW` | Append travel direction label (OSM fallback only) |

#### POST body

```json
{ "location": "<see input types>" }
```

#### GET equivalent

```
GET /nearest-milestone?location=41.5744,-87.0556&limit=3
```

---

### Input Types

Resolved automatically in this order:

| Type | Example |
|---|---|
| Coordinate object | `{ "lat": 41.5744, "lng": -87.0556 }` |
| Coordinate string | `"41.5744,-87.0556"` |
| Full Plus Code | `"87G7PXRX+86"` |
| Compound Plus Code | `"PXRX+86 Valparaiso, IN"` |
| Street address | `"I-80 near Gary, Indiana"` |
| City / zip | `"46403"` or `"Gary, IN"` |

City/zip inputs expand the search radius to 3 km automatically.

---

### Example Requests

```bash
# By coordinate
curl -X POST https://nearest-milestone-api.onrender.com/nearest-milestone \
  -H "Content-Type: application/json" \
  -d '{"location": {"lat": 41.5744, "lng": -87.0556}}'

# By coordinate string
curl -X POST https://nearest-milestone-api.onrender.com/nearest-milestone \
  -H "Content-Type: application/json" \
  -d '{"location": "41.5744,-87.0556"}'

# By address
curl -X POST "https://nearest-milestone-api.onrender.com/nearest-milestone?limit=3" \
  -H "Content-Type: application/json" \
  -d '{"location": "I-95 near Richmond, Virginia"}'

# GET form
curl "https://nearest-milestone-api.onrender.com/nearest-milestone?location=41.5744,-87.0556"

# Plus Code
curl -X POST https://nearest-milestone-api.onrender.com/nearest-milestone \
  -H "Content-Type: application/json" \
  -d '{"location": "87G7PXRX+86"}'
```

---

### Response — Markers Found

```json
{
  "results": [
    {
      "route": "I-80",
      "state": "IN",
      "milepost": 9,
      "name": null,
      "display_name": "Mile Marker 9 — I-80 (IN)",
      "distance_m": 241,
      "distance_display": "0.15 mi",
      "lat": 41.57514,
      "lng": -87.05832
    },
    {
      "route": "SR-49",
      "state": "IN",
      "milepost": 22,
      "name": null,
      "display_name": "Mile Marker 22 — SR-49 (IN)",
      "distance_m": 1052,
      "distance_display": "0.65 mi",
      "lat": 41.57955,
      "lng": -87.04499
    }
  ],
  "source": "ntad",
  "precision": {
    "source_type": "coordinate",
    "precision_tier": "high",
    "radius_m": 5000
  }
}
```

| Field | Description |
|---|---|
| `route` | Highway route label (`I-80`, `US-30`, `SR-49`) |
| `state` | Two-letter state code |
| `milepost` | Integer mile marker number (statewide cumulative) |
| `name` | Named highway if available (e.g. `"Pennsylvania Tpke"`, `"Lincoln Hwy"`) |
| `display_name` | Ready-to-print string for Telegram/UI |
| `distance_m` | Straight-line distance in metres from your input (raw, used for sorting) |
| `distance_display` | Human-readable distance (`0.15 mi`, or km if `?units=km`) |

---

### Response — No Markers (Fallback)

When outside the US or on a road not in the NHS, the OSM Overpass fallback runs. If no milestones are mapped, nearby exits and roads are returned:

```json
{
  "results": [],
  "source": "none",
  "message": "No mile markers found on I-80/I-90 (Indiana Toll Road) near this location.",
  "current_location": { "lat": 41.5744, "lng": -87.0556 },
  "heading": "Eastbound",
  "nearby_exits": [
    {
      "exit": "31",
      "display_name": "Exit 31 — I-80/I-90 (Indiana Toll Road)",
      "distance_m": 134,
      "lat": 41.5747,
      "lng": -87.0572
    }
  ],
  "nearby_highways": [
    {
      "highway": "motorway",
      "ref": "I-80/I-90",
      "display_name": "I-80/I-90 (Indiana Toll Road)",
      "direction_label": "Eastbound"
    }
  ]
}
```

---

### Error Responses

| HTTP | Code | Cause |
|---|---|---|
| `400` | — | `location` field missing |
| `422` | `GEOCODER_ERROR` | Address not found |
| `422` | `PLUS_CODE_ERROR` | Malformed Plus Code |
| `422` | `INVALID_COORDS` | Coordinates out of range |
| `503` | `OVERPASS_TIMEOUT` | Overpass API timed out (non-US fallback) |

---

## Architecture

```
Request
   │
   ▼
express-validator          → 400 if location missing
   │
   ▼
express-rate-limit         → 15 req/min per IP
   │
   ▼
normalizeLocation middleware
   ├── { lat, lng } object   → high precision
   ├── "lat,lng" string      → high precision
   ├── Full Plus Code        → offline decode
   ├── Compound Plus Code    → geocode locality + offline recover
   └── address string        → Nominatim geocode
   │
   ▼  req.coords = { lat, lng, source_type, precision_tier }
   │
   ▼
milestone.controller
   ├── isAvailable()?
   │     YES → findNearest(lat, lng, limit, 5000m)
   │           └── SQL bounding box → haversine sort → top N
   │           └── return { results, source: "ntad" }
   │
   └── NO / miss → Overpass fetchNearby(lat, lng, radius)
         ├── milestones found → format + return
         └── no milestones → nearby exits + highways
```

---

## Project Structure

```
nearest-milestone-api/
├── data/
│   └── milemarkers.db          # 293k+ mile markers, all US states (~26 MB)
├── scripts/
│   └── build-db.js             # One-time: NTAD NHS → SQLite (chain-stitch algorithm)
├── src/
│   ├── app.js                  # Express app, error handler
│   ├── server.js               # HTTP listener
│   ├── routes/
│   │   └── milestone.routes.js # Validation, rate limiting, GET+POST
│   ├── middleware/
│   │   └── normalizeLocation.js # Input detection → req.coords
│   ├── controllers/
│   │   └── milestone.controller.js # NTAD lookup → Overpass fallback
│   └── services/
│       ├── ntad.js             # SQLite nearest-marker lookup
│       ├── overpass.js         # Overpass client, mirror failover
│       ├── geocoder.js         # Nominatim client
│       └── plusCode.js         # open-location-code bridge
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Data Sources

| Source | What | Cost |
|---|---|---|
| NTAD National Highway System (FHWA/BTS) | Road geometry + milepost begin/end for all NHS segments | Free (public domain) |
| Overpass API (OpenStreetMap) | Fallback for non-US locations | Free |
| Nominatim | Address geocoding | Free (rate-limited) |
| open-location-code | Plus Code decoding | Free / offline |

NTAD data is public domain. OSM data © OpenStreetMap contributors (ODbL).

---

## Telegram Bot

A companion Telegram bot is included in `telegram-bot/`. Send your location or type any address/coordinate and it returns the nearest mile markers.

```bash
cd telegram-bot
cp .env.example .env   # add TELEGRAM_TOKEN and API_URL
npm install
npm start
```
