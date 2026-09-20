const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);

// Origin(ler) whitelist: varsayılan olarak sadece kendi host'unuza izin verilir.
// Farklı bir alan adından erişim gerekiyorsa ALLOWED_ORIGINS ortam değişkenine
// virgülle ayrılmış origin listesi verin (örn: "https://ornek.com,https://www.ornek.com").
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const ROOM_TTL_MS = 48 * 60 * 60 * 1000; // 48 saat sonra boş kalan odalar silinir
const roomsFile = path.join(__dirname, 'rooms.json');

// ---- Oda verisi: bellekte tutulur, periyodik olarak diske yazılır ----
const rooms = new Map();
let dirty = false;

function loadRooms() {
  if (!fs.existsSync(roomsFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(roomsFile, 'utf8'));
    for (const [id, state] of Object.entries(data)) rooms.set(id, state);
  } catch (err) {
    console.error('rooms.json okunamadı, boş başlanıyor:', err.message);
  }
}
function saveRoomsNow() {
  const obj = Object.fromEntries(rooms);
  const tmp = roomsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, roomsFile);
  dirty = false;
}
function markDirty() { dirty = true; }
setInterval(() => { if (dirty) try { saveRoomsNow(); } catch (err) { console.error('rooms.json yazılamadı:', err.message); } }, 3000);
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, state] of rooms) if (now - (state.createdAt || 0) > ROOM_TTL_MS) { rooms.delete(id); changed = true; }
  if (changed) markDirty();
}, 30 * 60 * 1000);
loadRooms();

const allowed = new Map([['/', 'index.html'], ['/app.js', 'app.js']]);
const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  const name = allowed.get(route);
  if (!name) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  fs.createReadStream(path.join(__dirname, name)).pipe(res);
});

// ---- Basit rate limiting yardımcıları ----
// IP başına oda oluşturma: belirli bir sürede sınırlı sayıda "create" isteği.
const CREATE_LIMIT = 8, CREATE_WINDOW_MS = 10 * 60 * 1000;
const createHits = new Map(); // ip -> [timestamps]
function allowCreate(ip) {
  const now = Date.now();
  const hits = (createHits.get(ip) || []).filter(t => now - t < CREATE_WINDOW_MS);
  if (hits.length >= CREATE_LIMIT) { createHits.set(ip, hits); return false; }
  hits.push(now); createHits.set(ip, hits); return true;
}
// Bağlantı başına mesaj hızı: saniyede belirli sayıdan fazla mesaj sessizce yok sayılır.
const MSG_LIMIT_PER_SEC = 40;
function allowMessage(meta) {
  const now = Date.now();
  if (now - meta.msgWindowStart > 1000) { meta.msgWindowStart = now; meta.msgCount = 0; }
  meta.msgCount++;
  return meta.msgCount <= MSG_LIMIT_PER_SEC;
}

const peers = new Set();
const clients = new Map();
const locks = new Map();

function send(ws, data) {
  if (ws.destroyed || ws.writableEnded) return;
  const payload = Buffer.from(JSON.stringify(data));
  const head = payload.length < 126 ? Buffer.from([129, payload.length])
    : payload.length < 65536 ? Buffer.from([129, 126, payload.length >> 8, payload.length & 255])
    : Buffer.from([129, 127, 0, 0, 0, 0, payload.length >>> 24, (payload.length >>> 16) & 255, (payload.length >>> 8) & 255, payload.length & 255]);
  ws.write(Buffer.concat([head, payload]));
}
function broadcast(room, data, except) {
  for (const ws of peers) if (clients.get(ws)?.room === room && ws !== except) send(ws, data);
}
function validId(id) { return typeof id === 'string' && /^[a-z0-9-]{6,48}$/.test(id); }
function cleanPos(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: Math.max(-200, Math.min(3000, p.x)), y: Math.max(-200, Math.min(3000, p.y)), done: !!p.done };
}

