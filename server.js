'use strict';
/**
 * Caro Online — server không phụ thuộc thư viện ngoài (chỉ dùng Node >= 18).
 *  - HTTP: phục vụ thư mục public/ + API lịch sử ván đấu
 *  - WebSocket: tự cài đặt (RFC 6455) cho độ trễ thấp, không cần `npm install`
 *  - Server là "trọng tài": kiểm tra lượt đi, luật thắng, lưu ván, giữ chỗ 2 phút khi mất kết nối
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const GAMES = path.join(DATA, 'games');
const ROOMS_FILE = path.join(DATA, 'rooms.json');
const GRACE = +process.env.GRACE_MS || 120000; // 2 phút để kết nối lại
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SIZES = [10, 13, 15, 19, 25];

fs.mkdirSync(GAMES, { recursive: true });
fs.mkdirSync(path.join(PUB, 'stickers'), { recursive: true });

const rid = (n = 8) => crypto.randomBytes(12).toString('base64url').slice(0, n);
const ushort = (pid) => crypto.createHash('sha1').update(pid).digest('hex').slice(0, 8);
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CH[crypto.randomInt(CODE_CH.length)];
    if (!rooms.has(c)) return c;
  }
};
const cleanName = (n) => {
  n = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  return n || 'Người chơi';
};

/* ───────────── Lưu trữ ván đấu ───────────── */
const gameIndex = new Map(); // id -> meta
const gameCache = new Map(); // id -> game đầy đủ (giữ ~200 ván gần nhất)
const metaOf = (g) => ({
  id: g.id, size: g.size, startedAt: g.startedAt, endedAt: g.endedAt, moves: g.moves.length,
  players: g.players, result: g.result && { winner: g.result.winner, reason: g.result.reason },
});
for (const f of fs.readdirSync(GAMES)) {
  if (!f.endsWith('.json')) continue;
  try {
    const g = JSON.parse(fs.readFileSync(path.join(GAMES, f), 'utf8'));
    gameIndex.set(g.id, metaOf(g));
  } catch { /* bỏ qua file hỏng */ }
}
function saveGame(room) {
  const g = {
    id: room.gameId, code: room.code, size: room.size, startedAt: room.startedAt, endedAt: Date.now(),
    players: room.players.map((p, i) => ({ u: p.u, name: p.name, mark: i ? 'O' : 'X' })),
    moves: room.moves, result: room.result, chat: room.chat.filter((c) => c.ts >= room.startedAt),
  };
  gameIndex.set(g.id, metaOf(g));
  gameCache.set(g.id, g);
  if (gameCache.size > 200) gameCache.delete(gameCache.keys().next().value);
  fs.writeFile(path.join(GAMES, g.id + '.json'), JSON.stringify(g), () => {});
}
function loadGame(id) {
  if (gameCache.has(id)) return gameCache.get(id);
  try { return JSON.parse(fs.readFileSync(path.join(GAMES, id + '.json'), 'utf8')); } catch { return null; }
}

/* ───────────── Luật chơi ───────────── */
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
function checkWin(b, size, x, y, v) {
  for (const [dx, dy] of DIRS) {
    const cells = [[x, y]];
    for (const s of [1, -1]) {
      let cx = x + dx * s, cy = y + dy * s;
      while (cx >= 0 && cy >= 0 && cx < size && cy < size && b[cy * size + cx] === v) {
        cells.push([cx, cy]); cx += dx * s; cy += dy * s;
      }
    }
    if (cells.length >= 5) { cells.sort((a, b2) => a[0] - b2[0] || a[1] - b2[1]); return cells; }
  }
  return null;
}

/* ───────────── Phòng chơi ───────────── */
const rooms = new Map();    // code -> Room
const conns = new Map();    // pid  -> Conn
const names = new Map();    // pid  -> tên
const pidRoom = new Map();  // pid  -> code
let queue = [];             // hàng chờ ghép ngẫu nhiên (pid)

