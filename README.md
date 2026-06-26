# Mile Marker

A monorepo with two services that together let you find the nearest highway mile marker for any US location.

| Service | Description | Deployed |
|---|---|---|
| `nearest-milestone-api` | REST API — coordinate/address/Plus Code → nearest mile markers | [nearest-milestone-api.onrender.com](https://nearest-milestone-api.onrender.com) |
| `telegram-bot` | Telegram bot frontend for the API | [@NearestMilestoneBot](https://t.me/NearestMilestoneBot) |

---

## How It Works

Mile marker data comes from the **NTAD National Highway System** (Federal Highway Administration via BTS) — 307,600 interpolated milepost positions across all US interstates, US routes, and state routes in all 50 states, stored in a local SQLite database. For non-US locations the API falls back to OpenStreetMap Overpass.

The Telegram bot runs in webhook mode and stays awake 24/7. The API is a standard web service behind rate limiting.

---

## Repo Structure

```
mile-marker/
├── nearest-milestone-api/   # Express REST API
├── telegram-bot/            # Telegram bot
├── render.yaml              # Render deploy config (both services)
└── docker-compose.yml       # Local dev (both services)
```

See each subdirectory for its own README and setup instructions.

---

## Local Dev (both services)

```bash
cp nearest-milestone-api/.env.example nearest-milestone-api/.env
cp telegram-bot/.env.example telegram-bot/.env
# edit both .env files, then:
docker compose up
```

---

## Deploy

Both services are configured in `render.yaml` and auto-deploy from the `master` branch on Render. Environment variables (`TELEGRAM_TOKEN`, `API_URL`) are set in the Render dashboard.
