import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import http from 'http';

const { TELEGRAM_TOKEN, API_URL = 'http://localhost:3000' } = process.env;
if (!TELEGRAM_TOKEN) { console.error('Missing TELEGRAM_TOKEN'); process.exit(1); }

// Minimal HTTP server so Render web service health checks pass
const PORT = process.env.PORT || 3000;
http.createServer((_req, res) => res.end('ok')).listen(PORT);

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const LOCATION_KEYBOARD = {
  reply_markup: {
    keyboard: [[{ text: '📍 Share my location', request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
};

/** Call the REST API and return a formatted string. */
async function lookup(location, opts = {}) {
  const params = new URLSearchParams({ limit: 3, ...opts });
  const { data } = await axios.post(
    `${API_URL}/nearest-milestone?${params}`,
    { location },
    { timeout: 15000 },
  );

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

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 *Nearest Mile Marker Bot*\n\nSend me your location or type an address/coordinates and I'll find the closest highway mile marker.\n\nExamples:\n• \`41.5744,-87.0556\`\n• \`I-80 near Gary, Indiana\`\n• \`87G7PXRX+86\``,
    { parse_mode: 'Markdown', ...LOCATION_KEYBOARD },
  );
});

// Location share
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

// Free text: address, coordinates, Plus Code
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