function onMessage(ws, raw) {
  const meta = clients.get(ws) || {};
  if (meta.rateMeta && !allowMessage(meta.rateMeta)) return; // hız sınırını aşan mesajları sessizce at

  let m; try { m = JSON.parse(raw); } catch { return; }

  if (m.type === 'join') {
    if (!validId(m.room) || typeof m.name !== 'string') return send(ws, { type: 'error', message: 'Geçersiz oda.' });
    clients.set(ws, { room: m.room, name: m.name.slice(0, 30) || 'Misafir', ip: meta.ip, rateMeta: meta.rateMeta || { msgWindowStart: Date.now(), msgCount: 0 } });
    send(ws, { type: 'state', state: rooms.get(m.room) || null });
    broadcast(m.room, { type: 'presence', name: clients.get(ws).name, joined: true }, ws);
    return;
  }

  const client = clients.get(ws);
  if (!client || m.room !== client.room) return;

  if (m.type === 'create') {
    if (rooms.has(client.room)) return send(ws, { type: 'state', state: rooms.get(client.room) });
    if (!allowCreate(client.ip)) return send(ws, { type: 'error', message: 'Çok fazla oda oluşturuldu, biraz sonra tekrar deneyin.' });
    const validImage = typeof m.image === 'string' && (/^data:image\/(jpeg|png|webp);base64,/.test(m.image) || /^https:\/\/images\.unsplash\.com\//.test(m.image));
    if (![5, 8, 10].includes(m.grid) || !validImage || m.image.length > 7_000_000) return send(ws, { type: 'error', message: 'Resim veya seviye geçersiz.' });
    const state = { grid: m.grid, image: m.image, seed: Number(m.seed) >>> 0, positions: {}, finish: String(m.finish || '').slice(0, 100), createdAt: Date.now() };
    rooms.set(client.room, state);
    markDirty();
    broadcast(client.room, { type: 'state', state });
    return;
  }

  const state = rooms.get(client.room);
  if (!state || !Number.isInteger(m.id) || m.id < 0 || m.id >= state.grid ** 2) return;
  const key = client.room + ':' + m.id;

  if (m.type === 'lock') {
    const old = locks.get(key);
    if (old && old.ws !== ws && old.until > Date.now()) return send(ws, { type: 'denied', id: m.id });
    locks.set(key, { ws, until: Date.now() + 5000 });
    broadcast(client.room, { type: 'lock', id: m.id, name: client.name }, ws);
  }
  if (m.type === 'move') {
    const lock = locks.get(key), pos = cleanPos(m.pos);
    if (!pos || !lock || lock.ws !== ws || lock.until < Date.now() || state.positions[m.id]?.done) return;
    lock.until = Date.now() + 5000;
    state.positions[m.id] = pos;
    markDirty();
    broadcast(client.room, { type: 'move', id: m.id, pos }, ws);
    if (pos.done) { locks.delete(key); broadcast(client.room, { type: 'unlock', id: m.id }); }
  }
  if (m.type === 'unlock' && locks.get(key)?.ws === ws) {
    locks.delete(key); broadcast(client.room, { type: 'unlock', id: m.id }, ws);
  }
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // tarayıcı-dışı araçlar (curl vb.) origin göndermez; WS istemcileri her zaman gönderir
  try {
    const o = new URL(origin);
    const host = req.headers.host;
    if (host && (o.host === host)) return true; // aynı origin (kendi sitemiz)
    return EXTRA_ORIGINS.includes(origin);
  } catch { return false; }
}

server.on('upgrade', (req, ws) => {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') return ws.destroy();
  if (!originAllowed(req)) return ws.destroy(); // farklı bir sitenin bu soket'e bağlanmasını engelle

  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  ws.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  peers.add(ws);
  clients.set(ws, { ip: req.socket.remoteAddress, rateMeta: { msgWindowStart: Date.now(), msgCount: 0 } });
  let buffer = Buffer.alloc(0);
  ws.on('error', () => {});
  ws.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 8 * 1024 * 1024) return ws.destroy();
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15, masked = !!(buffer[1] & 128);
      let len = buffer[1] & 127, offset = 2;
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
      if (len === 127) { if (buffer.length < 10) return; const big = buffer.readBigUInt64BE(2); if (big > 8_000_000n) return ws.destroy(); len = Number(big); offset = 10; }
      if (!masked) return ws.destroy();
      if (buffer.length < offset + 4 + len) return;
      const mask = buffer.subarray(offset, offset + 4), payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + 4 + len);
      if (opcode === 8) return ws.end();
      if (opcode === 1) onMessage(ws, payload.toString('utf8'));
    }
  });
  ws.on('close', () => {
    const client = clients.get(ws);
    if (client?.room) broadcast(client.room, { type: 'presence', name: client.name, joined: false }, ws);
    clients.delete(ws);
    peers.delete(ws);
    for (const [key, lock] of locks) if (lock.ws === ws) { locks.delete(key); if (client) broadcast(client.room, { type: 'unlock', id: Number(key.split(':').pop()) }); }
  });
});

process.on('SIGINT', () => { try { saveRoomsNow(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { saveRoomsNow(); } catch {} process.exit(0); });

server.listen(PORT, () => console.log(`Puzzle: http://localhost:${PORT}`));
