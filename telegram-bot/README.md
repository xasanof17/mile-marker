# Nearest Mile Marker Bot

Telegram bot frontend for the [nearest-milestone-api](../nearest-milestone-api). Send a location, coordinates, address, or Plus Code and get the closest highway mile markers back.

Live: [@NearestMilestoneBot](https://t.me/NearestMilestoneBot)

---

## Usage

| Input | Example |
|---|---|
| Share location | Tap 📍 Share my location |
| Coordinates | `41.5744,-87.0556` |
| Address | `I-80 near Gary, Indiana` |
| Full Plus Code | `87G7PXRX+86` |
| Compound Plus Code | `PXRX+86 Valparaiso, IN` |

The bot replies with the nearest mile markers, travel direction, and nearby exits/roads.

---

## Local Setup

```bash
cp .env.example .env
# fill in TELEGRAM_TOKEN and API_URL
npm install
npm start
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_TOKEN` | ✅ | BotFather token |
| `API_URL` | ✅ | Base URL of nearest-milestone-api (e.g. `http://localhost:3000`) |
| `USE_WEBHOOK` | No | Set to `true` to enable webhook mode (requires `RENDER_EXTERNAL_URL` to also be set) |
| `PORT` | No | HTTP port (default `3000`; only used in webhook mode) |

By default the bot runs in **polling mode** (no HTTP server needed). Set `USE_WEBHOOK=true` only if you need webhook mode.

---

## Deploy

The bot is configured as a Render **web service** in `../render.yaml`. Set `TELEGRAM_TOKEN` and `API_URL` in the Render dashboard. The bot runs in polling mode by default, pinging the API every 10 minutes to keep it warm.
