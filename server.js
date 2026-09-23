require('dotenv').config();

const http = require('http');
const path = require('path');
const fs = require('fs');
const tmi = require('tmi.js');
const { WebSocketServer } = require('ws');

const PORT = numberSetting('PORT', 3000);
// Loopback-only by default: the overlay and Control Room are not exposed to
// anyone else on the local network.
const HOST = process.env.HOST || '127.0.0.1';
const CHANNEL = (process.env.TWITCH_CHANNEL || '').trim().replace(/^#/, '').toLowerCase();
const DEFAULT_COMBO_TIMEOUT_MS = numberSetting('COMBO_TIMEOUT_MS', 6500);
const DEFAULT_MIN_COMBO_COUNT = integerSetting('MIN_COMBO_COUNT', 2, 2, 999);
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const THEMES = new Set(['game', 'sakura', 'rainfall', 'inferno', 'luna', 'blizzard']);
const DEFAULT_SETTINGS = {
  theme: 'game',
  comboTimeoutMs: DEFAULT_COMBO_TIMEOUT_MS,
  minComboCount: DEFAULT_MIN_COMBO_COUNT
};
let overlaySettings = loadSettings();

if (!CHANNEL) {
  console.error('Missing TWITCH_CHANNEL. Copy .env.example to .env and set a channel name.');
  process.exit(1);
}

// Each normalized message has independent state. The browser receives only the
// latest qualifying event, which keeps this v1 overlay intentionally uncluttered.
const combos = new Map();
const thirdPartyEmotes = new Map();
let emotesRequestedForRoom = null;

const server = http.createServer((request, response) => {
  applySecurityHeaders(response);
  const requested = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (requested === '/api/settings') {
    if (request.method === 'GET') return sendJson(response, 200, overlaySettings);
    if (request.method === 'PUT') return updateSettings(request, response);
    return sendJson(response, 405, { error: 'Method not allowed' });
  }

  const fileName = requested === '/' ? 'overlay.html' : path.basename(requested);
  const allowedFiles = new Set(['overlay.html', 'settings.html']);

  if (!allowedFiles.has(fileName)) {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    return response.end('Not found');
  }

  const filePath = path.join(__dirname, fileName);
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(response);
});

const allowedOrigins = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`
]);

const wss = new WebSocketServer({
  server,
  path: '/ws',
  // A normal OBS/browser-source request includes one of the local origins.
  // Origin-less clients are permitted for compatibility with embedded sources.
  verifyClient: ({ origin }, done) => done(!origin || allowedOrigins.has(origin), 403, 'Local browser source only')
});

wss.on('connection', (socket) => {
  // Handy for checking that OBS is connected without exposing secrets.
  socket.send(JSON.stringify({ type: 'status', channel: CHANNEL }));
  socket.send(JSON.stringify({ type: 'settings', settings: overlaySettings }));
});

function broadcast(event) {
  const message = JSON.stringify(event);
  for (const socket of wss.clients) {
    if (socket.readyState === socket.OPEN) socket.send(message);
  }
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // Rename the original water theme without breaking an existing local choice.
    const theme = saved.theme === 'tsunami' ? 'rainfall' : saved.theme;
    return {
      theme: THEMES.has(theme) ? theme : DEFAULT_SETTINGS.theme,
      comboTimeoutMs: integerSettingFrom(saved.comboTimeoutMs, DEFAULT_SETTINGS.comboTimeoutMs, 1000, 60000),
      minComboCount: integerSettingFrom(saved.minComboCount, DEFAULT_SETTINGS.minComboCount, 2, 999)
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function updateSettings(request, response) {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10_000) request.destroy();
  });
  request.on('end', () => {
    try {
      const next = JSON.parse(body);
      if (!THEMES.has(next.theme)) return sendJson(response, 400, { error: 'Unknown theme' });
      const comboTimeoutMs = integerSettingFrom(next.comboTimeoutMs, NaN, 1000, 60000);
      const minComboCount = integerSettingFrom(next.minComboCount, NaN, 2, 999);
      if (!Number.isFinite(comboTimeoutMs) || !Number.isFinite(minComboCount)) {
        return sendJson(response, 400, { error: 'Timeout must be 1–60 seconds and minimum count must be 2–999' });
      }

      overlaySettings = { theme: next.theme, comboTimeoutMs, minComboCount };
      fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(overlaySettings, null, 2)}\n`);
      broadcast({ type: 'settings', settings: overlaySettings });
      sendJson(response, 200, overlaySettings);
    } catch {
      sendJson(response, 400, { error: 'Settings must be valid JSON' });
    }
  });
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function applySecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https://static-cdn.jtvnw.net https://cdn.betterttv.net https://cdn.7tv.app https://cdn.frankerfacez.com data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'"
  ].join('; '));
}

function normalizeMessage(message) {
  // Keep punctuation/emotes distinct; only case and leading/trailing whitespace
  // are deliberately ignored. Change this function to make matching looser.
  return message.trim().toLowerCase();
}

