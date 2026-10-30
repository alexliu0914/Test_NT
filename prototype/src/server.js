// M0 協作伺服器原型
// 核心規則：
//  1. 每份文件只有一條處理佇列（Room.enqueue）；連線初始化、一般編輯、版本還原都依序通過。
//  2. 更新先在一個資料庫交易中寫入，提交成功後才套用到伺服器文件、廣播給其他連線、回覆確認。
//  3. update_id 由用戶端以 UUID 配發；doc_update_ids 以 (page_id, update_id) 為主鍵去重。
//  4. 還原是佇列中的一個項目，與一般編輯共用 seq；restore_id 冪等。
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as Y from 'yjs';
import { replaceFragmentsFrom, docJSON } from './doc.js';

const PORT = Number(process.env.PORT || 47000);
const DATABASE_URL = process.env.DATABASE_URL;
const FAULT_POINT = process.env.FAULT_POINT || '';
const BATCH_MS = Number(process.env.BATCH_MS || 20);
const COMPACT_EVERY = Number(process.env.COMPACT_EVERY || 200);
const SESSION_RECHECK_MS = Number(process.env.SESSION_RECHECK_MS || 60000);
// 背壓：每份文件待寫入的更新上限；超過時回覆 busy，用戶端保留在待確認清單並稍後重送
const MAX_INBOX = Number(process.env.MAX_INBOX || 2000);
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const REMOTE = 'server';

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
pool.on('error', e => log('pool error', e.message));

// 取出連線時掛上錯誤處理：交易進行中連線被終止，pg 會在連線物件上發出 error 事件，
// 沒有監聽者會讓整個行程當掉（M0-02 第一次正式執行發現的缺陷 F-02）
async function checkout() {
  const c = await pool.connect();
  if (!c.__m0ErrorHandled) {
    c.on('error', e => log('client error', e.message));
    c.__m0ErrorHandled = true;
  }
  return c;
}

function log(...a) { if (process.env.SERVER_LOG) console.error('[server]', ...a); }

// 故障注入點：設定 FAULT_POINT 時，第 FAULT_AFTER 次執行到該位置就以 SIGKILL 結束自己（等同 kill -9）
const FAULT_AFTER = Number(process.env.FAULT_AFTER || 1);
let faultHits = 0;
function faultPoint(name) {
  if (FAULT_POINT === name && ++faultHits >= FAULT_AFTER) process.kill(process.pid, 'SIGKILL');
}

const b64 = u => Buffer.from(u).toString('base64');
const fromB64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Room {
  constructor(id) {
    this.id = id;
    this.ydoc = null;
    this.seq = 0;
    this.epoch = 0;
    this.conns = new Set();
    this.queue = Promise.resolve();
    this.inbox = [];
    this.flushScheduled = false;
    this.sinceCompact = 0;
  }
  enqueue(fn) {
    const p = this.queue.then(fn);
    this.queue = p.catch(e => log('queue item failed', e.message));
    return p;
  }
}

const rooms = new Map();

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = new Room(id);
    rooms.set(id, r);
    r.enqueue(() => loadRoom(r));
  }
  return r;
}

// 監控用統計：資料庫連續失敗的起始時間、背壓觸發次數、待寫入佇列的最大長度
const stats = { dbDownSince: null, busy: 0, maxInbox: 0, retries: 0 };

// 資料庫錯誤一律重試、不丟棄更新（未提交的更新不會被確認，所以不會有假的「已儲存」）。
// 記憶體由 MAX_INBOX 背壓限制；資料庫持續失效的時間由 /health 的 dbDownSince 對外揭露，供監控告警。
async function withRetry(fn) {
  let delay = 20;
  for (;;) {
    try { const r = await fn(); stats.dbDownSince = null; return r; } catch (e) {
      stats.dbDownSince ||= new Date().toISOString();
      stats.retries++;
      log('db error, retrying', e.message);
      await sleep(delay);
      delay = Math.min(delay * 2, 400);
    }
  }
}

async function loadRoom(room) {
  await withRetry(async () => {
    const c = await checkout();
    try {
      await c.query('insert into pages(id) values ($1) on conflict do nothing', [room.id]);
      const p = (await c.query('select restore_epoch, last_seq from pages where id=$1', [room.id])).rows[0];
      const st = (await c.query('select state, up_to_seq from doc_states where page_id=$1', [room.id])).rows[0];
      const ups = (await c.query(
        'select seq, data from doc_updates where page_id=$1 and seq > $2 order by seq',
        [room.id, st ? st.up_to_seq : 0])).rows;
      const ydoc = new Y.Doc();
      if (st) Y.applyUpdate(ydoc, new Uint8Array(st.state), REMOTE);
      for (const u of ups) Y.applyUpdate(ydoc, new Uint8Array(u.data), REMOTE);
      room.ydoc = ydoc;
      room.seq = Number(p.last_seq);
      room.epoch = p.restore_epoch;
    } finally { c.release(); }
  });
}

