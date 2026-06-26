import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import http from 'http';

const { TELEGRAM_TOKEN, API_URL = 'http://localhost:3000', RENDER_EXTERNAL_URL } = process.env;
if (!TELEGRAM_TOKEN) { console.error('[FATAL] Missing TELEGRAM_TOKEN'); process.exit(1); }

const PORT = parseInt(process.env.PORT) || 3000;
const useWebhook = !!RENDER_EXTERNAL_URL;
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

async function lookup(location, chatId) {
  const params = new URLSearchParams({ limit: 3 });
  const req = () => axios.post(
    `${API_URL}/nearest-milestone?${params}`,
    { location },
    { timeout: 35000 },
  );

  const t0 = Date.now();
  let resp;
  try {
    resp = await req();
  } catch (err) {
    const status = err.response?.status;
    // Retry once on timeout / cold-start 502-503
    if (err.code === 'ECONNABORTED' || status === 502 || status === 503) {
      warn('API request failed, retrying', { chatId, status: status ?? err.code });
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
    const exits = data.nearby_exits?.map(e => `  • ${e.display_name} (${e.distance_m}m)`).join('\n');
    const roads = data.nearby_highways?.map(r => `  • ${r.display_name}`).join('\n');
    let msg = `⚠️ ${data.message ?? 'No mile markers found nearby.'}`;
    if (exits) msg += `\n\n🚗 Nearby exits:\n${exits}`;
    if (roads) msg += `\n\n🛣 Nearby roads:\n${roads}`;
    return msg;
  }

  info('Markers returned', {
    chatId,
    source,
    ms,
    count: data.results.length,
    top: data.results[0]?.display_name,
  });

  return data.results
    .map((r, i) => `${i + 1}. ${r.display_name} *(${r.distance_m}m away)*`)
    .join('\n');
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
  const { latitude: lat, longitude: lng } = msg.location;
  info('Location received', { chatId: msg.chat.id, lat, lng });
  const thinking = await bot.sendMessage(msg.chat.id, '🔍 Looking up…');
  try {
    const text = await lookup({ lat, lng }, msg.chat.id);
    await bot.editMessageText(`📍 *Results near you:*\n\n${text}`, {
      chat_id: msg.chat.id, message_id: thinking.message_id, parse_mode: 'Markdown',
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
  info('Text query', { chatId: msg.chat.id, query: msg.text.slice(0, 80) });
  const thinking = await bot.sendMessage(msg.chat.id, '🔍 Looking up…');
  try {
    const text = await lookup(msg.text, msg.chat.id);
    await bot.editMessageText(`📍 *Results:*\n\n${text}`, {
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
