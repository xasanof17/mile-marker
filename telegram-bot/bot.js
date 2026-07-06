import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import http from 'http';

const { TELEGRAM_TOKEN, API_URL = 'http://localhost:3000', RENDER_EXTERNAL_URL, USE_WEBHOOK } = process.env;
if (!TELEGRAM_TOKEN) { console.error('[FATAL] Missing TELEGRAM_TOKEN'); process.exit(1); }

const PORT = parseInt(process.env.PORT) || 3000;
const useWebhook = USE_WEBHOOK === 'true';
const webhookUrl = useWebhook ? `${RENDER_EXTERNAL_URL}/webhook` : null;

// ── Structured logger ─────────────────────────────────────────────────────────
// All log lines are prefixed with ISO timestamp + level so Render log viewer
// (and any log aggregator) can filter/search by level, user, or query.

function log(level, msg, meta = {}) {
  const metaStr = Object.keys(meta).length
    ? ' ' + Object.entries(meta).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    : '';
  console.log(`${new Date().toISOString()} [${level}] ${msg}${metaStr}`);
}

const info  = (msg, meta) => log('INFO ', msg, meta);
const warn  = (msg, meta) => log('WARN ', msg, meta);
const error = (msg, meta) => log('ERROR', msg, meta);

// ── Startup ───────────────────────────────────────────────────────────────────

info('Bot starting', { mode: useWebhook ? 'webhook' : 'polling', api: API_URL, port: PORT });

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: !useWebhook });

if (useWebhook) {
  bot.setWebHook(webhookUrl)
    .then(() => info('Webhook registered', { url: webhookUrl }))
    .catch(err => error('setWebHook failed', { err: err.message }));

  http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try { bot.processUpdate(JSON.parse(body)); }
        catch (e) { error('processUpdate failed', { err: e.message }); }
        res.writeHead(200).end('ok');
      });
    } else {
      res.writeHead(200).end('ok');
    }
  }).listen(PORT, () => info('HTTP server listening', { port: PORT }));
} else {
  // Polling mode: start a minimal health server so Render doesn't kill the process
  http.createServer((_req, res) => res.writeHead(200).end('ok'))
    .listen(PORT, () => info('Health server listening', { port: PORT }));
}

bot.on('polling_error', err => error('Polling error', { err: err.message }));
bot.on('error',         err => error('Bot error',     { err: err.message }));
process.on('unhandledRejection', err => error('Unhandled rejection', { err: String(err) }));

// ── API lookup ────────────────────────────────────────────────────────────────

