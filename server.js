require('dotenv').config();

const http = require('http');
const path = require('path');
const fs = require('fs');
const tmi = require('tmi.js');
const { WebSocketServer } = require('ws');

const PORT = numberSetting('PORT', 3000);
const CHANNEL = (process.env.TWITCH_CHANNEL || '').trim().replace(/^#/, '').toLowerCase();
const COMBO_TIMEOUT_MS = numberSetting('COMBO_TIMEOUT_MS', 6500);
const MIN_COMBO_COUNT = numberSetting('MIN_COMBO_COUNT', 2);
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const THEMES = new Set(['game', 'sakura', 'tsunami', 'inferno', 'luna']);
let overlaySettings = loadSettings();

if (!CHANNEL) {
  console.error('Missing TWITCH_CHANNEL. Copy .env.example to .env and set a channel name.');
  process.exit(1);
}

// Each normalized message has independent state. The browser receives only the
// latest qualifying event, which keeps this v1 overlay intentionally uncluttered.
const combos = new Map();

const server = http.createServer((request, response) => {
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

const wss = new WebSocketServer({ server, path: '/ws' });

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
    return THEMES.has(saved.theme) ? { theme: saved.theme } : { theme: 'game' };
  } catch {
    return { theme: 'game' };
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

      overlaySettings = { theme: next.theme };
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

function normalizeMessage(message) {
  // Keep punctuation/emotes distinct; only case and leading/trailing whitespace
  // are deliberately ignored. Change this function to make matching looser.
  return message.trim().toLowerCase();
}

function onChatMessage(channel, tags, message, self) {
  if (self) return;

  const key = normalizeMessage(message);
  if (!key) return;

  const now = Date.now();
  const previous = combos.get(key);
  const isContinuing = previous && now - previous.lastSeen <= COMBO_TIMEOUT_MS;
  const combo = isContinuing
    ? { ...previous, count: previous.count + 1, lastSeen: now }
    : { displayMessage: message.trim(), count: 1, lastSeen: now };

  combos.set(key, combo);

  if (combo.count >= MIN_COMBO_COUNT) {
    broadcast({
      type: 'combo',
      message: combo.displayMessage,
      // Twitch supplies native emote IDs and character ranges in this tag.
      // The browser uses it to replace only those ranges with emote images.
      emotes: tags.emotes || {},
      count: combo.count,
      timeoutMs: COMBO_TIMEOUT_MS,
      user: tags['display-name'] || tags.username || 'viewer',
      timestamp: now
    });
  }
}

// Remove expired records so a busy chat cannot grow the in-memory map forever.
setInterval(() => {
  const cutoff = Date.now() - COMBO_TIMEOUT_MS;
  for (const [key, combo] of combos) {
    if (combo.lastSeen < cutoff) combos.delete(key);
  }
}, Math.max(1000, Math.min(COMBO_TIMEOUT_MS, 5000))).unref();

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

server.listen(PORT, () => {
  console.log(`OBS overlay: http://localhost:${PORT}/overlay.html`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws | timeout: ${COMBO_TIMEOUT_MS}ms`);
});

function numberSetting(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