function send(conn, msg) {
  if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg));
}

// ---- 一般編輯：批次寫入 ----
function scheduleFlush(room) {
  if (room.flushScheduled) return;
  room.flushScheduled = true;
  setTimeout(() => {
    room.flushScheduled = false;
    room.enqueue(() => flush(room));
  }, BATCH_MS);
}

async function flush(room) {
  const items = room.inbox;
  room.inbox = [];
  if (items.length === 0) return;
  // 失敗時整批重試，佇列後面的項目會等待，順序不變
  const result = await withRetry(async () => {
    const c = await checkout();
    let failed = false;
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [room.id]);
      let seq = room.seq;
      const inserted = [];
      const seenInBatch = new Set();
      for (const it of items) {
        const ids = [it.updateId, ...(it.covers || [])];
        const existing = new Set((await c.query(
          'select update_id from doc_update_ids where page_id=$1 and update_id = any($2)',
          [room.id, ids])).rows.map(r => r.update_id));
        const fresh = ids.filter(id => !existing.has(id) && !seenInBatch.has(id));
        fresh.forEach(id => seenInBatch.add(id));
        it.ackIds = ids;
        if (fresh.length === 0) { it.duplicate = true; continue; }
        seq += 1;
        await c.query('insert into doc_updates(page_id, seq, data, user_id, kind) values ($1,$2,$3,$4,$5)',
          [room.id, seq, Buffer.from(it.data), it.userId, 'edit']);
        await c.query(
          'insert into doc_update_ids(page_id, update_id, seq) select $1, unnest($2::text[]), $3',
          [room.id, fresh, seq]);
        it.seq = seq;
        inserted.push(it);
      }
      await c.query('update pages set last_seq=$2 where id=$1', [room.id, seq]);
      faultPoint('flush:before_commit');
      await c.query('commit');
      return { seq, inserted };
    } catch (e) {
      failed = true;
      try { await c.query('rollback'); } catch { /* 連線可能已被終止 */ }
      throw e;
    } finally { c.release(failed); }
  });
  faultPoint('flush:after_commit');
  room.seq = result.seq;
  // 提交成功後：依序套用、廣播給其他連線、回覆確認
  for (const it of result.inserted) {
    Y.applyUpdate(room.ydoc, it.data, REMOTE);
    for (const other of room.conns) {
      if (other !== it.conn) send(other, { t: 'remote', data: b64(it.data), seq: it.seq });
    }
  }
  for (const it of items) send(it.conn, { t: 'ack', ids: it.ackIds, seq: room.seq });
  room.sinceCompact += result.inserted.length;
  if (room.sinceCompact >= COMPACT_EVERY) await compact(room);
}

// 合併：把目前完整狀態寫入 doc_states，刪除已合併的增量更新（doc_update_ids 保留作為去重）
async function compact(room) {
  await withRetry(async () => {
    const c = await checkout();
    let failed = false;
    try {
      await c.query('begin');
      await c.query(`insert into doc_states(page_id, state, up_to_seq) values ($1,$2,$3)
        on conflict (page_id) do update set state=excluded.state, up_to_seq=excluded.up_to_seq, updated_at=now()`,
        [room.id, Buffer.from(Y.encodeStateAsUpdate(room.ydoc)), room.seq]);
      faultPoint('compact:mid');
      await c.query('delete from doc_updates where page_id=$1 and seq <= $2', [room.id, room.seq]);
      await c.query('commit');
    } catch (e) {
      failed = true;
      try { await c.query('rollback'); } catch { /* ignore */ }
      throw e;
    } finally { c.release(failed); }
  });
  room.sinceCompact = 0;
}

// ---- 版本 ----
async function makeVersion(room, conn, versionId) {
  await withRetry(() => pool.query(
    `insert into page_versions(id, page_id, state, up_to_seq, reason) values ($1,$2,$3,$4,'auto')
     on conflict do nothing`,
    [versionId, room.id, Buffer.from(Y.encodeStateAsUpdate(room.ydoc)), room.seq]));
  send(conn, { t: 'version_ok', versionId, json: docJSON(room.ydoc) });
}

