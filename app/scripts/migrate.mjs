// 資料庫遷移：migrations/*.sql（drizzle-kit 產生或手寫）依序套用；每個遷移都有 migrations/down/ 的回滾檔。
// 用法：
//   node scripts/migrate.mjs up [檔名]     套用所有尚未套用的遷移（給檔名時只套用到該遷移為止，例如 MIG-02 停在 0002）
//   node scripts/migrate.mjs down [n]      回滾最後 n 個（預設 1）
//   node scripts/migrate.mjs restore <檔案> 從遷移前的備份還原（清空目前資料庫後還原）
//   node scripts/migrate.mjs fingerprint   印出目前的結構指紋（JSON；MIG-02 用）
//   node scripts/migrate.mjs check         回滾驗證（只能對 *_test 資料庫）：
//                                          全部套用 → 記下結構 → 由後往前逐一回滾再重新套用，結構必須相同；
//                                          全部回滾後不得殘留任何資料表、函式或觸發器
import { readFileSync, readdirSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// 遷移前備份（M2-s P0-04）：檔案第一行為「-- requires-backup」的遷移，在已有資料的資料庫上套用前，
// 先以 pg_dump 備份並還原到暫存資料庫比對各表筆數與結構指紋；備份驗證失敗就不遷移。
// pg_dump／pg_restore 優先使用本機（或 PG_BIN 目錄）的；找不到時改用 docker compose 的 postgres 容器（Windows 開發環境）。
const APP = fileURLToPath(new URL('..', import.meta.url));
const BACKUP_DIR = process.env.BACKUP_DIR || APP + 'backups/';
const dbOf = u => decodeURIComponent(new URL(u).pathname.slice(1));
function pgTool(tool, args, { url: u, stdinFile, stdoutFile } = {}) {
  const native = process.env.PG_BIN ? process.env.PG_BIN.replace(/\/?$/, '/') + tool : tool;
  const io = () => [stdinFile ? openSync(stdinFile, 'r') : 'ignore', stdoutFile ? openSync(stdoutFile, 'w') : 'pipe', 'pipe'];
  const tryRun = (cmd, cmdArgs) => {
    const stdio = io();
    try { return spawnSync(cmd, cmdArgs, { stdio, encoding: 'utf8', cwd: APP }); }
    finally { for (const f of stdio) if (typeof f === 'number') closeSync(f); }
  };
  let r = tryRun(native, [...args, '--dbname=' + u]);
  // 找不到本機工具，或本機工具版本與伺服器不同：改用資料庫容器裡同版本的工具
  if ((r.error && r.error.code === 'ENOENT') || (r.status !== 0 && /version mismatch/i.test(r.stderr || ''))) {
    const parsed = new URL(u);
    r = tryRun('docker', ['compose', '-f', 'docker-compose.test.yml', 'exec', '-T', 'postgres', tool, '-U', decodeURIComponent(parsed.username || 'postgres'), ...args, '--dbname=' + dbOf(u)]);
    if (r.error) throw new Error(`找不到 ${tool}（本機或 docker compose 都無法執行）：${r.error.message}`);
  }
  if (r.status !== 0) throw new Error(`${tool} 失敗：${(r.stderr || '').slice(-500)}`);
  return r;
}
async function rowCounts(c) {
  const t = (await c.query(`select tablename from pg_tables where schemaname='public' order by tablename`)).rows.map(r => r.tablename);
  const out = {};
  for (const name of t) out[name] = Number((await c.query(`select count(*) from public."${name.replace(/"/g, '""')}"`)).rows[0].count);
  return out;
}
async function backupBefore(c, file) {
  const has = (await c.query(`select to_regclass('public."user"') is not null as t`)).rows[0].t
    && Number((await c.query('select (select count(*) from "user") + (select count(*) from pages) as n')).rows[0].n) > 0;
  if (!has) return null;   // 空的資料庫（全新安裝、測試重設）沒有需要備份的資料
  mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);   // 到毫秒，同一秒內連續遷移也不會覆蓋
  const out = `${BACKUP_DIR}${dbOf(url)}-${ts}-before-${file.replace(/\.sql$/, '')}.dump`;
  pgTool('pg_dump', ['-Fc', '--no-owner'], { url, stdoutFile: out });
  // 驗證：還原到暫存資料庫，比對各表筆數與結構指紋
  const tmp = `${dbOf(url)}_bkcheck_${ts}`.slice(0, 63);
  const admin = new URL(url); admin.pathname = '/postgres';
  const a = new pg.Client({ connectionString: admin.toString(), application_name: 'migrate' });
  await a.connect();
  try {
    await a.query(`create database "${tmp}" template template0`);
    const tu = new URL(url); tu.pathname = '/' + tmp;
    pgTool('pg_restore', ['--no-owner', '--exit-on-error'], { url: tu.toString(), stdinFile: out });
    const t = new pg.Client({ connectionString: tu.toString(), application_name: 'migrate' });
    await t.connect();
    try {
      const [ca, cb] = [JSON.stringify(await rowCounts(c)), JSON.stringify(await rowCounts(t))];
      const [fa, fb] = [JSON.stringify(await fingerprint(c)), JSON.stringify(await fingerprint(t))];
      if (ca !== cb || fa !== fb) throw new Error('備份還原後與原資料庫不一致，不遷移');
    } finally { await t.end(); }
  } finally {
    await a.query(`drop database if exists "${tmp}"`).catch(() => {});
    await a.end();
  }
  console.log('backup', out);
  return out;
}

