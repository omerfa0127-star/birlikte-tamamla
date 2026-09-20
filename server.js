const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const clients = new Map();
const locks = new Map();
const users = new Map();
const sessions = new Map();
const accountsFile = path.join(__dirname, 'accounts.json');
if (fs.existsSync(accountsFile)) for (const user of JSON.parse(fs.readFileSync(accountsFile, 'utf8'))) users.set(user.email, user);
function currentUser(req) { const token = /(?:^|; )puzzle_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1]; return sessions.get(token) || null; }
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
function readBody(req) { return new Promise((resolve, reject) => { let body = ''; req.on('data', part => { body += part; if (body.length > 4000) { reject(Error('Too large')); req.destroy(); } }); req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(Error('Invalid JSON')); } }); }); }
const allowed = new Map([['/', 'index.html'], ['/app.js', 'app.js']]);
const server = http.createServer(async (req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  if (route === '/api/me') return json(res, 200, { user: currentUser(req) });
  if ((route === '/api/register' || route === '/api/login') && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch { return json(res, 400, { error: 'Geçersiz istek.' }); }
    const email = String(body.email || '').trim().toLowerCase(), password = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120 || password.length < 8 || password.length > 200) return json(res, 400, { error: 'Geçerli e-posta ve en az 8 karakterli şifre gir.' });
    let user = users.get(email);
    if (route === '/api/register') {
      if (user) return json(res, 409, { error: 'Bu e-posta kayıtlı.' });
      const salt = crypto.randomBytes(16).toString('hex');
      user = { email, salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
      users.set(email, user); fs.writeFileSync(accountsFile, JSON.stringify([...users.values()]));
    } else {
      if (!user || !crypto.timingSafeEqual(Buffer.from(user.hash, 'hex'), crypto.scryptSync(password, user.salt, 64))) return json(res, 401, { error: 'E-posta veya şifre yanlış.' });
    }
    const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, email);
    res.setHeader('Set-Cookie', `puzzle_session=${token}; HttpOnly; SameSite=Lax; Path=/`);
    return json(res, 200, { user: email });
  }
  if (route === '/api/logout' && req.method === 'POST') {
    const token = /(?:^|; )puzzle_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1]; sessions.delete(token);
    res.setHeader('Set-Cookie', 'puzzle_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); return json(res, 200, { ok: true });
  }
  const name = allowed.get(route);
  if (!name) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  fs.createReadStream(path.join(__dirname, name)).pipe(res);
});
const peers = new Set();
function send(ws, data) { if (ws.destroyed || ws.writableEnded) return; const payload = Buffer.from(JSON.stringify(data)); const head = payload.length < 126 ? Buffer.from([129, payload.length]) : payload.length < 65536 ? Buffer.from([129, 126, payload.length >> 8, payload.length & 255]) : Buffer.from([129, 127, 0, 0, 0, 0, payload.length >>> 24, (payload.length >>> 16) & 255, (payload.length >>> 8) & 255, payload.length & 255]); ws.write(Buffer.concat([head, payload])); }
function broadcast(room, data, except) {
  for (const ws of peers) if (clients.get(ws)?.room === room && ws !== except) send(ws, data);
}
function validId(id) { return typeof id === 'string' && /^[a-z0-9-]{6,48}$/.test(id); }
function cleanPos(p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: Math.max(-200, Math.min(3000, p.x)), y: Math.max(-200, Math.min(3000, p.y)), done: !!p.done };
}
function onMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      if (!validId(m.room) || typeof m.name !== 'string') return send(ws, { type: 'error', message: 'Geçersiz oda.' });
      clients.set(ws, { room: m.room, name: m.name.slice(0, 30) || 'Misafir' });
      send(ws, { type: 'state', state: rooms.get(m.room) || null });
      broadcast(m.room, { type: 'presence', name: clients.get(ws).name, joined: true }, ws);
      return;
    }
    const client = clients.get(ws);
    if (!client || m.room !== client.room) return;
    if (m.type === 'create') {
      if (rooms.has(client.room)) return send(ws, { type: 'state', state: rooms.get(client.room) });
      const validImage = typeof m.image === 'string' && (/^data:image\/(jpeg|png|webp);base64,/.test(m.image) || /^https:\/\/images\.unsplash\.com\//.test(m.image));
      if (![5, 8, 10].includes(m.grid) || !validImage || m.image.length > 7_000_000) return send(ws, { type: 'error', message: 'Resim veya seviye geçersiz.' });
      const state = { grid: m.grid, image: m.image, seed: Number(m.seed) >>> 0, positions: {}, finish: String(m.finish || '').slice(0, 100) };
      rooms.set(client.room, state);
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
      broadcast(client.room, { type: 'move', id: m.id, pos }, ws);
      if (pos.done) { locks.delete(key); broadcast(client.room, { type: 'unlock', id: m.id }); }
    }
    if (m.type === 'unlock' && locks.get(key)?.ws === ws) {
      locks.delete(key); broadcast(client.room, { type: 'unlock', id: m.id }, ws);
    }
}
server.on('upgrade', (req, ws) => {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') return ws.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  ws.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  peers.add(ws); ws.user = currentUser(req); let buffer = Buffer.alloc(0);
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
    if (client) broadcast(client.room, { type: 'presence', name: client.name, joined: false }, ws);
    clients.delete(ws);
    peers.delete(ws);
    for (const [key, lock] of locks) if (lock.ws === ws) { locks.delete(key); if (client) broadcast(client.room, { type: 'unlock', id: Number(key.split(':').pop()) }); }
  });
});
server.listen(PORT, () => console.log(`Puzzle: http://localhost:${PORT}`));
