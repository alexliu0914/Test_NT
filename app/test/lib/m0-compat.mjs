// M0 核心測試（M0-01～11、M0-17）移植到 M1 的相容層：
// 同樣的測試邏輯，改為連 M1 的協作伺服器、使用正式的 session 資料表與 5 分鐘協作憑證、頁面必須存在於 pages。
import { randomBytes, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { WebSocketServer, WebSocket } from 'ws';
import { db, resetDb, setDbFault, terminateCollabConnections, CollabProc, sleep, SECRETS } from './harness.mjs';
import { Recorder, rng } from './recorder.mjs';
import { signCollabToken } from '../../shared/collab-token.mjs';
import { docFromUpdate, docJSON, tokensOf, tokensOfPlain } from '../../shared/doc.js';

export { db, setDbFault, sleep, Recorder, rng };
export const terminateServerConnections = terminateCollabConnections;
export const live = { clients: new Set(), servers: new Set(), proxies: new Set() };
export const between = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
export const setEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
export const setDiff = (a, b) => [...a].filter(x => !b.has(x));

export async function resetSchema() { await resetDb(); }

export async function waitFor(cond, timeout = 10000, label = 'condition') {
  const end = Date.now() + timeout;
  for (;;) { if (await cond()) return; if (Date.now() > end) throw new Error('timeout waiting for ' + label); await sleep(10); }
}

// 測試頁面：直接建立 pages 資料列（頁面樹 API 另有 PAGE 測試）
export async function newDocId() {
  const r = await db.query(`insert into pages(workspace_id, title, position) select id, 'm0', 'a0' from workspaces limit 1 returning id`);
  return r.rows[0].id;
}

// 以正式的 session 資料表建立登入（使用者視為已完成兩步驟驗證），回傳綁定此頁面的協作憑證
export async function newSession(userId, docId) {
  await db.query(`insert into "user"(id, name, email, email_verified, two_factor_enabled, role, created_at, updated_at)
    values ($1, $1, $1 || '@m0.test', true, true, 'member', now(), now()) on conflict (id) do nothing`, [userId]);
  const sid = randomUUID();
  await db.query(`insert into "session"(id, token, user_id, expires_at, created_at, updated_at) values ($1, $2, $3, now() + interval '30 days', now(), now())`,
    [sid, randomBytes(24).toString('hex'), userId]);
  return signCollabToken({ sid, uid: userId, pid: docId, ttlMs: 60 * 60 * 1000 }, SECRETS.COLLAB_SECRET);
}

const claims = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
export async function revoke(token) { await db.query('delete from "session" where id=$1', [claims(token).sid]); }

export class ServerProc extends CollabProc {
  constructor(port, env = {}) { super(port, env); live.servers.add(this); }
}

// 資料庫重建文件：doc_states ＋ 之後的 doc_updates（與伺服器相同規則）
export async function loadFromDb(docId) {
  const st = (await db.query('select state, up_to_seq from doc_states where page_id=$1', [docId])).rows[0];
  const ups = (await db.query('select data from doc_updates where page_id=$1 and seq > $2 order by seq', [docId, st ? st.up_to_seq : 0])).rows;
  const parts = [];
  if (st) parts.push(new Uint8Array(st.state));
  for (const u of ups) parts.push(new Uint8Array(u.data));
  const update = parts.length ? Y.mergeUpdates(parts) : Y.encodeStateAsUpdate(new Y.Doc());
  const doc = docFromUpdate(update);
  return { update, doc, json: docJSON(doc), tokens: tokensOf(doc) };
}

export async function versionTokens(docId, reason) {
  const rows = (await db.query('select state from page_versions where page_id=$1 and reason=$2', [docId, reason])).rows;
  const out = new Set();
  for (const r of rows) for (const t of tokensOf(docFromUpdate(new Uint8Array(r.state)))) out.add(t);
  return out;
}

export async function conflictCopyTokens(docId) {
  const rows = (await db.query('select content_json from conflict_copies where page_id=$1', [docId])).rows;
  const out = new Set();
  for (const r of rows) for (const t of tokensOfPlain(JSON.parse(r.content_json))) out.add(t);
  return { tokens: out, count: rows.length, rows };
}

// WebSocket 代理：可重放、丟棄、切斷（與 M0 相同）
export function startProxy(listenPort, targetPort, hooks = {}) {
  const wss = new WebSocketServer({ port: listenPort, host: '127.0.0.1' });
  const stats = { replays: 0, droppedAcks: 0, cuts: 0 };
  wss.on('connection', down => {
    const up = new WebSocket('ws://127.0.0.1:' + targetPort);
    const queue = [];
    const cut = () => { stats.cuts++; try { down.terminate(); } catch { /* */ } try { up.terminate(); } catch { /* */ } };
    up.on('open', () => { for (const q of queue) up.send(q); queue.length = 0; });
    down.on('message', d => {
      const s = d.toString();
      const outs = hooks.onClient ? hooks.onClient(JSON.parse(s), s, stats) : [s];
      for (const o of outs) { if (up.readyState === 1) up.send(o); else queue.push(o); }
    });
    up.on('message', d => {
      const s = d.toString();
      const act = hooks.onServer ? hooks.onServer(JSON.parse(s), stats) : 'pass';
      if (act === 'pass') { if (down.readyState === 1) down.send(s); } else if (act === 'drop_and_cut') { stats.droppedAcks++; cut(); }
    });
    down.on('close', () => { try { up.close(); } catch { /* */ } });
    up.on('close', (code, reason) => { try { down.close(code >= 4000 ? code : 1001, reason); } catch { /* */ } });
    down.on('error', () => {}); up.on('error', () => {});
  });
  const proxy = { stats, close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) };
  live.proxies.add(proxy);
  return proxy;
}

export async function quiesce(clients, timeout = 15000) {
  await waitFor(() => clients.every(c => c.ready && c.storage.pending.length === 0
    && c.storage.unackedCopies.length === 0 && c.storage.pendingRestores.length === 0 && !c.awaitingOfflineCopy), timeout, 'quiesce');
  await sleep(60);
  await waitFor(() => clients.every(c => c.ready && c.storage.pending.length === 0), timeout, 'quiesce-2');
}