class Room {
  constructor(code, size) {
    this.code = code; this.size = size; this.players = []; this.spec = new Map();
    this.chat = []; this.touched = Date.now(); this.newGame();
  }
  newGame() {
    this.board = new Uint8Array(this.size * this.size);
    this.moves = []; this.turn = 0; this.result = null; this.rematch = new Set();
    this.gameId = rid(10); this.startedAt = Date.now();
    this.status = this.players.length === 2 ? 'playing' : 'waiting';
  }
  pidx(pid) { return this.players.findIndex((p) => p.pid === pid); }
  targets() {
    const a = [];
    for (const p of this.players) if (p.conn) a.push(p.conn);
    for (const c of this.spec.values()) a.push(c);
    return a;
  }
  bc(msg) { msg.code = this.code; const s = JSON.stringify(msg); for (const c of this.targets()) c.sendRaw(s); }
  view(pid) {
    const now = Date.now();
    return {
      t: 'state', code: this.code, size: this.size, status: this.status, turn: this.turn,
      moves: this.moves, result: this.result, gameId: this.gameId, you: this.pidx(pid),
      players: this.players.map((p) => ({
        name: p.name, u: p.u, online: !!p.conn && !p.gone, gone: !!p.gone,
        left: p.discAt ? Math.max(0, p.discAt + GRACE - now) : 0,
      })),
      rematch: [...this.rematch], chat: this.chat.slice(-80), spec: this.spec.size,
    };
  }
  sendStates() {
    for (const p of this.players) if (p.conn) p.conn.send(this.view(p.pid));
    for (const [pid, c] of this.spec) c.send(this.view(pid));
  }
  addPlayer(pid) {
    const p = { pid, u: ushort(pid), name: names.get(pid) || 'Người chơi', conn: conns.get(pid) || null, discAt: 0, timer: null, gone: false };
    this.players.push(p); pidRoom.set(pid, this.code); return p;
  }
  clearTimers() { for (const p of this.players) { clearTimeout(p.timer); p.timer = null; p.discAt = 0; } }
  finish(winner, reason, line) {
    if (this.status !== 'playing') return;
    this.status = 'finished';
    this.result = { winner, reason, line: line || null };
    this.clearTimers();
    saveGame(this);
    this.bc({ t: 'end', result: this.result });
    persist();
  }
  move(pid, x, y) {
    const i = this.pidx(pid);
    if (this.status !== 'playing' || i !== this.turn) return 'Chưa đến lượt bạn';
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.size || y >= this.size) return 'Ô không hợp lệ';
    if (this.board[y * this.size + x]) return 'Ô đã có quân';
    this.board[y * this.size + x] = i + 1;
    this.moves.push([x, y]);
    const line = checkWin(this.board, this.size, x, y, i + 1);
    if (!line) this.turn = 1 - i;
    this.bc({ t: 'move', n: this.moves.length - 1, x, y, turn: this.turn });
    if (line) this.finish(i, 'five', line);
    else if (this.moves.length === this.size * this.size) this.finish(null, 'draw');
    else persist();
    return null;
  }
  forfeit(i) {
    if (this.status !== 'playing') return;
    const other = this.players[1 - i];
    if (other && other.conn) this.finish(1 - i, 'timeout');
    else this.finish(null, 'abandoned');
  }
  startGrace(i) {
    const p = this.players[i];
    p.discAt = Date.now();
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.forfeit(i), GRACE);
  }
}

function destroy(r) {
  r.clearTimers();
  rooms.delete(r.code);
  for (const p of r.players) if (pidRoom.get(p.pid) === r.code) pidRoom.delete(p.pid);
  for (const pid of r.spec.keys()) if (pidRoom.get(pid) === r.code) pidRoom.delete(pid);
  persist();
}
function leave(pid) {
  const code = pidRoom.get(pid); if (!code) return;
  pidRoom.delete(pid);
  const r = rooms.get(code); if (!r) return;
  const i = r.pidx(pid);
  if (i < 0) { r.spec.delete(pid); r.bc({ t: 'spec', n: r.spec.size }); return; }
  if (r.status === 'playing') r.finish(1 - i, 'resign');
  if (r.status === 'waiting') return destroy(r);
  const p = r.players[i];
  p.gone = true; p.conn = null; clearTimeout(p.timer);
  if (r.players.every((q) => q.gone)) return destroy(r);
  r.bc({ t: 'presence', i, online: false, gone: true, left: 0 });
  persist();
}
// Nếu đang có trận dang dở thì trả về mã phòng, ngược lại rời phòng cũ (nếu có)
function guardExisting(pid) {
  const code = pidRoom.get(pid); if (!code) return null;
  const r = rooms.get(code);
  if (!r) { pidRoom.delete(pid); return null; }
  if (r.status === 'playing' && r.pidx(pid) >= 0) return code;
  leave(pid); return null;
}
function rebind(pid, conn) {
  const r = rooms.get(pidRoom.get(pid)); if (!r) return;
  const i = r.pidx(pid);
  if (i < 0) { if (r.spec.has(pid)) r.spec.set(pid, conn); return; }
  const p = r.players[i];
  if (p.gone) return;
  p.conn = conn; clearTimeout(p.timer); p.timer = null; p.discAt = 0;
  r.bc({ t: 'presence', i, online: true, left: 0 });
}

