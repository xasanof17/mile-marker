import app from './app.js';

const raw = process.env.PORT;
const PORT = (raw && /^\d+$/.test(raw)) ? parseInt(raw) : 3000;
app.listen(PORT, () => console.log(`nearest-milestone-api listening on :${PORT}`));
