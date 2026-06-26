import express from 'express';
import axios from 'axios';
import milestoneRouter from './routes/milestone.routes.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
  axios.get('https://overpass-api.de/api/status', { timeout: 4000 })
    .then(() => console.log('overpass: reachable'))
    .catch(() => console.warn('overpass: unreachable'));
});
app.use(milestoneRouter);

// Keep the bot's web service alive (cross-ping so neither idles)
if (process.env.BOT_URL) {
  setInterval(() => {
    axios.get(process.env.BOT_URL, { timeout: 10000 })
      .then(() => console.log('bot ping: ok'))
      .catch(err => console.warn('bot ping failed:', err.message));
  }, 10 * 60 * 1000);
}

// Central error handler
app.use((err, _req, res, _next) => {
  const status = {
    GEOCODER_ERROR: 422,
    INVALID_COORDS: 422,
    OVERPASS_TIMEOUT: 503,
    PLUS_CODE_ERROR: 422,
  }[err.code] ?? 500;

  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(err.code && { code: err.code }),
  });
});

export default app;
