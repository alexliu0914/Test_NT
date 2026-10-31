// M1 測試共用工具：測試資料庫、啟動 Next.js 與協作伺服器（可 kill -9）、帶 cookie 的 HTTP 用戶端、TOTP
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

export const APP_DIR = new URL('../../', import.meta.url).pathname;
export const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/notes_test';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const db = new pg.Pool({ connectionString: DB_URL, max: 6, application_name: 'test' });
db.on('error', () => {});

// 測試專用的秘密值（每次執行隨機產生，不寫入任何檔案）
export const SECRETS = {
  BETTER_AUTH_SECRET: randomBytes(36).toString('base64'),
  COLLAB_SECRET: randomBytes(36).toString('base64'),
};

export function dbName(url = DB_URL) { return decodeURIComponent(new URL(url).pathname.slice(1)); }

// 防護：只對名稱以 _test 結尾、且有測試標記資料表的資料庫執行（M0 GATE-01 的同一規則）
export async function assertTestDatabase() {
  const name = dbName();
  if (!name.endsWith('_test')) throw new Error(`拒絕執行：資料庫 ${name} 不是測試資料庫（名稱必須以 _test 結尾）`);
  const r = await db.query(`select to_regclass('public.__notes_test_database') is not null as marked, (select datctype from pg_database where datname = current_database()) as ctype`);
  if (!r.rows[0].marked) throw new Error(`拒絕執行：資料庫 ${name} 沒有測試標記資料表 __notes_test_database（先執行 test/setup-test-db.sh）`);
  if (!/utf-?8/i.test(r.rows[0].ctype)) throw new Error(`拒絕執行：資料庫 ${name} 的 LC_CTYPE 不是 UTF-8`);
}

// 清空並重建結構：正式遷移＋測試專用的故障注入觸發器；建立工作區
export async function resetDb() {
  await assertTestDatabase();
  await db.query(`select pg_terminate_backend(pid) from pg_stat_activity
                   where datname = current_database() and pid <> pg_backend_pid() and application_name <> 'test'`);
  await db.query(`do $$ declare r record; begin
    for r in select tablename from pg_tables where schemaname='public' and tablename <> '__notes_test_database' loop
      execute 'drop table if exists public.' || quote_ident(r.tablename) || ' cascade'; end loop;
    for r in select p.oid::regprocedure as f from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
      execute 'drop function if exists ' || r.f || ' cascade'; end loop; end $$`);
  const m = spawnSync(process.execPath, [APP_DIR + 'scripts/migrate.mjs', 'up'], { env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8' });
  if (m.status !== 0) throw new Error('migrate failed: ' + m.stderr);
  await db.query(readFileSync(new URL('./faults.sql', import.meta.url), 'utf8'));
  await db.query(`insert into workspaces(name) values ('測試工作區')`);
}

export async function setDbFault(on) {
  await db.query(`insert into fault_flags(name, on_) values ('db_write_fail', $1) on conflict (name) do update set on_=excluded.on_`, [on]);
}

export async function terminateCollabConnections() {
  const r = await db.query(`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'collab' and pid <> pg_backend_pid()`);
  return r.rowCount;
}

// ---- 行程 ----
export const live = { procs: new Set() };

class Proc {
  constructor(name, args, env, readyRe) { Object.assign(this, { name, args, env, readyRe, proc: null }); live.procs.add(this); }
  start(extraEnv = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.args[0], this.args.slice(1), { cwd: APP_DIR, env: { ...process.env, ...this.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = p;
      let out = '', err = '', ready = false;
      const t = setTimeout(() => { if (!ready) reject(new Error(`${this.name} start timeout: ${err.slice(-400)}`)); }, 60000);
      const check = () => { if (!ready && this.readyRe.test(out)) { ready = true; clearTimeout(t); resolve(); } };
      p.stdout.on('data', d => { out = (out + d).slice(-8000); check(); if (process.env.SHOW_SERVER_LOG) process.stderr.write(d); });
      p.stderr.on('data', d => { err = (err + d).slice(-8000); if (process.env.SHOW_SERVER_LOG) process.stderr.write(d); });
      p.on('exit', (code, sig) => { clearTimeout(t); if (!ready) reject(new Error(`${this.name} exited before ready (code=${code} signal=${sig}): ${err.slice(-500)}`)); });
    });
  }
  exited() {
    return new Promise(res => { if (!this.proc || this.proc.exitCode !== null || this.proc.signalCode !== null) return res(); this.proc.once('exit', () => res()); });
  }
  async kill9() { if (!this.proc) return; try { this.proc.kill('SIGKILL'); } catch { /* 已結束 */ } await this.exited(); }
  async stop() { await this.kill9(); this.proc = null; }
}

// 協作伺服器（node collab/server.mjs）
export class CollabProc extends Proc {
  constructor(port, env = {}) {
    super('collab', [process.execPath, 'collab/server.mjs'], { PORT: String(port), DATABASE_URL: DB_URL, COLLAB_SECRET: SECRETS.COLLAB_SECRET, PG_APP_NAME: 'collab', ...env }, /READY/);
    this.port = port;
  }
  get url() { return `ws://127.0.0.1:${this.port}`; }
}

// Next.js 正式模式（需先 next build）
export class AppProc extends Proc {
  constructor(port, collabPort, env = {}) {
    super('web', [process.execPath, 'node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
      DATABASE_URL: DB_URL, BETTER_AUTH_URL: `http://127.0.0.1:${port}`, COLLAB_PUBLIC_URL: `ws://127.0.0.1:${collabPort}`,
      ...SECRETS, NODE_ENV: 'production', ...env,
    }, /Ready in|started server|Local:/);
    this.port = port;
  }
  get base() { return `http://127.0.0.1:${this.port}`; }
  async start(extraEnv) {
    await super.start(extraEnv);
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(this.base + '/api/health'); if (r.ok) return; } catch { /* 尚未就緒 */ }
      await sleep(100);
    }
    throw new Error('web health timeout');
  }
}

