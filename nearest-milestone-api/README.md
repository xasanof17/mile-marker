# Nearest Mile Marker API

A Node.js/Express REST API that returns the **nearest real highway mile markers** for any US location — by coordinate, address, or Plus Code.

Mile marker data comes from the **NTAD National Highway System** (Federal Highway Administration via BTS), interpolated to exact lat/lng points for every integer milepost on all US interstates, US routes, and state routes in all 50 states. No OSM, no crowdsourcing — authoritative federal data.

---

## How Mile Markers Are Calculated

The API does not look up pre-placed pins. It **interpolates** milepost positions from the NTAD NHS road geometry:

1. **Source:** The NTAD NHS dataset (FHWA → BTS) stores every highway segment as a polyline with `BEGINPOINT` and `ENDPOINT` milepost values (e.g. MM 157.02 → MM 176.06).

2. **Interpolation:** For each integer mile within a segment's range, the build script walks the polyline vertex-by-vertex using the haversine formula to accumulate distance, then places a point at the exact fractional position where that mile falls on the road geometry.

3. **Result:** Each record in the database is `{ route, state, milepost, lat, lng }` — the precise coordinate on the road centerline where that mile marker sign would stand.

4. **Lookup:** At query time, a bounding-box pre-filter narrows candidates, then haversine sorts by actual distance from your location. The nearest N markers are returned.

**Example:** `41.5744, -87.0556` (I-80 near Gary, IN) → `Mile Marker 9 — I-80 (IN)` at 241 m.

---

## Coverage

| Network | Coverage |
|---|---|
| US Interstates (I-xx) | ✅ All 50 states |
| US Routes (US-xx) | ✅ All 50 states |
| State Routes (SR-xx) | ✅ Where in NHS |
| Territories (PR) | ✅ Included |
| Non-US locations | Overpass OSM fallback |

**307,600 mile markers** across 492,000 NHS road segments. Database: ~24 MB SQLite, loaded into memory at startup.

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

This downloads ~492k NHS segments from the BTS ArcGIS REST service using 10 parallel workers and interpolates all integer milepost positions. Takes ~15–20 minutes.

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
      "display_name": "Mile Marker 9 — I-80 (IN)",
      "distance_m": 241,
      "distance_display": "241 m",
      "lat": 41.57514,
      "lng": -87.05832
    },
    {
      "route": "SR-49",
      "state": "IN",
      "milepost": 22,
      "display_name": "Mile Marker 22 — SR-49 (IN)",
      "distance_m": 1052,
      "distance_display": "1052 m",
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
| `milepost` | Integer mile marker number |
| `display_name` | Ready-to-print string for Telegram/UI |
| `distance_m` | Straight-line distance in metres from your input |
| `source` | `ntad` (local SQLite) or `osm` (Overpass fallback for non-US) |

---

### Response — No Markers (Fallback)

When outside the US or on a road not in the NHS, the OSM Overpass fallback runs. If no milestones are mapped, nearby exits and roads are returned:

```json
{
  "results": [],
  "source": "none",
  "message": "No mile markers found on I-80/I-90 (Indiana Toll Road) near this location.",
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
      "display_name": "I-80/I-90 (Indiana Toll Road)"
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
│   └── milemarkers.db          # 307k mile markers, all US states (~24 MB)
├── scripts/
│   └── build-db.js             # One-time: NTAD NHS → SQLite generator
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
