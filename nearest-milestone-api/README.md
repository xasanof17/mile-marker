# Nearest Mile Marker Search API

A Node.js/Express REST API that accepts flexible location inputs, resolves them to precise coordinates using **100% free and open-source tools**, and returns nearby highway milestone markers from OpenStreetMap — with smart fallbacks when OSM milestone data is sparse.

---

## Features

- **Three input types** — raw coordinates, human-readable addresses, or Google Plus Codes (full and compound)
- **Offline Plus Code decoding** — no API key, resolved on-server via `open-location-code`; compound codes (e.g. `PXRX+86 Valparaiso, IN`) automatically geocode the locality and recover the full code
- **Free geocoding** — address lookup via Nominatim (OpenStreetMap)
- **Milestone data** — sourced from Overpass API (OpenStreetMap)
- **TTL response cache** — Overpass results cached in memory for 5 minutes; identical coordinate lookups never hit the network twice
- **Smart highway binding** — when a milestone node lacks a `ref`, the closest highway Way is inspected and its route number is bound automatically
- **Exit marker fallback** — when no milestones exist, nearby `motorway_junction` exit nodes are returned instead
- **`display_name` on all results** — pre-formatted strings ready to print directly in a Telegram bot or UI
- **Directional heading** — add `?heading=E` (N/NE/E/SE/S/SW/W/NW) to append the travel direction to `display_name` and include a `direction` field, verified against the actual geometry of the closest highway way
- **Side-of-road** — when OSM tags a milestone with `side=left` or `side=right`, the result includes a `side` field and the shoulder label appears in `display_name`
- **Unit system** — add `?units=km` for European km-post highways; appends `km` to the marker value and reflects `units` in the precision block
- **Precision tiers** — inputs are classified as `high`/`medium`/`low` precision; low-precision inputs (zip codes, cities) automatically expand the search radius to 3000m
- **Road tier sorting** — mainline roads (`motorway`, `trunk`) always sort above ramps and links; add `?routing=practical` to enforce mainline-only ordering
- **GET + POST** — both HTTP methods supported on the same pipeline
- **Mirror failover** — automatically retries across 3 Overpass endpoints on 5xx errors
- **Rate limiting** — 15 requests/min per IP to respect Nominatim usage policy
- **Health check** — `GET /health` pings the Overpass API and returns `overpass: reachable/unreachable`
- **Docker-ready** — single `docker compose up` to run

---

## Data Coverage Note