const LOCATION_KEYBOARD = {
  reply_markup: {
    keyboard: [[{ text: '📍 Share my location', request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

const COOLDOWN_MS = 3000;
const lastRequestAt = new Map();
const TELEGRAM_MAX_MESSAGE = 4096;

function userKey(msg) {
  return msg.from?.id ?? msg.chat?.id ?? msg.chat.id;
}

function isFlooding(msg) {
  const key = userKey(msg);
  if (!key) return false;
  const last = lastRequestAt.get(key) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) return true;
  lastRequestAt.set(key, Date.now());
  return false;
}

function splitText(text, maxLen = TELEGRAM_MAX_MESSAGE) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let buffer = '';

  for (const line of text.split('\n')) {
    if (buffer.length + line.length + 1 > maxLen) {
      if (buffer) {
        parts.push(buffer);
        buffer = '';
      }
      if (line.length > maxLen) {
        let chunk = '';
        for (const word of line.split(' ')) {
          if (chunk.length + word.length + 1 > maxLen) {
            if (chunk) parts.push(chunk);
            chunk = word;
          } else {
            chunk += (chunk ? ' ' : '') + word;
          }
        }
        if (chunk) parts.push(chunk);
      } else {
        buffer = line;
      }
    } else {
      buffer += (buffer ? '\n' : '') + line;
    }
  }

  if (buffer) parts.push(buffer);
  return parts;
}

async function sendText(chatId, message, opts = {}) {
  const parts = splitText(message);
  const [first, ...rest] = parts;
  await bot.editMessageText(first, opts);
  for (const part of rest) {
    await bot.sendMessage(chatId, part, { parse_mode: 'Markdown' });
  }
}

function formatCoordinates(current_location) {
  if (current_location?.lat == null || current_location?.lng == null) return '';
  const { lat, lng } = current_location;
  return `\n*Resolved coordinates:* \`${lat.toFixed(6)},${lng.toFixed(6)}\``;
}

function formatHeading(heading) {
  return heading ? `\n*Direction:* ${heading}` : '';
}

function formatNearby(data) {
  const exits = data.nearby_exits?.slice(0, 3).map(e => `  • ${e.display_name} (${(e.distance_m / 1609.344).toFixed(2)} mi)`).join('\n');
  const roads = data.nearby_highways
    ?.filter(r => r.highway === 'motorway' || r.highway === 'trunk')
    .slice(0, 5)
    .map(r => {
      const suffix = r.direction_label ? ` — ${r.direction_label}` : '';
      return `  • ${r.display_name}${suffix}`;
    }).join('\n');
  let extra = '';
  if (exits) extra += `

🚗 Nearby exits:
${exits}`;
  if (roads) extra += `

🛣 Nearby roads:
${roads}`;
  return extra;
}

function formatResults(data) {
  if (!data.results?.length) {
    let text = '';
    text += formatCoordinates(data.current_location);
    text += formatHeading(data.heading);
    text += `\n\n⚠️ *${data.message ?? 'No mile markers found nearby.'}*`;
    text += formatNearby(data);
    return text;
  }

  let text = '';
  text += formatCoordinates(data.current_location);
  text += formatHeading(data.heading);
  text += '\n\n*Nearest mile markers:*\n';
  text += data.results
    .map((r, i) => {
      const dist = r.distance_display ?? (r.distance_m != null ? `${(r.distance_m / 1609.344).toFixed(2)} mi` : 'distance unknown');
      const direction = r.direction_label ? ` — ${r.direction_label}` : '';
      const coords = (r.lat != null && r.lng != null)
        ? `\n    _Marker coords:_ \`${r.lat.toFixed(6)},${r.lng.toFixed(6)}\``
        : '';
      return `*${i + 1}.* ${r.display_name} *(${dist})*${direction}${coords}`;
    })
    .join('\n');
  text += formatNearby(data);
  return text;
}

// ── Keep-alive pinger (prevents Render free-tier spin-down) ──────────────────
const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
setInterval(async () => {
  try {
    await axios.get(`${API_URL}/health`, { timeout: 10000 });
    info('Keep-alive ping OK');
  } catch (err) {
    warn('Keep-alive ping failed', { err: err.message });
  }
}, PING_INTERVAL_MS);

async function lookup(location, chatId) {
  const params = new URLSearchParams({ limit: 3 });
  const req = () => axios.post(
    `${API_URL}/nearest-milestone?${params}`,
    { location },
    { timeout: 35000 },
  );

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const t0 = Date.now();
  let resp;
  try {
    resp = await req();
  } catch (err) {
    const status = err.response?.status;
    if (err.code === 'ECONNABORTED' || status === 502 || status === 503) {
      warn('API request failed, retrying after delay', { chatId, status: status ?? err.code });
      await sleep(8000); // wait for cold-start to finish
      resp = await req();
    } else {
      throw err;
    }
  }

  const ms = Date.now() - t0;
  const { data } = resp;
  const source = data.source ?? 'unknown';

  if (!data.results?.length) {
    warn('No mile markers found', { chatId, source, ms, location: JSON.stringify(location).slice(0, 60) });
  } else {
    info('Markers returned', {
      chatId,
      source,
      ms,
      count: data.results.length,
      top: data.results[0]?.display_name,
    });
  }

  return formatResults(data);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, msg => {
  info('/start', { chatId: msg.chat.id, user: msg.from?.username });
  bot.sendMessage(
    msg.chat.id,
    `👋 *Nearest Mile Marker Bot*\n\nSend me your location or type an address/coordinates and I'll find the closest highway mile marker.\n\nExamples:\n• \`41.5744,-87.0556\`\n• \`I-80 near Gary, Indiana\`\n• \`87G7PXRX+86\``,
    { parse_mode: 'Markdown', ...LOCATION_KEYBOARD },
  );
});

bot.on('location', async msg => {
  if (isFlooding(msg)) {
    return bot.sendMessage(msg.chat.id, '⏳ Please wait a few seconds before sending another request.');
  }

  const { latitude: lat, longitude: lng } = msg.location;
  info('Location received', { chatId: msg.chat.id, lat, lng });
  const thinking = await bot.sendMessage(msg.chat.id, '🔍 Looking up…');
  try {
    const text = await lookup({ lat, lng }, msg.chat.id);
    await sendText(msg.chat.id, `📍 *Results near you:*\n\n${text}`, {
      chat_id: msg.chat.id,
      message_id: thinking.message_id,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    error('Location lookup failed', { chatId: msg.chat.id, err: err.message });
    await bot.editMessageText(`❌ ${err.response?.data?.error ?? err.message}`, {
      chat_id: msg.chat.id, message_id: thinking.message_id,
    });
  }
});

bot.on('message', async msg => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (isFlooding(msg)) {
    return bot.sendMessage(msg.chat.id, '⏳ Please wait a few seconds before sending another request.');
  }

  info('Text query', { chatId: msg.chat.id, query: msg.text.slice(0, 80) });
  const thinking = await bot.sendMessage(msg.chat.id, '🔍 Looking up…');
  try {
    const text = await lookup(msg.text, msg.chat.id);
    await sendText(msg.chat.id, `📍 *Results:*\n\n${text}`, {
      chat_id: msg.chat.id, message_id: thinking.message_id, parse_mode: 'Markdown',
    });
  } catch (err) {
    error('Text lookup failed', { chatId: msg.chat.id, query: msg.text.slice(0, 80), err: err.message });
    await bot.editMessageText(`❌ ${err.response?.data?.error ?? err.message}`, {
      chat_id: msg.chat.id, message_id: thinking.message_id,
    });
  }
});

info('Bot running');