/* ───────────── Lưu phòng xuống đĩa (sống sót khi server khởi động lại) ───────────── */
let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const out = [];
    for (const r of rooms.values()) {
      out.push({
        code: r.code, size: r.size, status: r.status, turn: r.turn, moves: r.moves, result: r.result,
        gameId: r.gameId, startedAt: r.startedAt, chat: r.chat.slice(-100),
        players: r.players.map((p) => ({ pid: p.pid, name: p.name, gone: p.gone })),
      });
    }
    fs.writeFile(ROOMS_FILE + '.tmp', JSON.stringify(out), (e) => { if (!e) fs.rename(ROOMS_FILE + '.tmp', ROOMS_FILE, () => {}); });
  }, 800);
}
try {
  for (const d of JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'))) {
    const r = new Room(d.code, d.size);
    Object.assign(r, { status: d.status, turn: d.turn, moves: d.moves, result: d.result, gameId: d.gameId, startedAt: d.startedAt, chat: d.chat });
    d.moves.forEach(([x, y], i) => { r.board[y * d.size + x] = (i % 2) + 1; });
    for (const p of d.players) {
      r.players.push({ pid: p.pid, u: ushort(p.pid), name: p.name, conn: null, discAt: 0, timer: null, gone: !!p.gone });
      pidRoom.set(p.pid, r.code);
    }
    if (r.status === 'playing') r.players.forEach((p, i) => r.startGrace(i));
    rooms.set(r.code, r);
  }
} catch { /* chưa có file */ }

setInterval(() => { // dọn phòng bỏ hoang
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.targets().length) { r.touched = now; continue; }
    const idle = now - r.touched;
    if ((r.status === 'finished' && idle > 10 * 60000) || (r.status === 'waiting' && idle > 30 * 60000)) destroy(r);
  }
}, 60000).unref();

/* ───────────── Nhãn dán ───────────── */
const STK_EXT = /\.(png|webp|gif|jpe?g|svg|apng)$/i;
const listStickers = () => { try { return fs.readdirSync(path.join(PUB, 'stickers')).filter((f) => STK_EXT.test(f)).sort(); } catch { return []; } };

