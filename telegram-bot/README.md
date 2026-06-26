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
| `RENDER_EXTERNAL_URL` | No | Set automatically by Render — enables webhook mode |
| `PORT` | No | HTTP port (default `3000`; Render injects this) |

When `RENDER_EXTERNAL_URL` is set the bot registers a Telegram webhook and runs an HTTP server to receive updates. Without it, polling mode is used (local dev).

---

## Deploy

The bot is configured as a Render **web service** in `../render.yaml`. Set `TELEGRAM_TOKEN` and `API_URL` in the Render dashboard environment variables.

```
Render service type: web service (not worker) — required so Telegram can reach the webhook endpoint
```