// ---- 版本還原 ----
async function restore(room, conn, restoreId, versionId) {
  const done = (await withRetry(() => pool.query(
    'select status from restore_jobs where id=$1', [restoreId]))).rows[0];
  if (done) { send(conn, { t: 'restore_result', restoreId, status: 'already_applied' }); return; }
  const v = (await withRetry(() => pool.query(
    'select state from page_versions where id=$1 and page_id=$2', [versionId, room.id]))).rows[0];
  if (!v) { send(conn, { t: 'restore_result', restoreId, status: 'no_such_version' }); return; }
  const vdoc = new Y.Doc();
  Y.applyUpdate(vdoc, new Uint8Array(v.state));
  // 在複本上計算還原更新，不先改動線上文件
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(room.ydoc));
  const sv = Y.encodeStateVector(clone);
  // 以一般 CRDT 編輯把每個根片段（簡化模型的 blocks、BlockNote 的 document-store）換成目標版本的內容
  clone.transact(() => replaceFragmentsFrom(clone, vdoc));
  const upd = Y.encodeStateAsUpdate(clone, sv);
  faultPoint('restore:before_tx');
  const r = await withRetry(async () => {
    const c = await checkout();
    let failed = false;
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [room.id]);
      const again = (await c.query('select 1 from restore_jobs where id=$1', [restoreId])).rows[0];
      if (again) { await c.query('rollback'); return { already: true }; }
      const seq = room.seq + 1;
      const beforeId = 'br-' + restoreId;
      await c.query(`insert into page_versions(id, page_id, state, up_to_seq, reason, restore_id)
        values ($1,$2,$3,$4,'before_restore',$5)`,
        [beforeId, room.id, Buffer.from(Y.encodeStateAsUpdate(room.ydoc)), room.seq, restoreId]);
      await c.query('insert into doc_updates(page_id, seq, data, user_id, kind) values ($1,$2,$3,$4,$5)',
        [room.id, seq, Buffer.from(upd), conn.userId, 'restore']);
      await c.query('insert into doc_update_ids(page_id, update_id, seq) values ($1,$2,$3)',
        [room.id, 'restore:' + restoreId, seq]);
      faultPoint('restore:mid_tx');
      await c.query(`insert into restore_jobs(id, page_id, target_version_id, before_version_id, status, seq, applied_at)
        values ($1,$2,$3,$4,'applied',$5, now())`, [restoreId, room.id, versionId, beforeId, seq]);
      const ep = (await c.query(
        'update pages set restore_epoch = restore_epoch + 1, last_seq=$2 where id=$1 returning restore_epoch',
        [room.id, seq])).rows[0].restore_epoch;
      faultPoint('restore:before_commit');
      await c.query('commit');
      return { seq, epoch: ep };
    } catch (e) {
      failed = true;
      try { await c.query('rollback'); } catch { /* ignore */ }
      throw e;
    } finally { c.release(failed); }
  });
  if (r.already) { send(conn, { t: 'restore_result', restoreId, status: 'already_applied' }); return; }
  faultPoint('restore:after_commit');
  Y.applyUpdate(room.ydoc, upd, REMOTE);
  room.seq = r.seq;
  room.epoch = r.epoch;
  for (const c2 of room.conns) {
    send(c2, { t: 'remote', data: b64(upd), seq: r.seq, restore: { restoreId, epoch: r.epoch } });
  }
  faultPoint('restore:after_broadcast');
  send(conn, { t: 'restore_result', restoreId, status: 'applied', seq: r.seq });
}