const DIR = new URL('../migrations/', import.meta.url);
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL 未設定'); process.exit(1); }

const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
const statements = sql => sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);

async function withClient(fn) {
  const c = new pg.Client({ connectionString: url, application_name: 'migrate' });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function ensureTable(c) {
  await c.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
}

async function applied(c) {
  await ensureTable(c);
  return (await c.query('select name from schema_migrations order by name')).rows.map(r => r.name);
}

async function up(c, last = null) {
  if (last && !files.includes(last)) throw new Error('沒有這個遷移 ' + last);
  const done = new Set(await applied(c));
  for (const f of files) {
    if (last && f > last) break;
    if (done.has(f)) continue;
    if (readFileSync(new URL(f, DIR), 'utf8').startsWith('-- requires-backup')) await backupBefore(c, f);
    await c.query('begin');
    try {
      for (const s of statements(readFileSync(new URL(f, DIR), 'utf8'))) await c.query(s);
      await c.query('insert into schema_migrations(name) values ($1)', [f]);
      await c.query('commit');
      console.log('applied', f);
    } catch (e) { await c.query('rollback'); throw new Error(`${f}: ${e.message}`); }
  }
}

async function down(c, n = 1) {
  const done = await applied(c);
  for (const f of done.slice(-n).reverse()) {
    const p = new URL('down/' + f, DIR);
    if (!existsSync(p)) throw new Error('缺少回滾檔 migrations/down/' + f);
    await c.query('begin');
    try {
      for (const s of statements(readFileSync(p, 'utf8'))) await c.query(s);
      await c.query('delete from schema_migrations where name=$1', [f]);
      await c.query('commit');
      console.log('rolled back', f);
    } catch (e) { await c.query('rollback'); throw new Error(`down ${f}: ${e.message}`); }
  }
}

// 結構指紋：資料表、欄位、限制、索引、觸發器、函式（不含 schema_migrations）
async function fingerprint(c) {
  const q = async sql => (await c.query(sql)).rows.map(r => Object.values(r).join('|')).sort();
  return {
    columns: await q(`select table_name, column_name, data_type, is_nullable, coalesce(column_default,'') from information_schema.columns where table_schema='public' and table_name <> 'schema_migrations' and table_name not like '\\_\\_%'`),
    constraints: await q(`select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace and conrelid::regclass::text <> 'schema_migrations' and conrelid::regclass::text not like '\\_\\_%'`),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes where schemaname='public' and tablename <> 'schema_migrations' and tablename not like '\\_\\_%'`),
    triggers: await q(`select event_object_table, trigger_name, event_manipulation, action_statement from information_schema.triggers where trigger_schema='public'`),
    functions: await q(`select p.proname, pg_get_functiondef(p.oid) from pg_proc p where p.pronamespace='public'::regnamespace and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`),
  };
}

async function check(c) {
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith('_test')) throw new Error('拒絕執行：回滾驗證只能對 *_test 資料庫（目前 ' + name + '）');
  // 清空測試資料庫（保留測試標記資料表與擴充套件）
  await c.query(`do $$ declare r record; begin
    for r in select tablename from pg_tables where schemaname='public' and tablename not like '\\_\\_%' loop
      execute 'drop table if exists public.' || quote_ident(r.tablename) || ' cascade'; end loop;
    for r in select p.oid::regprocedure as f from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
      execute 'drop function if exists ' || r.f || ' cascade'; end loop; end $$`);
  await up(c);
  const full = JSON.stringify(await fingerprint(c));
  const results = [];
  for (let k = files.length; k >= 1; k--) {
    await down(c, files.length - k + 1);          // 回滾到第 k 個之前
    await up(c);                                   // 再全部套用
    const same = JSON.stringify(await fingerprint(c)) === full;
    results.push({ from: files[k - 1], restoredIdentical: same });
    if (!same) throw new Error('回滾後重新套用，結構與原本不同：' + files[k - 1]);
  }
  await down(c, files.length);
  const left = await fingerprint(c);
  const leftover = Object.entries(left).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.slice(0, 3).join(', ')}`);
  if (leftover.length) throw new Error('全部回滾後仍有殘留：' + leftover.join(' / '));
  await up(c);
  console.log(JSON.stringify({ migrations: files.length, results, emptyAfterFullRollback: true }));
}

// 從備份還原：清空目前資料庫的 public 物件，再以 pg_restore 還原（備份包含測試資料庫標記時一併還原）
async function restore(c, file) {
  if (!file || !existsSync(file)) throw new Error('找不到備份檔 ' + file);
  await c.query(`do $$ declare r record; begin
    for r in select tablename from pg_tables where schemaname='public' loop
      execute 'drop table if exists public.' || quote_ident(r.tablename) || ' cascade'; end loop;
    for r in select p.oid::regprocedure as f from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
      execute 'drop function if exists ' || r.f || ' cascade'; end loop; end $$`);
  pgTool('pg_restore', ['--no-owner', '--exit-on-error'], { url, stdinFile: file });
  console.log('restored', file);
}

const [cmd = 'up', arg] = process.argv.slice(2);
try {
  await withClient(async c => {
    if (cmd === 'up') await up(c, arg || null);
    else if (cmd === 'down') await down(c, Number(arg || 1));
    else if (cmd === 'check') await check(c);
    else if (cmd === 'restore') await restore(c, arg);
    else if (cmd === 'fingerprint') console.log(JSON.stringify(await fingerprint(c)));
    else throw new Error('未知指令 ' + cmd);
  });
} catch (e) { console.error(e.message); process.exit(1); }
