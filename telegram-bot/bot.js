import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import http from 'http';

const { TELEGRAM_TOKEN, API_URL = 'http://localhost:3000', RENDER_EXTERNAL_URL } = process.env;
if (!TELEGRAM_TOKEN) { console.error('Missing TELEGRAM_TOKEN'); process.exit(1); }

const PORT = parseInt(process.env.PORT) || 3000;
const useWebhook = !!RENDER_EXTERNAL_URL;
const WEBHOOK_PATH = `/webhook`;
const webhookUrl = useWebhook ? `${RENDER_EXTERNAL_URL}${WEBHOOK_PATH}` : null;

console.log(`Starting bot… API_URL=${API_URL} mode=${useWebhook ? 'webhook' : 'polling'} PORT=${PORT}`);

// In webhook mode: no polling, we feed updates manually via processUpdate()
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: !useWebhook });

if (useWebhook) {
  // Register the webhook with Telegram
  bot.setWebHook(webhookUrl)
    .then(() => console.log(`Webhook registered: ${webhookUrl}`))
    .catch(err => console.error('setWebHook failed:', err.message));

  // Minimal HTTP server — receives Telegram POST updates
  http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          bot.processUpdate(JSON.parse(body));
        } catch (e) {
          console.error('processUpdate error:', e.message);
        }
        res.writeHead(200).end('ok');
      });
    } else {
      res.writeHead(200).end('ok');
    }
  }).listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));
}

bot.on('polling_error', (err) => console.error('Polling error:', err.message));
bot.on('error', (err) => console.error('Bot error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const LOCATION_KEYBOARD = {
  reply_markup: {
    keyboard: [[{ text: '📍 Share my location', request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

async function lookup(location, opts = {}) {
  const params = new URLSearchParams({ limit: 3, ...opts });
  const req = () => axios.post(
    `${API_URL}/nearest-milestone?${params}`,
    { location },
    { timeout: 35000 },
  );
  let resp;
  try {
    resp = await req();
  } catch (err) {
    const status = err.response?.status;
    if (err.code === 'ECONNABORTED' || status === 502 || status === 503) {
      resp = await req(); // one retry
    } else {
      throw err;
    }
  }
  const { data } = resp;

  if (!data.results?.length) {
    const exits = data.nearby_exits?.map(e => `  • ${e.display_name} (${e.distance_m}m)`).join('\n');
    const roads = data.nearby_highways?.map(r => `  • ${r.display_name}`).join('\n');
    let msg = `⚠️ ${data.message ?? 'No mile markers found nearby.'}`;
    if (exits) msg += `\n\n🚗 Nearby exits:\n${exits}`;
    if (roads) msg += `\n\n🛣 Nearby roads:\n${roads}`;
    return msg;
  }

  return data.results
    .map((r, i) => {
      let line = `${i + 1}. ${r.display_name}`;
      if (r.distance_m != null) line += ` *(${r.distance_m}m away)*`;
      return line;
    })
    .join('\n');
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 *Nearest Mile Marker Bot*\n\nSend me your location or type an address/coordinates and I'll find the closest highway mile marker.\n\nExamples:\n• \`41.5744,-87.0556\`\n• \`I-80 near Gary, Indiana\`\n• \`87G7PXRX+86\``,
    { parse_mode: 'Markdown', ...LOCATION_KEYBOARD },
  );
});

bot.on('location', async (msg) => {
  const { latitude: lat, longitude: lng } = msg.location;
  const thinking = await bot.sendMessage(msg.chat.id, '🔍 Looking up…');
  try {
    const text = await lookup({ lat, lng });
    await bot.editMessageText(`📍 *Results near you:*\n\n${text}`, {
      chat_id: msg.chat.id, message_id: thinking.message_id, parse_mode: 'Markdown',
    });
  } catch (err) {
    await bot.editMessageText(`❌ ${err.response?.data?.error ?? err.message}`, {
      chat_id: msg.chat.id, message_id: thinking.message_id,
    });
  }
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const thinking = await bot.sendMessage(msg.chat.id, '🔍 Looking up…');
  try {
    const text = await lookup(msg.text);
    await bot.editMessageText(`📍 *Results:*\n\n${text}`, {
      chat_id: msg.chat.id, message_id: thinking.message_id, parse_mode: 'Markdown',
    });
  } catch (err) {
    await bot.editMessageText(`❌ ${err.response?.data?.error ?? err.message}`, {
      chat_id: msg.chat.id, message_id: thinking.message_id,
    });
  }
});

console.log('Bot running…');