// ---- 衝突副本 ----
async function saveConflictCopy(room, conn, m) {
  await withRetry(() => pool.query(
    `insert into conflict_copies(id, page_id, user_id, based_epoch, state, content_json)
     values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
    [m.copyId, room.id, conn.userId, m.basedEpoch, Buffer.from(fromB64(m.state)), m.json]));
  send(conn, { t: 'cc_ack', copyId: m.copyId });
}

// ---- HTTP：健康檢查、測試頁靜態檔、匯出 ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mp3': 'audio/mpeg', '.map': 'application/json' };

async function authorized(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return null;
  const r = await pool.query('select user_id from sessions where id=$1', [token]);
  return r.rows[0] ? r.rows[0].user_id : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: stats.dbDownSince === null, ...stats, rooms: rooms.size }));
    }
    if (url.pathname.startsWith('/api/export/')) {
      if (!(await authorized(req))) { res.writeHead(401); return res.end(); }
      const room = getRoom(decodeURIComponent(url.pathname.slice('/api/export/'.length)));
      const state = await room.enqueue(() => Y.encodeStateAsUpdate(room.ydoc));
      const { exportPage } = await import('./export.js');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(await exportPage(room.id, state)));
    }
    if (url.pathname.startsWith('/api/files/')) {
      // 原型：所有 fileId 都回傳同一個測試音檔（正式版改為驗證登入後發出 R2 短效網址）
      const data = await readFile(new URL('../test/fixtures/sample.mp3', import.meta.url));
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'accept-ranges': 'none', 'cache-control': 'no-store' });
      return res.end(data);
    }
    if (url.pathname.startsWith('/web/')) {
      const rel = url.pathname.slice(5).replace(/\.\./g, '');
      const data = await readFile(WEB_DIR + rel);
      const ext = rel.slice(rel.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(data);
    }
    res.writeHead(404); res.end();
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500); res.end(String(e.message));
  }
});

// ---- 連線 ----
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  const conn = { ws, room: null, userId: null, sessionId: null, joined: false };
  ws.on('message', async raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!conn.room) {
      if (m.t !== 'hello') return ws.close(4000, 'hello expected');
      const s = (await withRetry(() => pool.query('select user_id from sessions where id=$1', [m.token]))).rows[0];
      if (!s) return ws.close(4001, 'unauthorized');
      conn.userId = s.user_id;
      conn.sessionId = m.token;
      const room = getRoom(m.docId);
      conn.room = room;
      room.enqueue(() => {
        if (ws.readyState !== 1) return;
        room.conns.add(conn);
        conn.joined = true;
        // 先送 restore_epoch 與狀態；用戶端在套用前自行判斷是否需要先存衝突副本
        send(conn, { t: 'welcome', epoch: room.epoch, seq: room.seq, state: b64(Y.encodeStateAsUpdate(room.ydoc)) });
      });
      return;
    }
    const room = conn.room;
    switch (m.t) {
      case 'update':
        if (room.inbox.length >= MAX_INBOX) {
          stats.busy++;
          send(conn, { t: 'busy', ids: [m.id], retryAfterMs: 300 + Math.floor(Math.random() * 400) });
          break;
        }
        room.inbox.push({ conn, updateId: m.id, covers: m.covers, data: fromB64(m.data), userId: conn.userId });
        stats.maxInbox = Math.max(stats.maxInbox, room.inbox.length);
        scheduleFlush(room);
        break;
      case 'restore':
        room.enqueue(() => restore(room, conn, m.restoreId, m.versionId));
        break;
      case 'make_version':
        room.enqueue(() => makeVersion(room, conn, m.versionId));
        break;
      case 'conflict_copy':
        room.enqueue(() => saveConflictCopy(room, conn, m));
        break;
      default:
        break;
    }
  });
  ws.on('close', () => { if (conn.room) conn.room.conns.delete(conn); });
  ws.on('error', () => {});
});

// 撤銷登入：收到通知立即中斷該 session 的所有連線；另有定期複查作為保險
function closeSession(sessionId) {
  for (const room of rooms.values()) {
    for (const conn of room.conns) {
      if (conn.sessionId === sessionId) conn.ws.close(4001, 'revoked');
    }
  }
  for (const ws of wss.clients) { /* 尚未加入房間的連線由 hello 驗證處理 */ }
}

async function listenRevocations() {
  for (;;) {
    try {
      const c = new pg.Client({ connectionString: DATABASE_URL });
      await c.connect();
      c.on('notification', n => closeSession(n.payload));
      await c.query('listen session_revoked');
      await new Promise((_, rej) => { c.on('error', rej); c.on('end', () => rej(new Error('end'))); });
    } catch (e) { log('listen error', e.message); await sleep(200); }
  }
}

setInterval(async () => {
  const ids = new Set();
  for (const room of rooms.values()) for (const c of room.conns) ids.add(c.sessionId);
  if (ids.size === 0) return;
  try {
    const alive = new Set((await pool.query('select id from sessions where id = any($1)', [[...ids]])).rows.map(r => r.id));
    for (const id of ids) if (!alive.has(id)) closeSession(id);
  } catch { /* 下一輪再查 */ }
}, SESSION_RECHECK_MS).unref();

listenRevocations();
server.listen(PORT, () => console.log('READY ' + PORT));