// Third-party emotes are fetched once per channel and cached in memory. A
// network/API failure simply leaves their chat text untouched; Twitch chat and
// native emotes continue to work normally.
async function loadThirdPartyEmotes(roomId) {
  if (emotesRequestedForRoom === roomId) return;
  emotesRequestedForRoom = roomId;

  const sources = await Promise.allSettled([
    fetchJson('https://api.betterttv.net/3/cached/fragments/global'),
    fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`),
    fetchJson('https://7tv.io/v3/emote-sets/global'),
    fetchJson(`https://7tv.io/v3/users/twitch/${roomId}`),
    fetchJson('https://api.frankerfacez.com/v1/set/global'),
    fetchJson(`https://api.frankerfacez.com/v1/room/id/${roomId}`)
  ]);

  const value = (index) => sources[index].status === 'fulfilled' ? sources[index].value : null;
  for (const emote of [...(value(0) || []), ...((value(1) || {}).channelEmotes || []), ...((value(1) || {}).sharedEmotes || [])]) {
    addThirdPartyEmote(emote.code, `https://cdn.betterttv.net/emote/${emote.id}/3x`);
  }
  for (const payload of [value(2), value(3)]) {
    for (const emote of payload?.emote_set?.emotes || payload?.emotes || []) {
      const file = emote.data?.host?.files?.find((item) => item.name === '2x.webp') || emote.data?.host?.files?.[0];
      if (file) addThirdPartyEmote(emote.name, `${emote.data.host.url}/${file.name}`);
    }
  }
  for (const payload of [value(4), value(5)]) {
    for (const set of Object.values(payload?.sets || {})) {
      for (const emote of set.emoticons || []) addThirdPartyEmote(emote.name, emote.urls?.['4'] || emote.urls?.['2'] || emote.urls?.['1']);
    }
  }
  console.log(`Loaded ${thirdPartyEmotes.size} third-party emotes for #${CHANNEL}`);
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function addThirdPartyEmote(name, url) {
  if (!name || !url) return;
  const normalizedUrl = url.startsWith('//') ? `https:${url}` : url;
  try {
    const host = new URL(normalizedUrl).hostname;
    if (['cdn.betterttv.net', 'cdn.7tv.app', 'cdn.frankerfacez.com'].includes(host)) thirdPartyEmotes.set(name, normalizedUrl);
  } catch {
    // Ignore malformed third-party API data.
  }
}

function findThirdPartyEmotes(message, nativeEmotes) {
  if (!thirdPartyEmotes.size) return [];
  const nativeRanges = Object.values(nativeEmotes).flat().map((position) => position.split('-').map(Number));
  const matches = [];
  for (const token of message.matchAll(/\S+/g)) {
    const start = token.index;
    const end = start + token[0].length - 1;
    if (nativeRanges.some(([from, to]) => start <= to && end >= from)) continue;
    const url = thirdPartyEmotes.get(token[0]);
    if (url) matches.push({ start, end, url });
  }
  return matches;
}

function onChatMessage(channel, tags, message, self) {
  if (self) return;

  const key = normalizeMessage(message);
  if (!key) return;

  const now = Date.now();
  const previous = combos.get(key);
  const isContinuing = previous && now - previous.lastSeen <= overlaySettings.comboTimeoutMs;
  const combo = isContinuing
    ? { ...previous, count: previous.count + 1, lastSeen: now }
    : { displayMessage: message.trim(), count: 1, lastSeen: now };

  combos.set(key, combo);

  const roomId = tags['room-id'];
  if (roomId) loadThirdPartyEmotes(roomId);

  if (combo.count >= overlaySettings.minComboCount) {
    broadcast({
      type: 'combo',
      message: combo.displayMessage,
      // Twitch supplies native emote IDs and character ranges in this tag.
      // The browser uses it to replace only those ranges with emote images.
      emotes: tags.emotes || {},
      thirdPartyEmotes: findThirdPartyEmotes(message, tags.emotes || {}),
      count: combo.count,
      timeoutMs: overlaySettings.comboTimeoutMs,
      user: tags['display-name'] || tags.username || 'viewer',
      timestamp: now
    });
  }
}

// Remove expired records so a busy chat cannot grow the in-memory map forever.
setInterval(() => {
  const cutoff = Date.now() - overlaySettings.comboTimeoutMs;
  for (const [key, combo] of combos) {
    if (combo.lastSeen < cutoff) combos.delete(key);
  }
}, 1000).unref();

const identity = process.env.TWITCH_BOT_USERNAME && process.env.TWITCH_OAUTH_TOKEN
  ? { username: process.env.TWITCH_BOT_USERNAME, password: process.env.TWITCH_OAUTH_TOKEN }
  : undefined;

const client = new tmi.Client({
  options: { debug: false },
  connection: { secure: true, reconnect: true },
  identity,
  channels: [CHANNEL]
});

client.on('message', onChatMessage);
client.on('connected', (address, port) => {
  console.log(`Connected to #${CHANNEL} chat via ${address}:${port}`);
});
client.on('disconnected', (reason) => console.warn(`Twitch chat disconnected: ${reason}`));
client.connect().catch((error) => console.error('Unable to connect to Twitch:', error.message));

server.listen(PORT, HOST, () => {
  console.log(`OBS overlay: http://localhost:${PORT}/overlay.html`);
  console.log(`Listening securely on ${HOST}:${PORT} | timeout: ${overlaySettings.comboTimeoutMs}ms`);
});

function numberSetting(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function integerSetting(name, fallback, minimum, maximum) {
  return integerSettingFrom(process.env[name], fallback, minimum, maximum);
}

function integerSettingFrom(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
