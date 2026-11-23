'use strict';
/**
 * Caro Online — server không phụ thuộc thư viện ngoài (chỉ dùng Node >= 18).
 *  - HTTP: phục vụ public/ + API lịch sử ván + ảnh nhãn dán người chơi tải lên
 *  - WebSocket tự cài đặt (RFC 6455) để độ trễ thấp
 *  - Server là trọng tài: lượt đi, luật thắng, đồng hồ (tổng giờ + giờ mỗi nước),
 *    giữ chỗ khi mất kết nối, tự reset ván, đổi bên mỗi ván
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const GAMES = path.join(DATA, 'games');
const ASSETS = path.join(DATA, 'assets');
const ROOMS_FILE = path.join(DATA, 'rooms.json');
const GRACE = +process.env.GRACE_MS || 300000;          // 5 phút để kết nối lại
const RESET_MIN = +process.env.RESET_MIN_MS || 5000;    // sau 5s mới hiện nút reset
const RESET_AUTO = +process.env.RESET_AUTO_MS || 15000; // 15s tự reset
const TS = +process.env.TIME_SCALE || 1; // chỉ dùng khi kiểm thử
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SIZES = [10, 13, 15, 19, 25];
const TOTALS = [5, 10, 15];     // phút / người
const TURNS = [30, 60, 120];    // giây / nước
const SHAPES = ['x', 'o', 'dot', 'sq', 'tri', 'dia', 'heart', 'star', 'flower', 'plus'];

for (const d of [GAMES, ASSETS, path.join(PUB, 'stickers')]) fs.mkdirSync(d, { recursive: true });

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
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || 'Người chơi';
const validStyle = (s) => (s && SHAPES.includes(s.s) && /^#[0-9a-fA-F]{6}$/.test(String(s.c)) ? { s: s.s, c: String(s.c).toLowerCase() } : null);
const defaultStyle = (i) => (i === 0 ? { s: 'x', c: '#2f6bff' } : { s: 'o', c: '#ff4d5e' });

/* ───────────── Lưu trữ ván đấu ───────────── */
const gameIndex = new Map();
const gameCache = new Map();
const metaOf = (g) => ({
  id: g.id, size: g.size, startedAt: g.startedAt, endedAt: g.endedAt, moves: g.moves.length,
  players: g.players, result: g.result && { winner: g.result.winner, reason: g.result.reason },
});
for (const f of fs.readdirSync(GAMES)) {
  if (!f.endsWith('.json')) continue;
  try { const g = JSON.parse(fs.readFileSync(path.join(GAMES, f), 'utf8')); gameIndex.set(g.id, metaOf(g)); } catch { /* bỏ qua */ }
}
function saveGame(room) {
  const g = {
    id: room.gameId, code: room.code, size: room.size, total: room.total, turnMs: room.turnMs,
    startedAt: room.startedAt, endedAt: Date.now(),
    players: room.players.map((p) => ({ u: p.u, name: p.name, style: p.style })),
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

/* ───────────── Ảnh nhãn dán do người chơi tải lên ───────────── */
function saveAsset(dataUrl) {
  const m = /^data:image\/(png|webp|gif|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 20 || buf.length > 250 * 1024) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const ok = ext === 'png' ? buf.readUInt32BE(0) === 0x89504e47
    : ext === 'gif' ? buf.toString('latin1', 0, 4) === 'GIF8'
    : ext === 'webp' ? buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP'
    : buf[0] === 0xff && buf[1] === 0xd8;
  if (!ok) return null;
  const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + ext;
  const f = path.join(ASSETS, name);
  if (!fs.existsSync(f)) fs.writeFileSync(f, buf);
  return name;
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
const rooms = new Map();
const conns = new Map();
const names = new Map();
const styles = new Map();
const pidRoom = new Map();
let queue = [];

class Room {
  constructor(code, size, total, turnMs, host) {
    this.code = code; this.size = size; this.total = total; this.turnMs = turnMs; this.host = host;
    this.players = []; this.spec = new Map(); this.chat = []; this.touched = Date.now();
    this.clockTimer = null; this.autoTimer = null; this.undoTimer = null; this.newGame();
  }
  newGame() {
    clearTimeout(this.clockTimer); clearTimeout(this.autoTimer); clearTimeout(this.undoTimer);
    this.spent = []; this.undoLeft = [3, 3]; this.undoReq = null;
    this.board = new Uint8Array(this.size * this.size);
    this.moves = []; this.turn = 0; this.result = null;
    this.bank = [this.total, this.total]; this.turnStart = 0; this.endedAt = 0;
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
    const now = Date.now(), running = this.status === 'playing' && this.moves.length > 0;
    return {
      t: 'state', code: this.code, size: this.size, total: this.total, turnMs: this.turnMs,
      status: this.status, turn: this.turn, moves: this.moves, result: this.result, gameId: this.gameId,
      you: this.pidx(pid), host: this.host === pid, bank: this.bank, running,
      ago: running ? now - this.turnStart : 0, endedAgo: this.endedAt ? now - this.endedAt : 0,
      resetMin: RESET_MIN, resetAuto: RESET_AUTO, undoLeft: this.undoLeft,
      undo: this.undoReq ? { by: this.undoReq.by } : null,
      players: this.players.map((p) => ({
        name: p.name, u: p.u, style: p.style, online: !!p.conn && !p.gone, gone: !!p.gone,
        left: p.discAt ? Math.max(0, p.discAt + GRACE - now) : 0,
      })),
      chat: this.chat.slice(-80), spec: this.spec.size,
    };
  }
  sendStates() {
    for (const p of this.players) if (p.conn) p.conn.send(this.view(p.pid));
    for (const [pid, c] of this.spec) c.send(this.view(pid));
  }
  addPlayer(pid) {
    const p = { pid, u: ushort(pid), name: names.get(pid) || 'Người chơi', style: styles.get(pid) || defaultStyle(this.players.length), conn: conns.get(pid) || null, discAt: 0, timer: null, gone: false };
    this.players.push(p); pidRoom.set(pid, this.code); return p;
  }
  clearTimers() { clearTimeout(this.clockTimer); for (const p of this.players) { clearTimeout(p.timer); p.timer = null; p.discAt = 0; } }
  armClock() {
    clearTimeout(this.clockTimer);
    if (this.status !== 'playing' || this.moves.length === 0) return;
    const i = this.turn;
    const left = Math.min(this.turnMs, this.bank[i]) - (Date.now() - this.turnStart);
    this.clockTimer = setTimeout(() => this.timeout(i), Math.max(0, left) + 250); // +250ms bù độ trễ mạng
  }
  timeout(i) {
    if (this.status !== 'playing' || this.turn !== i) return;
    this.bank[i] = 0; this.finish(1 - i, 'time');
  }
  finish(winner, reason, line) {
    if (this.status !== 'playing') return;
    this.status = 'finished';
    this.result = { winner, reason, line: line || null };
    this.clearTimers();
    if (this.undoReq) this.endUndo(false, 'ended');
    this.endedAt = Date.now();
    clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => this.autoReset(), RESET_AUTO);
    saveGame(this);
    this.bc({ t: 'end', result: this.result, bank: this.bank });
    persist();
  }
  canReset() { return this.status === 'finished' && this.players.length === 2 && !this.players.some((p) => p.gone); }
  autoReset() { if (this.canReset()) this.doReset(); }
  doReset() {
    this.players.reverse(); // đổi bên: người đi sau ván trước sẽ đi trước
    this.newGame();
    this.players.forEach((p, i) => { if (!p.conn) this.startGrace(i); });
    this.sendStates(); persist();
  }
  move(pid, x, y) {
    const i = this.pidx(pid);
    if (this.status !== 'playing' || i !== this.turn) return 'Chưa đến lượt bạn';
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.size || y >= this.size) return 'Ô không hợp lệ';
    if (this.board[y * this.size + x]) return 'Ô đã có quân';
    const now = Date.now();
    if (this.undoReq) this.endUndo(false, 'moved');
    let spent = 0;
    if (this.moves.length > 0) { // nước đầu tiên chưa tính giờ
      const el = now - this.turnStart;
      if (el > Math.min(this.turnMs, this.bank[i]) + 250) { this.timeout(i); return null; }
      spent = Math.min(el, this.bank[i]); this.bank[i] = Math.max(0, this.bank[i] - el);
    }
    this.spent.push(spent);
    this.board[y * this.size + x] = i + 1;
    this.moves.push([x, y]);
    const line = checkWin(this.board, this.size, x, y, i + 1);
    const draw = !line && this.moves.length === this.size * this.size;
    if (!line && !draw) { this.turn = 1 - i; this.turnStart = now; this.armClock(); }
    this.bc({ t: 'move', n: this.moves.length - 1, x, y, turn: this.turn, bank: this.bank });
    if (line) this.finish(i, 'five', line);
    else if (draw) this.finish(null, 'draw');
    else persist();
    return null;
  }
  requestUndo(pid) {
    const i = this.pidx(pid);
    if (this.status !== 'playing' || i < 0) return 'Không thể lùi lúc này';
    if (!this.moves.length || (this.moves.length - 1) % 2 !== i) return 'Chỉ xin lùi được nước bạn vừa đi (khi đối thủ chưa đánh)';
    if (this.undoLeft[i] <= 0) return 'Bạn đã hết lượt xin lùi trong ván này';
    if (this.undoReq) return 'Đang chờ đối thủ trả lời';
    if (!this.players[1 - i].conn) return 'Đối thủ đang mất kết nối';
    this.undoReq = { by: i, at: Date.now() };
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => this.endUndo(false, 'timeout'), 15000);
    this.bc({ t: 'undoreq', by: i });
    return null;
  }
  endUndo(ok, reason) {
    if (!this.undoReq) return;
    const by = this.undoReq.by; this.undoReq = null; clearTimeout(this.undoTimer);
    if (!ok) return this.bc({ t: 'undoend', reason });
    const mv = this.moves.pop();
    this.board[mv[1] * this.size + mv[0]] = 0;
    this.bank[by] += this.spent.pop() || 0;
    this.turn = by; this.turnStart = Date.now(); this.undoLeft[by]--;
    this.armClock();
    this.bc({ t: 'undone', n: this.moves.length, turn: this.turn, bank: this.bank, by, left: this.undoLeft });
    persist();
  }
  forfeit(i) {
    if (this.status !== 'playing') return;
    const other = this.players[1 - i];
    if (other && other.conn) this.finish(1 - i, 'timeout'); else this.finish(null, 'abandoned');
  }
  startGrace(i) {
    const p = this.players[i];
    p.discAt = Date.now(); clearTimeout(p.timer);
    p.timer = setTimeout(() => this.forfeit(i), GRACE);
  }
}