export async function stopAll() {
  for (const p of live.procs) await p.stop();
  live.procs.clear();
}

// ---- HTTP 用戶端（自行保存 cookie，模擬一個瀏覽器） ----
export class Agent {
  constructor(base, { origin } = {}) { this.base = base; this.cookies = new Map(); this.origin = origin ?? base; }
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
      const expired = attrs.some(a => /max-age=0/i.test(a)) || v === '';
      if (expired) this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  async req(method, path, body, { origin = this.origin, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = this.cookieHeader();
    if (origin) h.origin = origin;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(this.base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    this.store(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b = {}, o) { return this.req('POST', p, b, o); }
  patch(p, b = {}, o) { return this.req('PATCH', p, b, o); }
  del(p, o) { return this.req('DELETE', p, undefined, o); }
  // Playwright 用：把目前的 cookie 轉成 context.addCookies 的格式
  playwrightCookies() {
    const u = new URL(this.base);
    return [...this.cookies].map(([name, value]) => ({ name, value, domain: u.hostname, path: '/', httpOnly: true, sameSite: 'Lax', secure: false }));
  }
}

// ---- TOTP（RFC 6238，SHA-1、30 秒、6 位數），用來在測試中完成兩步驟驗證 ----
function base32Decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const v = alpha.indexOf(ch); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totp(secret, t = Date.now(), step = 30) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / step)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

// ---- 帳號流程 ----
export const PASSWORD = 'correct horse battery 42';

export function createAdmin(email, password = PASSWORD) {
  const r = spawnSync(process.execPath, [APP_DIR + 'node_modules/tsx/dist/cli.mjs', APP_DIR + 'scripts/create-admin.ts', '--email', email, '--name', '管理者'],
    { cwd: APP_DIR, env: { ...process.env, DATABASE_URL: DB_URL, ...SECRETS, ADMIN_PASSWORD: password }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('create-admin failed: ' + r.stderr + r.stdout);
}

export async function signIn(agent, email, password = PASSWORD, secret = null) {
  const r = await agent.post('/api/auth/sign-in/email', { email, password });
  if (r.status !== 200) return r;
  if (r.json?.twoFactorRedirect) {
    if (!secret) return r;
    return agent.post('/api/auth/two-factor/verify-totp', { code: totp(secret) });
  }
  return r;
}

export async function enableTwoFactor(agent, password = PASSWORD) {
  const e = await agent.post('/api/auth/two-factor/enable', { password });
  if (e.status !== 200) throw new Error('enable 2fa failed: ' + e.status + ' ' + e.text);
  const secret = new URL(e.json.totpURI).searchParams.get('secret');
  const v = await agent.post('/api/auth/two-factor/verify-totp', { code: totp(secret) });
  if (v.status !== 200) throw new Error('verify totp failed: ' + v.status + ' ' + v.text);
  return { secret, backupCodes: e.json.backupCodes };
}

// 建立一個已完成兩步驟驗證、已登入的使用者（管理者以指令建立，其餘以邀請連結）
export async function setupUsers(base, n = 2) {
  const users = [];
  const adminEmail = 'admin@example.test';
  createAdmin(adminEmail);
  const admin = new Agent(base);
  let r = await signIn(admin, adminEmail);
  if (r.status !== 200) throw new Error('admin sign-in failed ' + r.status + r.text);
  const a2 = await enableTwoFactor(admin);
  users.push({ email: adminEmail, agent: admin, ...a2, role: 'admin' });
  for (let i = 1; i < n; i++) {
    const email = `user${i}@example.test`;
    const inv = await admin.post('/api/invites', { email });
    if (inv.status !== 201) throw new Error('invite failed ' + inv.text);
    const token = new URL(inv.json.url).pathname.split('/').pop();
    const anon = new Agent(base);
    const acc = await anon.post(`/api/invites/${token}/accept`, { name: `使用者${i}`, password: PASSWORD });
    if (acc.status !== 201) throw new Error('accept failed ' + acc.text);
    const ag = new Agent(base);
    r = await signIn(ag, email);
    if (r.status !== 200) throw new Error('sign-in failed ' + r.text);
    const tf = await enableTwoFactor(ag);
    users.push({ email, agent: ag, ...tf, role: 'member' });
  }
  return users;
}

// 以已完成兩步驟驗證的帳號重新登入，得到新的 session（新的「裝置」）
export async function newDevice(base, u) {
  const ag = new Agent(base);
  const r = await signIn(ag, u.email, PASSWORD, u.secret);
  if (r.status !== 200) throw new Error('newDevice sign-in failed ' + r.status + r.text);
  return ag;
}

export async function newPage(agent, title = '測試頁') {
  const r = await agent.post('/api/pages', { title });
  if (r.status !== 201) throw new Error('create page failed ' + r.status + r.text);
  return r.json.page.id;
}

export async function collabToken(agent, pageId) {
  const r = await agent.post(`/api/pages/${pageId}/collab-token`);
  if (r.status !== 200) { const e = new Error('collab token ' + r.status); e.status = r.status; throw e; }
  return r.json.token;
}