This API uses [OpenStreetMap](https://www.openstreetmap.org) data via the Overpass API. OSM milestone coverage varies significantly by region:

- **Good coverage:** Major US Interstates, European motorways, some state highways
- **Sparse coverage:** Many secondary highways, toll roads, and rural routes

When a milestone sign physically exists but hasn't been mapped in OSM, the API returns nearby **exit markers** and **highway context** as a fallback — which is often just as useful for locating a driver. For verified, authoritative mile marker data on every US highway, see commercial services like [OnStarboard](https://onstarboardsolutions.com/map-overlay-api).

---

## Quick Start

### Local

```bash
cp .env.example .env   # Windows: Copy-Item .env.example .env
npm install
npm start
```

### Docker

```bash
Copy-Item .env.example .env   # or: cp .env.example .env
docker compose up
```

Server runs on `http://localhost:3000` (or `PORT` in `.env`).

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port |
| `NOMINATIM_COUNTRY_CODE` | No | *(unrestricted)* | ISO 3166-1 alpha-2 to restrict address geocoding (e.g. `us`, `de`). Leave blank for global. |

---

## API Reference

### `GET /health`

Returns `200` when Overpass is reachable, `503` when not.

```json
{ "status": "ok", "overpass": "reachable" }
```

```json
{ "status": "degraded", "overpass": "unreachable" }
```

---

### `POST /nearest-milestone` · `GET /nearest-milestone`

Find highway milestone markers near a location.

#### Query Parameters

| Parameter | Type | Default | Max | Description |
|---|---|---|---|---|
| `limit` | integer | `5` | `20` | Max results to return |
| `routing` | string | — | — | Set to `practical` to prioritize mainline motorways over ramps |
| `heading` | string | — | — | Travel direction: `N`, `NE`, `E`, `SE`, `S`, `SW`, `W`, `NW`. Appends directional label to `display_name` when the way geometry confirms the bearing |
| `units` | string | — | — | Set to `km` for kilometre-post highways; appends `km` to marker value and sets `precision.units` |

#### Request Body (POST) — `application/json`

```json
{ "location": "<see input types below>" }
```

#### GET equivalent

```
GET /nearest-milestone?location=38.8977,-77.0365&limit=3&routing=practical
```

---

### Input Types

Auto-detected in this order:

| Type | Example | Resolution | Precision |
|---|---|---|---|
| Coordinate object | `{ "lat": 38.8977, "lng": -77.0365 }` | Direct | `high` |
| Coordinate string | `"38.8977,-77.0365"` | Parsed | `high` |
| Full Plus Code | `"87G7PXRX+86"` | Offline decode | `high` |
| Compound Plus Code | `"PXRX+86 Valparaiso, IN"` | Locality geocoded, then offline recover | `high` |
| Street address | `"1600 Pennsylvania Ave NW, DC"` | Nominatim | `medium` |
| Zip code / city | `"46383"` or `"Valparaiso, IN"` | Nominatim | `low` → 3000m radius |

---

### Example Requests

```bash
# Coordinate string
curl -X POST http://localhost:3000/nearest-milestone \
  -H "Content-Type: application/json" \
  -d '{"location": "38.8977,-77.0365"}'

# Plus Code
curl -X POST http://localhost:3000/nearest-milestone \
  -H "Content-Type: application/json" \
  -d '{"location": "87G7PXRX+86"}'

# Address, practical routing, top 3
curl -X POST "http://localhost:3000/nearest-milestone?limit=3&routing=practical" \
  -H "Content-Type: application/json" \
  -d '{"location": "I-95 near Richmond, Virginia"}'

# GET equivalent
curl "http://localhost:3000/nearest-milestone?location=41.57442981,-87.05565565"

# Heading + side-of-road (eastbound on I-80)
curl "http://localhost:3000/nearest-milestone?location=41.57442981,-87.05565565&heading=E"

# Kilometre posts (European highways)
curl "http://localhost:3000/nearest-milestone?location=48.8566,2.3522&units=km"

# Compound Plus Code
curl -X POST http://localhost:3000/nearest-milestone \
  -H "Content-Type: application/json" \
  -d '{"location": "PXRX+86 Valparaiso, IN"}'
```

---

### Response — Milestones Found

```json
{
  "results": [
    {
      "osm_id": 123456789,
      "highway": "milestone",
      "name": "Interstate 95",
      "ref": "I-95",
      "marker": "104.2",
      "display_name": "Mile Marker 104.2 (Right Shoulder) — I-95 (Interstate 95) Northbound",
      "direction": "Northbound",
      "side": "right",
      "distance_m": 47,
      "lat": 37.5407,
      "lon": -77.4360
    }
  ],
  "precision": {
    "source_type": "coordinate",
    "precision_tier": "high",
    "radius_m": 1000,
    "units": "mi"
  }
}
```

| Field | Description |
|---|---|
| `osm_id` | OpenStreetMap node ID |
| `ref` | Route reference number (semicolons normalized to `/`, e.g. `I-80/I-90`) |
| `marker` | Mile/km marker value from `distance`, `pk`, or `ref` tag |
| `display_name` | Pre-formatted string — print directly in Telegram/UI |
| `direction` | *(optional)* Travel direction label when `?heading` matches way geometry |
| `side` | *(optional)* `left` or `right` shoulder from OSM `side` tag |
| `distance_m` | Straight-line distance in metres from your input |
| `precision.source_type` | How the input was resolved: `coordinate`, `plus_code`, `address` |
| `precision.precision_tier` | `high` / `medium` / `low` |
| `precision.radius_m` | Search radius actually used (1000m or 3000m) |
| `precision.units` | `mi` (default) or `km` when `?units=km` |

Results are sorted by distance ascending. With `?routing=practical`, mainline motorways sort above ramps.

---

### Response — No Milestones (Fallback)

When OSM has no milestone nodes but highway infrastructure exists nearby:

```json
{
  "results": [],
  "precision": { "source_type": "coordinate", "precision_tier": "high", "radius_m": 1000 },
  "message": "Highway found but no mapped milestones within search radius",
  "nearby_exits": [
    {
      "osm_id": 181205708,
      "exit": "31",
      "name": null,
      "display_name": "Exit 31 — I-80/I-90 (Indiana Toll Road)",
      "distance_m": 134,
      "lat": 41.5747645,
      "lon": -87.0572021
    }
  ],
  "nearby_highways": [
    {
      "osm_id": 4515518,
      "highway": "motorway",
      "name": "Indiana Toll Road",
      "ref": "I-80/I-90",
      "display_name": "I-80/I-90 (Indiana Toll Road)"
    },
    {
      "osm_id": 127678179,
      "highway": "trunk",
      "name": null,
      "ref": "SR 49",
      "display_name": "SR 49"
    }
  ]
}
```

- `nearby_exits` — deduplicated by exit number (opposing lanes collapsed to closest), sorted by distance
- `nearby_highways` — deduplicated by highway+ref+name, mainline roads first

---

### Error Responses

| HTTP | `code` | Cause |
|---|---|---|
| `400` | — | `location` field missing or empty |
| `422` | `GEOCODER_ERROR` | Address not found by Nominatim |
| `422` | `PLUS_CODE_ERROR` | Malformed or non-full Plus Code |
| `422` | `INVALID_COORDS` | Resolved coordinates out of valid range |
| `503` | `OVERPASS_TIMEOUT` | All Overpass mirrors timed out |
| `500` | `OVERPASS_ERROR` | Unexpected Overpass error |

```json
{ "error": "No results for: some place", "code": "GEOCODER_ERROR" }
```

---

## Architecture

```
POST/GET /nearest-milestone
         │
         ▼
 express-validator          ← 400 on missing/empty location
         │
         ▼
 express-rate-limit         ← 15 req/min per IP (Nominatim policy)
         │
         ▼
 normalizeLocation middleware
   ├── { lat, lng } object   → high precision
   ├── "lat,lng" string      → high precision
   ├── Full Plus Code        → offline decode, high precision
   ├── Compound Plus Code    → geocode locality + offline recover, high precision
   └── address string        → Nominatim, medium/low precision
         │
         ▼  req.coords = { lat, lng, source_type, precision_tier }
         │
         ▼
 milestone.controller
   ├── radius = precision_tier === 'low' ? 3000 : 1000
   ├── fetchNearby(lat, lng, radius)   [TTL-cached 5 min]
   │     └── Overpass API — tries 3 mirrors on 5xx
   ├── split: milestones / junctions / ways
   ├── sort ways by HIGHWAY_TIER (practical mode)
   ├── IF milestones found:
   │     bind closest way ref/name to orphan nodes
   │     apply ?heading → verify bearing → direction label
   │     apply tags.side → shoulder label
   │     apply ?units=km → suffix marker value
   │     sort by tier + distance → slice to limit
   └── IF no milestones:
         deduplicate exits (by exit number, keep closest)
         deduplicate highways (by highway+ref+name)
         return nearby_exits + nearby_highways
```

---

## Project Structure

```
nearest-milestone-api/
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── package.json
└── src/
    ├── app.js                        # Express setup, error handler
    ├── server.js                     # HTTP listener
    ├── routes/
    │   └── milestone.routes.js       # Validation, rate limit, GET+POST
    ├── middleware/
    │   └── normalizeLocation.js      # Input detection → req.coords + precision
    ├── controllers/
    │   └── milestone.controller.js   # Transform, display_name, tier sort
    └── services/
        ├── plusCode.js               # open-location-code CJS bridge
        ├── geocoder.js               # Nominatim client
        └── overpass.js               # Overpass client, mirror failover
```

---

## Data Sources & Attribution

| Service | URL | Cost | Notes |
|---|---|---|---|
| OpenStreetMap Overpass API | https://overpass-api.de | Free | OSM data © OpenStreetMap contributors |
| Nominatim Geocoding | https://nominatim.openstreetmap.org | Free | Max 1 req/sec per usage policy |
| open-location-code | npm (Google) | Free / offline | Zero network calls for Plus Code decoding |

Nominatim [usage policy](https://operations.osmfoundation.org/policies/nominatim/) requires a valid `User-Agent` and rate limiting — both enforced by this API.

For verified, authoritative mile marker tile overlays on all US highways, see [OnStarboard Map Overlay API](https://onstarboardsolutions.com/map-overlay-api) — a commercial service with curated data beyond what OSM currently covers.

---

## Development

```bash
npm run dev        # nodemon — auto-restarts on file changes
```