/* ───────────── WebSocket tối giản ───────────── */
class Conn {
  constructor(sock) {
    this.s = sock; this.buf = Buffer.alloc(0); this.dead = false; this.pid = null;
    this.last = Date.now(); this.frag = null; this.chatTimes = [];
    sock.on('data', (d) => this.onData(d));
    sock.on('close', () => this.onClose());
    sock.on('error', () => this.close());
  }
  onData(d) {
    this.last = Date.now();
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > (1 << 20)) return this.close();
    while (!this.dead) {
      const b = this.buf; if (b.length < 2) return;
      const fin = !!(b[0] & 128), op = b[0] & 15, masked = !!(b[1] & 128);
      let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 65536) return this.close();
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const m = b.subarray(off, off + 4); payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      this.buf = b.subarray(need);
      this.frame(op, fin, payload);
    }
  }
  frame(op, fin, p) {
    if (op === 8) { this.raw(8, Buffer.alloc(0)); return this.close(); }
    if (op === 9) return this.raw(10, p);
    if (op === 10 || op === 2) return;
    if (op === 1) this.frag = [p]; else if (op === 0 && this.frag) this.frag.push(p); else return;
    if (!fin) return;
    const txt = Buffer.concat(this.frag).toString('utf8'); this.frag = null;
    let m; try { m = JSON.parse(txt); } catch { return; }
    if (m && typeof m === 'object') { try { handle(this, m); } catch (e) { console.error('handler error', e); } }
  }
  raw(op, p) {
    if (this.dead) return;
    const l = p.length; let h;
    if (l < 126) h = Buffer.from([128 | op, l]);
    else if (l < 65536) { h = Buffer.alloc(4); h[0] = 128 | op; h[1] = 126; h.writeUInt16BE(l, 2); }
    else { h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(l), 2); }
    this.s.write(Buffer.concat([h, p]));
  }
  sendRaw(str) { this.raw(1, Buffer.from(str)); }
  send(obj) { this.sendRaw(JSON.stringify(obj)); }
  close() { if (!this.dead) { try { this.s.destroy(); } catch {} } this.onClose(); }
  onClose() {
    if (this.dead) return; this.dead = true;
    const pid = this.pid; if (!pid) return;
    if (conns.get(pid) === this) { conns.delete(pid); queue = queue.filter((q) => q !== pid); }
    const r = rooms.get(pidRoom.get(pid)); if (!r) return;
    const i = r.pidx(pid);
    if (i < 0) { if (r.spec.get(pid) === this) { r.spec.delete(pid); r.bc({ t: 'spec', n: r.spec.size }); } return; }
    const p = r.players[i];
    if (p.conn !== this) return; // đã được thay bằng kết nối mới
    p.conn = null;
    if (r.status === 'playing') r.startGrace(i);
    r.bc({ t: 'presence', i, online: false, left: r.status === 'playing' ? GRACE : 0 });
    persist();
  }
}
// nhịp tim: phát hiện kết nối chết sau ~15s
setInterval(() => {
  const now = Date.now();
  for (const c of new Set([...conns.values(), ...pending])) {
    if (now - c.last > 15000) c.close(); else c.raw(9, Buffer.alloc(0));
  }
}, 5000).unref();
const pending = new Set(); // kết nối chưa gửi hello

