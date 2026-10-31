// 資料庫遷移：migrations/*.sql（drizzle-kit 產生或手寫）依序套用；每個遷移都有 migrations/down/ 的回滾檔。
// 用法：
//   node scripts/migrate.mjs up            套用所有尚未套用的遷移
//   node scripts/migrate.mjs down [n]      回滾最後 n 個（預設 1）
//   node scripts/migrate.mjs check         回滾驗證（只能對 *_test 資料庫）：
//                                          全部套用 → 記下結構 → 由後往前逐一回滾再重新套用，結構必須相同；
//                                          全部回滾後不得殘留任何資料表、函式或觸發器
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import pg from 'pg';

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

async function up(c) {
  const done = new Set(await applied(c));
  for (const f of files) {
    if (done.has(f)) continue;
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

const [cmd = 'up', arg] = process.argv.slice(2);
try {
  await withClient(async c => {
    if (cmd === 'up') await up(c);
    else if (cmd === 'down') await down(c, Number(arg || 1));
    else if (cmd === 'check') await check(c);
    else throw new Error('未知指令 ' + cmd);
  });
} catch (e) { console.error(e.message); process.exit(1); }
