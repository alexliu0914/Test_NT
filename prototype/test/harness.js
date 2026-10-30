// 測試共用工具：資料庫、伺服器子行程（可 kill -9）、WebSocket 代理（重放／丟棄／切斷）、等待與紀錄
import pg from 'pg';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import { docFromUpdate, docJSON, tokensOf, tokensOfPlain } from '../src/doc.js';

export const ROOT_DIR = new URL('..', import.meta.url).pathname;
import { DB_URL, assertTestDatabase } from './testdb.js';
export { DB_URL };
export const db = new pg.Pool({ connectionString: DB_URL, max: 6 });

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// 每一輪建立的資源；由 cases.js 的 runIter 在該輪結束後清理
export const live = { clients: new Set(), servers: new Set(), proxies: new Set() };

export async function resetSchema() {
  await assertTestDatabase(db);
  await db.query(readFileSync(ROOT_DIR + 'src/schema.sql', 'utf8'));
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

export async function waitFor(cond, timeout = 10000, label = 'condition') {
  const end = Date.now() + timeout;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > end) throw new Error('timeout waiting for ' + label);
    await sleep(10);
  }
}

export async function newSession(userId) {
  const id = randomUUID();
  await db.query('insert into sessions(id, user_id) values ($1,$2)', [id, userId]);
  return id;
}

export async function revoke(sessionId) {
  await db.query('delete from sessions where id=$1', [sessionId]);
}

export async function setDbFault(on) {
  await db.query(`insert into fault_flags(name, on_) values ('db_write_fail', $1)
    on conflict (name) do update set on_=excluded.on_`, [on]);
}

export async function terminateServerConnections() {
  const r = await db.query(`select pg_terminate_backend(pid) from pg_stat_activity
    where application_name = 'collab' and pid <> pg_backend_pid()`);
  return r.rowCount;
}

// 依伺服器相同規則從資料庫重建文件（doc_states ＋ 之後的 doc_updates）
export async function loadFromDb(docId) {
  const st = (await db.query('select state, up_to_seq from doc_states where page_id=$1', [docId])).rows[0];
  const ups = (await db.query('select data from doc_updates where page_id=$1 and seq > $2 order by seq',
    [docId, st ? st.up_to_seq : 0])).rows;
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

// ---- 伺服器子行程 ----
export class ServerProc {
  constructor(port, env = {}) { this.port = port; this.env = env; this.proc = null; live.servers.add(this); }
  get url() { return 'ws://127.0.0.1:' + this.port; }
  start(env = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [ROOT_DIR + 'src/server.js'], {
        env: { ...process.env, PORT: String(this.port), DATABASE_URL: DB_URL + (DB_URL.includes('?') ? '&' : '?') + 'application_name=collab', ...this.env, ...env },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      this.proc = p;
      let buf = '';
      const t = setTimeout(() => reject(new Error('server start timeout')), 8000);
      p.stdout.on('data', d => {
        buf += d.toString();
        if (buf.includes('READY')) { clearTimeout(t); resolve(); }
      });
      p.on('exit', () => { clearTimeout(t); });
    });
  }
  exited() {
    return new Promise(res => {
      if (!this.proc || this.proc.exitCode !== null || this.proc.signalCode !== null) return res();
      this.proc.once('exit', () => res());
    });
  }
  async kill9() {
    if (!this.proc) return;
    try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
    await this.exited();
  }
  async stop() { await this.kill9(); this.proc = null; }
}

// ---- WebSocket 代理：可重放、丟棄、切斷 ----
export function startProxy(listenPort, targetPort, hooks = {}) {
  const wss = new WebSocketServer({ port: listenPort });
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

// 等所有用戶端連線就緒、沒有待確認修改、沒有未確認的衝突副本或還原請求
export async function quiesce(clients, timeout = 15000) {
  await waitFor(() => clients.every(c => c.ready && c.storage.pending.length === 0
    && c.storage.unackedCopies.length === 0 && c.storage.pendingRestores.length === 0 && !c.awaitingOfflineCopy),
    timeout, 'quiesce');
  await sleep(60);
  await waitFor(() => clients.every(c => c.ready && c.storage.pending.length === 0), timeout, 'quiesce-2');
}

export const setEq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
export const setDiff = (a, b) => [...a].filter(x => !b.has(x));

// ---- 紀錄 ----
export class Recorder {
  constructor(id, title, meta = {}) {
    this.r = { id, title, meta, startedAt: new Date().toISOString(), iterations: [] };
    this.t0 = Date.now();
  }
  add(i, seed, fails, metrics = {}) {
    this.r.iterations.push({ i, seed, pass: fails.length === 0, fails, metrics });
    const mark = fails.length ? 'FAIL' : 'ok';
    if (fails.length || i % 20 === 0) console.log(`${this.r.id} #${i} seed=${seed} ${mark} ${fails.slice(0, 3).join(' | ')}`);
  }
  save(extra = {}) {
    const it = this.r.iterations;
    Object.assign(this.r, extra, {
      durationMs: Date.now() - this.t0,
      total: it.length,
      passed: it.filter(x => x.pass).length,
      failed: it.filter(x => !x.pass).length,
    });
    mkdirSync(ROOT_DIR + 'results', { recursive: true });
    writeFileSync(ROOT_DIR + `results/${this.r.id}.json`, JSON.stringify(this.r, null, 1));
    console.log(`${this.r.id}: ${this.r.passed}/${this.r.total} passed (${Math.round(this.r.durationMs / 1000)}s)`);
    return this.r;
  }
}
