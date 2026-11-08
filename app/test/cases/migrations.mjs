// MIG-01：每個遷移都能回滾，回滾後重新套用的結構與原本完全相同；全部回滾後沒有殘留
import { spawnSync } from 'node:child_process';
import { APP_DIR, DB_URL, resetDb } from '../lib/harness.mjs';
import { Recorder } from '../lib/recorder.mjs';

export async function mig01(n) {
  const rec = new Recorder('MIG-01', '資料庫遷移回滾驗證');
  for (let i = 0; i < n; i++) {
    const r = spawnSync(process.execPath, [APP_DIR + 'scripts/migrate.mjs', 'check'], { env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8' });
    const fails = r.status === 0 ? [] : ['migrate check failed: ' + (r.stderr || r.stdout).slice(-300)];
    let m = {};
    try { m = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* 失敗時沒有 JSON */ }
    rec.add(i, i, fails, m);
  }
  await resetDb();
  return rec.save();
}

// ---- MIG-02 以 M1 的資料執行遷移 0002 再回滾（M2-s P0-04，第二輪審核修正後的三個分支） ----
// (1) 純 M1 資料 → 遷移 → 編輯既有頁面的內容與標題、在同一個個人空間內移動 → 結構回滾成功，結構與遷移前相同、資料只多了這些編輯
// (2) 遷移後分別產生四類無法安全還原到 M1 的資料（共享空間、成員、跨空間搬移、新建頁面），每一類都讓 down 拒絕且資料不變
// (3) 從遷移前自動產生的備份還原 → 資料與結構與遷移前完全一致
import pg from 'pg';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MIG_DB = 'notes_mig02_test';
const SKIP = new Set(['schema_migrations', 'migration_0002', 'migration_0002_pages', 'spaces', 'space_members']);

async function snapshot(c) {
  const tables = (await c.query(`select tablename from pg_tables where schemaname='public' order by tablename`)).rows.map(r => r.tablename).filter(t => !SKIP.has(t));
  const out = {};
  for (const t of tables) {
    const rows = (await c.query(`select * from public."${t}"`)).rows.map(r => { const x = { ...r }; delete x.space_id; return JSON.stringify(x, (k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('base64') : v)); });
    out[t] = rows.sort();
  }
  return out;
}

export async function mig02(n) {
  const rec = new Recorder('MIG-02', '以 M1 資料遷移 0002：每頁歸建立者的個人空間；安全時可結構回滾；四類不安全資料讓回滾拒絕；可從遷移前備份完整還原');
  const u = new URL(DB_URL); u.pathname = '/' + MIG_DB;
  const url = u.toString();
  const admin = new URL(DB_URL); admin.pathname = '/postgres';
  for (let i = 0; i < n; i++) {
    const backupDir = mkdtempSync(join(tmpdir(), 'mig02-'));
    const mig = (...args) => spawnSync(process.execPath, [APP_DIR + 'scripts/migrate.mjs', ...args], { env: { ...process.env, DATABASE_URL: url, BACKUP_DIR: backupDir + '/' }, encoding: 'utf8' });
    const fp = () => { const r = mig('fingerprint'); return r.status === 0 ? r.stdout.trim().split('\n').pop() : 'ERR ' + r.stderr; };
    const fails = [];
    const m = {};
    let c = null;
    try {
      const a = new pg.Client({ connectionString: admin.toString() });
      await a.connect();
      await a.query(`drop database if exists "${MIG_DB}" with (force)`);
      await a.query(`create database "${MIG_DB}" template template0 encoding 'UTF8' lc_collate 'C.UTF-8' lc_ctype 'C.UTF-8'`);
      await a.end();
      // M1 結構：全部套用後回滾 0002（空資料庫可直接回滾）
      let r = mig('up'); if (r.status !== 0) throw new Error('up ' + r.stderr);
      r = mig('down', '2'); if (r.status !== 0) throw new Error('down to M1 ' + r.stderr);   // T-M2-14：回滾 0003、0002
      c = new pg.Client({ connectionString: url });
      await c.connect();
      // M1 資料：三個帳號（管理者最早）、頂層頁面各有子頁面、建立者已不存在的頁面、垃圾桶中的頁面、協作資料
      await c.query(`insert into workspaces(name) values ('M1')`);
      await c.query(`insert into "user"(id, name, email, email_verified, role, created_at, updated_at) values
        ('adm', '管理者', 'adm@m1.test', true, 'admin', now() - interval '3 day', now()),
        ('u1', '甲', 'u1@m1.test', true, 'member', now() - interval '2 day', now()),
        ('u2', '乙', 'u2@m1.test', true, 'member', now() - interval '1 day', now())`);
      const ws = (await c.query('select id from workspaces')).rows[0].id;
      const ins = async (title, parent, by, pos) => (await c.query(
        `insert into pages(workspace_id, parent_id, title, position, created_by) values ($1,$2,$3,$4,$5) returning id`,
        [ws, parent, title, pos, by])).rows[0].id;
      const tb = '00000000-0000-4000-8000-000000000001';
      const R1 = await ins('甲的頁面', null, 'u1', 'a0'), R1a = await ins('甲的子頁', R1, 'u2', 'a0'), R1b = await ins('甲的子頁二', R1, 'u1', 'a1');
      const R2 = await ins('乙的頁面', null, 'u2', 'a1'), R2a = await ins('乙的子頁', R2, 'u1', 'a0');
      const R3 = await ins('沒有建立者', null, null, 'a2'), R4 = await ins('管理者的頁面', null, 'adm', 'a3');
      await c.query(`update pages set deleted_at = now(), trash_batch = $1 where id = $2`, [tb, await ins('垃圾', null, 'u1', 'a4')]);
      const T = (await c.query('select id from pages where trash_batch = $1', [tb])).rows[0].id;
      for (const [k, p] of [R1, R2, R3].entries()) {
        await c.query('insert into doc_states(page_id, state, up_to_seq) values ($1, $2, 1)', [p, Buffer.from([1, 2, 3, k])]);
        await c.query(`insert into doc_updates(page_id, seq, data, user_id, kind) values ($1, 2, $2, 'u1', 'edit')`, [p, Buffer.from([9, k])]);
        await c.query(`insert into doc_update_ids(page_id, update_id, seq) values ($1, $2, 2)`, [p, 'm1-' + k]);
        await c.query('update pages set last_seq = 2 where id = $1', [p]);
      }
      const PRE = JSON.stringify(await snapshot(c)), PRE_FP = fp();
      // 遷移：每頁歸建立者的個人空間（頂層決定，子頁面跟著頂層；建立者不存在→最早的管理者）
      r = mig('up', '0002_spaces.sql');   // T-M2-14：只套用到 0002
      if (r.status !== 0) throw new Error('up with data ' + r.stderr);
      const backups = () => readdirSync(backupDir).filter(f => f.endsWith('.dump'));
      if (backups().length !== 1) fails.push('遷移前沒有自動產生備份 ' + backups().length);
      const sp = Object.fromEntries((await c.query(`select owner_id, id from spaces where kind='personal'`)).rows.map(x => [x.owner_id, x.id]));
      const want = { [R1]: 'u1', [R1a]: 'u1', [R1b]: 'u1', [R2]: 'u2', [R2a]: 'u2', [R3]: 'adm', [R4]: 'adm', [T]: 'u1' };
      for (const [pid, owner] of Object.entries(want)) {
        const got = (await c.query('select space_id from pages where id=$1', [pid])).rows[0].space_id;
        if (got !== sp[owner]) fails.push(`遷移後頁面 ${pid.slice(0, 8)} 的空間不正確`);
      }
      if ((await c.query(`select count(*)::int as n from space_members`)).rows[0].n !== 3) fails.push('遷移後成員列應只有三個個人空間的 owner');
      if (JSON.stringify(await snapshot(c)) !== PRE) fails.push('遷移改變了既有資料（內容、樹狀結構或協作資料）');

      // 分支 (1)：編輯既有頁面的內容與標題、在同一個個人空間內移動 → 可以結構回滾
      await c.query(`update pages set title = '改過的標題' where id = $1`, [R1]);
      await c.query(`insert into doc_updates(page_id, seq, data, user_id, kind) values ($1, 3, $2, 'u1', 'edit')`, [R1, Buffer.from([7, 7])]);
      await c.query(`insert into doc_update_ids(page_id, update_id, seq) values ($1, 'after-mig', 3)`, [R1]);
      await c.query(`update pages set last_seq = 3 where id = $1`, [R1]);
      await c.query(`update pages set parent_id = null, position = 'a5' where id = $1`, [R1b]);
      const EDITED = JSON.stringify(await snapshot(c));
      r = mig('down', '1');
      if (r.status !== 0) fails.push('分支 1：只有編輯時回滾被拒 ' + r.stderr.slice(-200));
      else {
        if (fp() !== PRE_FP) fails.push('分支 1：回滾後結構與遷移前不同');
        if (JSON.stringify(await snapshot(c)) !== EDITED) fails.push('分支 1：回滾後資料與回滾前不一致（編輯遺失或多出資料）');
        const pre = JSON.parse(PRE), now = JSON.parse(EDITED);
        const changed = Object.keys(pre).filter(t => JSON.stringify(pre[t]) !== JSON.stringify(now[t]));
        if (changed.sort().join(',') !== 'doc_update_ids,doc_updates,pages') fails.push('分支 1：回滾後與遷移前的差異不只是這些編輯：' + changed.join(','));
      }
      const BASE = JSON.stringify(await snapshot(c)), BASE_FP = fp();

      // 分支 (2)＋(3)：四類不安全資料，每一類都讓 down 拒絕且資料不變；再從遷移前備份還原
      const kinds = [
        ['共享空間', async () => {
          const s = (await c.query(`insert into spaces(kind, name, owner_id) values ('shared', '共享', 'u1') returning id`)).rows[0].id;
          await c.query(`insert into space_members(space_id, user_id, role) values ($1, 'u1', 'owner')`, [s]);
        }],
        ['共享空間的成員', async () => {
          const s = (await c.query(`insert into spaces(kind, name, owner_id) values ('shared', '共享', 'u1') returning id`)).rows[0].id;
          await c.query(`insert into space_members(space_id, user_id, role) values ($1, 'u1', 'owner'), ($1, 'u2', 'member')`, [s]);
        }],
        ['搬移過空間的頁面', async () => {
          const to = (await c.query(`select id from spaces where owner_id='u1' and kind='personal'`)).rows[0].id;
          await c.query(`update pages set space_id = $1 where id in ($2, $3)`, [to, R2, R2a]);
        }],
        ['遷移後建立的頁面', async () => {
          const s = (await c.query(`select id from spaces where owner_id='u2' and kind='personal'`)).rows[0].id;
          await c.query(`insert into pages(workspace_id, space_id, title, position, created_by) values ($1, $2, '私人的新頁面', 'b0', 'u2')`, [ws, s]);
        }],
      ];
      m.kinds = {};
      for (const [label, make] of kinds) {
        const had = new Set(backups());
        r = mig('up', '0002_spaces.sql');   // T-M2-14：只套用到 0002
        if (r.status !== 0) { fails.push(`${label}：重新遷移失敗 ` + r.stderr.slice(-200)); continue; }
        const bk = backups().find(f => !had.has(f));
        if (!bk) { fails.push(`${label}：重新遷移前沒有產生新的備份`); continue; }
        await make();
        const before = JSON.stringify(await snapshot(c)), beforeFp = fp();
        const before2 = JSON.stringify((await c.query('select * from spaces order by id')).rows) + JSON.stringify((await c.query('select * from space_members order by space_id, user_id')).rows);
        r = mig('down', '1');
        const msg = (r.stderr || '') + (r.stdout || '');
        if (r.status === 0) fails.push(`${label}：down 沒有拒絕`);
        else if (!msg.includes('unsafe_rollback') || !msg.includes(label) || !msg.includes('備份還原')) fails.push(`${label}：拒絕訊息沒有說明原因與備份還原 ` + msg.slice(-200));
        const after2 = JSON.stringify((await c.query('select * from spaces order by id')).rows) + JSON.stringify((await c.query('select * from space_members order by space_id, user_id')).rows);
        if (JSON.stringify(await snapshot(c)) !== before || fp() !== beforeFp || after2 !== before2) fails.push(`${label}：down 被拒後資料或結構被改變`);
        // (3) 從這次遷移前的備份還原 → 與遷移前完全一致
        await c.end(); c = null;
        r = mig('restore', join(backupDir, bk));
        c = new pg.Client({ connectionString: url });
        await c.connect();
        if (r.status !== 0) { fails.push(`${label}：備份還原失敗 ` + r.stderr.slice(-200)); continue; }
        if (fp() !== BASE_FP) fails.push(`${label}：備份還原後結構與遷移前不同`);
        if (JSON.stringify(await snapshot(c)) !== BASE) fails.push(`${label}：備份還原後資料與遷移前不同`);
        const applied = (await c.query('select name from schema_migrations order by name')).rows.map(x => x.name);
        if (applied.includes('0002_spaces.sql')) fails.push(`${label}：備份還原後仍記錄 0002 已套用`);
        m.kinds[label] = 'ok';
      }
      m.backups = backups().length;
    } catch (e) {
      fails.push('exception: ' + e.message);
    } finally {
      if (c) await c.end().catch(() => {});
      rmSync(backupDir, { recursive: true, force: true });
    }
    rec.add(i, i, fails, m);
  }
  const a = new pg.Client({ connectionString: admin.toString() });
  await a.connect();
  await a.query(`drop database if exists "${MIG_DB}" with (force)`).catch(() => {});
  await a.end();
  return rec.save();
}
