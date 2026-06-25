import express from 'express';
import axios from 'axios';
import milestoneRouter from './routes/milestone.routes.js';

const app = express();
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await axios.get('https://overpass-api.de/api/status', { timeout: 4000 });
    res.json({ status: 'ok', overpass: 'reachable' });
  } catch {
    res.status(503).json({ status: 'degraded', overpass: 'unreachable' });
  }
});
app.use(milestoneRouter);

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