function destroy(r) {
  r.clearTimers(); clearTimeout(r.autoTimer);
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
function applyStyle(pid, st) {
  styles.set(pid, st);
  const r = rooms.get(pidRoom.get(pid)); if (!r) return;
  const i = r.pidx(pid); if (i < 0) return;
  r.players[i].style = st; r.bc({ t: 'style', i, style: st }); persist();
}

/* ───────────── Lưu phòng xuống đĩa ───────────── */
let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const out = [];
    for (const r of rooms.values()) {
      out.push({
        code: r.code, size: r.size, total: r.total, turnMs: r.turnMs, host: r.host, status: r.status, turn: r.turn,
        moves: r.moves, result: r.result, gameId: r.gameId, startedAt: r.startedAt, bank: r.bank, chat: r.chat.slice(-100),
        players: r.players.map((p) => ({ pid: p.pid, name: p.name, gone: p.gone, style: p.style })),
      });
    }
    fs.writeFile(ROOMS_FILE + '.tmp', JSON.stringify(out), (e) => { if (!e) fs.rename(ROOMS_FILE + '.tmp', ROOMS_FILE, () => {}); });
  }, 800);
}
try {
  for (const d of JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'))) {
    const r = new Room(d.code, d.size, d.total || 300000, d.turnMs || 60000, d.host);
    Object.assign(r, { status: d.status, turn: d.turn, moves: d.moves, result: d.result, gameId: d.gameId, startedAt: d.startedAt, chat: d.chat, bank: d.bank || [r.total, r.total] });
    d.moves.forEach(([x, y], i) => { r.board[y * d.size + x] = (i % 2) + 1; });
    r.spent = d.moves.map(() => 0);
    for (const p of d.players) {
      r.players.push({ pid: p.pid, u: ushort(p.pid), name: p.name, style: p.style, conn: null, discAt: 0, timer: null, gone: !!p.gone });
      pidRoom.set(p.pid, r.code);
    }
    if (r.status === 'playing') { r.players.forEach((p, i) => r.startGrace(i)); r.turnStart = Date.now(); r.armClock(); }
    if (r.status === 'finished') { r.endedAt = Date.now(); r.autoTimer = setTimeout(() => r.autoReset(), RESET_AUTO); }
    rooms.set(r.code, r);
  }
} catch { /* chưa có file */ }

setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.targets().length) { r.touched = now; continue; }
    const idle = now - r.touched;
    if ((r.status === 'finished' && idle > 10 * 60000) || (r.status === 'waiting' && idle > 30 * 60000)) destroy(r);
  }
}, 60000).unref();

/* ───────────── Nhãn dán có sẵn ───────────── */
const STK_EXT = /\.(png|webp|gif|jpe?g|svg|apng)$/i;
const listStickers = () => { try { return fs.readdirSync(path.join(PUB, 'stickers')).filter((f) => STK_EXT.test(f)).sort(); } catch { return []; } };

/* ───────────── WebSocket tối giản ───────────── */
const MAX_FRAME = 600 * 1024;
class Conn {
  constructor(sock) {
    this.s = sock; this.buf = Buffer.alloc(0); this.dead = false; this.pid = null;
    this.last = Date.now(); this.frag = null; this.chatTimes = []; this.reactTimes = [];
    sock.on('data', (d) => this.onData(d));
    sock.on('close', () => this.onClose());
    sock.on('error', () => this.close());
  }
  onData(d) {
    this.last = Date.now();
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 2 * MAX_FRAME) return this.close();
    while (!this.dead) {
      const b = this.buf; if (b.length < 2) return;
      const fin = !!(b[0] & 128), op = b[0] & 15, masked = !!(b[1] & 128);
      let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_FRAME) return this.close();
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
    if (p.conn !== this) return;
    p.conn = null;
    if (r.status === 'playing') r.startGrace(i);
    r.bc({ t: 'presence', i, online: false, left: r.status === 'playing' ? GRACE : 0 });
    persist();
  }
}
const pending = new Set();
setInterval(() => {
  const now = Date.now();
  for (const c of new Set([...conns.values(), ...pending])) {
    if (now - c.last > 15000) c.close(); else c.raw(9, Buffer.alloc(0));
  }
}, 5000).unref();