/* ───────────── Xử lý tin nhắn ───────────── */
function listStickersSet() { return new Set(listStickers()); }
function handle(c, m) {
  if (m.t === 'ping') return c.send({ t: 'pong', ts: m.ts });
  if (m.t === 'hello') {
    const pid = String(m.pid || '');
    if (!/^[\w-]{8,64}$/.test(pid)) return c.close();
    const old = conns.get(pid);
    c.pid = pid; pending.delete(c);
    conns.set(pid, c);
    if (old && old !== c) { old.close(); }
    names.set(pid, cleanName(m.name));
    rebind(pid, c);
    const r = rooms.get(pidRoom.get(pid));
    const active = r && r.status !== 'finished' && r.pidx(pid) >= 0 ? r.code : null;
    return c.send({ t: 'hello', u: ushort(pid), online: conns.size, stickers: listStickers(), active, now: Date.now() });
  }
  if (!c.pid) return;
  const pid = c.pid;
  const room = () => rooms.get(pidRoom.get(pid));

  switch (m.t) {
    case 'name': {
      names.set(pid, cleanName(m.name)); break;
    }
    case 'create': {
      const busy = guardExisting(pid);
      if (busy) return c.send({ t: 'err', c: 'busy', code: busy, m: 'Bạn đang trong một trận chưa kết thúc' });
      const size = SIZES.includes(+m.size) ? +m.size : 15;
      const r = new Room(newCode(), size);
      rooms.set(r.code, r); r.addPlayer(pid);
      c.send({ t: 'created', code: r.code }); persist(); break;
    }
    case 'join': {
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r) return c.send({ t: 'err', c: 'noroom', m: 'Phòng không tồn tại hoặc đã đóng' });
      if (pidRoom.get(pid) !== r.code) {
        const busy = guardExisting(pid);
        if (busy) return c.send({ t: 'err', c: 'busy', code: busy, m: 'Bạn đang trong một trận chưa kết thúc' });
      }
      const i = r.pidx(pid);
      if (i >= 0) {
        if (r.players[i].gone) { // đã rời phòng này trước đó
          return c.send({ t: 'err', c: 'noroom', m: 'Bạn đã rời phòng này' });
        }
        rebind(pid, c); c.send(r.view(pid));
      } else if (r.status === 'waiting' && r.players.length === 1) {
        r.addPlayer(pid); r.newGame(); r.sendStates(); persist();
      } else {
        r.spec.set(pid, c); pidRoom.set(pid, r.code);
        c.send(r.view(pid)); r.bc({ t: 'spec', n: r.spec.size });
      }
      break;
    }
    case 'sync': { const r = room(); if (r) c.send(r.view(pid)); break; }
    case 'move': {
      const r = room(); if (!r) return;
      const e = r.move(pid, m.x, m.y);
      if (e) { c.send({ t: 'err', c: 'move', m: e }); c.send(r.view(pid)); }
      break;
    }
    case 'chat': case 'sticker': {
      const r = room(); if (!r) return;
      const i = r.pidx(pid); if (i < 0) return c.send({ t: 'err', c: 'chat', m: 'Người xem không thể chat' });
      const now = Date.now();
      c.chatTimes = c.chatTimes.filter((t) => now - t < 4000);
      if (c.chatTimes.length >= 6) return c.send({ t: 'err', c: 'chat', m: 'Bạn nhắn nhanh quá, chậm lại chút nhé' });
      c.chatTimes.push(now);
      let entry;
      if (m.t === 'chat') {
        const v = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
        if (!v) return;
        entry = { u: r.players[i].u, name: r.players[i].name, k: 't', v, ts: now };
      } else {
        const v = String(m.v || '');
        const ok = (v.startsWith('e:') && v.length <= 20 && Array.from(v.slice(2)).length <= 4) ||
                   (v.startsWith('i:') && listStickersSet().has(v.slice(2)));
        if (!ok) return;
        entry = { u: r.players[i].u, name: r.players[i].name, k: 's', v, ts: now };
      }
      r.chat.push(entry); if (r.chat.length > 300) r.chat.shift();
      r.bc({ t: 'chat', m: entry }); persist(); break;
    }
    case 'resign': {
      const r = room(); if (!r) return;
      const i = r.pidx(pid);
      if (i >= 0 && r.status === 'playing') r.finish(1 - i, 'resign');
      break;
    }
    case 'rematch': {
      const r = room(); if (!r) return;
      const i = r.pidx(pid);
      if (i < 0 || r.status !== 'finished' || r.players.length < 2 || r.players.some((p) => p.gone)) return;
      r.rematch.add(i);
      if (r.rematch.size === 2) { r.players.reverse(); r.newGame(); r.sendStates(); persist(); }
      else r.bc({ t: 'rematch', list: [...r.rematch] });
      break;
    }
    case 'leave': leave(pid); c.send({ t: 'left' }); break;
    case 'queue': {
      const busy = guardExisting(pid);
      if (busy) return c.send({ t: 'err', c: 'busy', code: busy, m: 'Bạn đang trong một trận chưa kết thúc' });
      queue = queue.filter((q) => q !== pid && conns.has(q));
      const other = queue.shift();
      if (other) {
        const r = new Room(newCode(), 15); rooms.set(r.code, r);
        const first = Math.random() < 0.5 ? [other, pid] : [pid, other];
        first.forEach((p) => r.addPlayer(p));
        r.newGame();
        for (const p of [other, pid]) conns.get(p)?.send({ t: 'matched', code: r.code });
        persist();
      } else { queue.push(pid); c.send({ t: 'queued' }); }
      break;
    }
    case 'unqueue': queue = queue.filter((q) => q !== pid); c.send({ t: 'unqueued' }); break;
  }
}

/* ───────────── HTTP ───────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.apng': 'image/apng', '.ico': 'image/x-icon',
};
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size, online: conns.size });
  if (p === '/api/games') {
    const u = url.searchParams.get('u') || '';
    const list = [...gameIndex.values()].filter((g) => g.players.some((x) => x.u === u)).sort((a, b) => b.endedAt - a.endedAt).slice(0, 200);
    return json(res, 200, list);
  }
  let m = p.match(/^\/api\/games\/([\w-]{6,20})$/);
  if (m) { const g = loadGame(m[1]); return g ? json(res, 200, g) : json(res, 404, { error: 'not found' }); }

  let file = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUB + path.sep) && file !== PUB) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/stickers/') ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});
server.on('upgrade', (req, sock) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !req.headers['sec-websocket-key']) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true); sock.setKeepAlive(true, 10000);
  const c = new Conn(sock); pending.add(c);
  sock.on('close', () => pending.delete(c));
});
server.listen(PORT, () => console.log('Caro Online chạy tại http://localhost:' + PORT));

process.on('SIGTERM', () => { persist(); setTimeout(() => process.exit(0), 1000); });