/* ───────────── Xử lý tin nhắn ───────────── */
const busyMsg = 'Bạn đang trong một trận chưa kết thúc';
function handle(c, m) {
  if (m.t === 'ping') return c.send({ t: 'pong', ts: m.ts });
  if (m.t === 'hello') {
    const pid = String(m.pid || '');
    if (!/^[\w-]{8,64}$/.test(pid)) return c.close();
    const old = conns.get(pid);
    c.pid = pid; pending.delete(c);
    conns.set(pid, c);
    if (old && old !== c) old.close();
    names.set(pid, cleanName(m.name));
    const st = validStyle(m.style); if (st) styles.set(pid, st);
    rebind(pid, c);
    if (st) applyStyle(pid, st);
    const r = rooms.get(pidRoom.get(pid));
    const active = r && r.status !== 'finished' && r.pidx(pid) >= 0 ? r.code : null;
    return c.send({ t: 'hello', u: ushort(pid), online: conns.size, stickers: listStickers(), active, now: Date.now() });
  }
  if (!c.pid) return;
  const pid = c.pid;
  const room = () => rooms.get(pidRoom.get(pid));

  switch (m.t) {
    case 'name': names.set(pid, cleanName(m.name)); break;
    case 'style': { const st = validStyle(m); if (st) applyStyle(pid, st); break; }
    case 'create': {
      const busy = guardExisting(pid);
      if (busy) return c.send({ t: 'err', c: 'busy', code: busy, m: busyMsg });
      const size = SIZES.includes(+m.size) ? +m.size : 15;
      const total = (TOTALS.includes(+m.total) ? +m.total : 5) * 60000 * TS;
      const turnMs = (TURNS.includes(+m.turn) ? +m.turn : 60) * 1000 * TS;
      const r = new Room(newCode(), size, total, turnMs, pid);
      rooms.set(r.code, r); r.addPlayer(pid);
      c.send({ t: 'created', code: r.code }); persist(); break;
    }
    case 'settings': {
      const r = room(); if (!r || r.host !== pid || r.status === 'playing') return;
      if (TOTALS.includes(+m.total)) r.total = +m.total * 60000;
      if (TURNS.includes(+m.turn)) r.turnMs = +m.turn * 1000;
      if (r.status === 'waiting' && SIZES.includes(+m.size)) r.size = +m.size;
      if (r.status === 'waiting') { r.newGame(); r.sendStates(); }
      else { r.bc({ t: 'settings', total: r.total, turnMs: r.turnMs }); }
      persist(); break;
    }
    case 'join': {
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r) return c.send({ t: 'err', c: 'noroom', m: 'Phòng không tồn tại hoặc đã đóng' });
      if (pidRoom.get(pid) !== r.code) {
        const busy = guardExisting(pid);
        if (busy) return c.send({ t: 'err', c: 'busy', code: busy, m: busyMsg });
      }
      const i = r.pidx(pid);
      if (i >= 0) {
        if (r.players[i].gone) return c.send({ t: 'err', c: 'noroom', m: 'Bạn đã rời phòng này' });
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
      let v, k;
      if (m.t === 'chat') {
        v = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300); k = 't';
        if (!v) return;
      } else {
        k = 's';
        if (m.data) {
          const name = saveAsset(m.data);
          if (!name) return c.send({ t: 'err', c: 'chat', m: 'Ảnh nhãn dán không hợp lệ hoặc quá lớn (tối đa ~250KB)' });
          v = 'a:' + name;
        } else {
          v = String(m.v || '');
          const ok = (v.startsWith('e:') && v.length <= 20 && Array.from(v.slice(2)).length <= 4) ||
                     (v.startsWith('i:') && listStickers().includes(v.slice(2)));
          if (!ok) return;
        }
      }
      const entry = { u: r.players[i].u, name: r.players[i].name, k, v, ts: now };
      r.chat.push(entry); if (r.chat.length > 300) r.chat.shift();
      r.bc({ t: 'chat', m: entry }); persist(); break;
    }
    case 'react': { // biểu tượng cảm xúc bay lên avatar (không lưu vào chat)
      const r = room(); if (!r) return;
      const i = r.pidx(pid); if (i < 0) return;
      const v = String(m.v || '');
      if (!(v.startsWith('e:') && v.length <= 20 && Array.from(v.slice(2)).length <= 4)) return;
      const now = Date.now();
      c.reactTimes = c.reactTimes.filter((t) => now - t < 4000);
      if (c.reactTimes.length >= 14) return;
      c.reactTimes.push(now);
      r.bc({ t: 'react', u: r.players[i].u, v }); break;
    }
    case 'resign': {
      const r = room(); if (!r) return;
      const i = r.pidx(pid);
      if (i >= 0 && r.status === 'playing') r.finish(1 - i, 'resign');
      break;
    }
    case 'undo': {
      const r = room(); if (!r) return;
      const e = r.requestUndo(pid);
      if (e) c.send({ t: 'err', c: 'undo', m: e });
      break;
    }
    case 'undoreply': {
      const r = room(); if (!r || !r.undoReq || r.pidx(pid) !== 1 - r.undoReq.by) return;
      r.endUndo(!!m.ok, 'declined'); break;
    }
    case 'reset': {
      const r = room(); if (!r || r.pidx(pid) < 0 || !r.canReset()) return;
      if (Date.now() - r.endedAt < RESET_MIN - 500) return c.send({ t: 'err', c: 'reset', m: 'Chờ thêm chút để xem lại ván nhé' });
      r.doReset(); break;
    }
    case 'leave': leave(pid); c.send({ t: 'left' }); break;
    case 'queue': {
      const busy = guardExisting(pid);
      if (busy) return c.send({ t: 'err', c: 'busy', code: busy, m: busyMsg });
      queue = queue.filter((q) => q !== pid && conns.has(q));
      const other = queue.shift();
      if (other) {
        const r = new Room(newCode(), 15, 5 * 60000, 60000, other); rooms.set(r.code, r);
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
  let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size, online: conns.size });
  if (p === '/api/games') {
    const u = url.searchParams.get('u') || '';
    const list = [...gameIndex.values()].filter((g) => g.players.some((x) => x.u === u)).sort((a, b) => b.endedAt - a.endedAt).slice(0, 200);
    return json(res, 200, list);
  }
  let m = p.match(/^\/api\/games\/([\w-]{6,20})$/);
  if (m) { const g = loadGame(m[1]); return g ? json(res, 200, g) : json(res, 404, { error: 'not found' }); }
  m = p.match(/^\/a\/([a-f0-9]{16}\.(png|webp|gif|jpg))$/);
  if (m) {
    return fs.readFile(path.join(ASSETS, m[1]), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME['.' + m[2]], 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
    });
  }
  const file = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
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
