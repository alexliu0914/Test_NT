// VER-01（M2-c 附錄 B1、B2）：自動存版與版本保留。每一輪依序執行下列子情境（協作伺服器的掃描間隔縮短為 300 毫秒，
// 到期時間維持 10 分鐘，以把 dirty_since 往前調整的方式控制時間）：
//  B1 自動存版：停筆到期、未到期、無修改（開關頁面、重複更新）、重啟補存、存版交易失敗、兩台協作伺服器同時掃描、
//     既有存版相容（make_version 的 version_ok／version_error）、房間在時的競態、鎖等待（新更新、壓縮、補救）、還原後存版、時區
//  B2 保留：90 天清理與還原紀錄、還原與清理競態、清理先完成、清理後重送、restore_id 屬於其他頁面、清理中斷、頁面永久刪除優先
//  遷移 0003：異常引用停止、正常遷移與回滾、不安全回滾（含只刪未被引用版本的清理）、從備份還原
import * as Y from 'yjs';
import WS from 'ws';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '../../shared/client.js';
import { tokensOf, docFromUpdate, insertToken } from '../../shared/doc.js';
import { purgeVersions } from '../../shared/version-retention.js';
import { APP_DIR, DB_URL } from '../lib/harness.mjs';
import { db, ServerProc, newSession, loadFromDb, quiesce, waitFor, sleep, rng, Recorder, live, newDocId, resetSchema } from '../lib/m0-compat.mjs';

const PORT = 27120, PORT2 = 27121;
const DUE_S = 600;                 // 10 分鐘
const SRV_ENV = { VERSION_SWEEP_MS: '300' };

function NewClient(opts) { const c = new Client({ WebSocketImpl: WS, ...opts }); live.clients.add(c); return c; }
async function mkClient(url, docId, user, rnd) {
  return NewClient({ url, docId, token: await newSession(user, docId), userId: user, name: user, rnd });
}
async function cleanupLive() {
  for (const c of live.clients) c.disconnect();
  live.clients.clear();
  for (const s of live.servers) await s.stop();
  live.servers.clear();
}
const within = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error('timeout waiting for ' + label); })]);
const pageRow = async id => (await db.query('select last_seq::int, snap_seq::int, dirty_since, restore_epoch from pages where id=$1', [id])).rows[0];
const versions = async (id, where = 'true') => (await db.query(`select id, up_to_seq::int, reason, source, state, created_at from page_versions where page_id=$1 and ${where} order by created_at, id`, [id])).rows;
const backdate = (id, secs) => db.query('update pages set dirty_since = now() - make_interval(secs => $2) where id=$1', [id, secs]);
const tokSet = state => tokensOf(docFromUpdate(new Uint8Array(state)));
const eqSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

// 資料庫在某個 seq 的文件（doc_states 加上 seq 之前的更新；只在沒有壓縮過 up_to_seq 之後的資料時可用）
async function tokensAtSeq(id, seq) {
  const st = (await db.query('select state, up_to_seq::int from doc_states where page_id=$1', [id])).rows[0];
  if (st && st.up_to_seq > seq) return null;
  const ups = (await db.query('select data from doc_updates where page_id=$1 and seq > $2 and seq <= $3 order by seq', [id, st ? st.up_to_seq : 0, seq])).rows;
  const parts = [...(st ? [new Uint8Array(st.state)] : []), ...ups.map(u => new Uint8Array(u.data))];
  return tokensOf(docFromUpdate(parts.length ? Y.mergeUpdates(parts) : Y.encodeStateAsUpdate(new Y.Doc())));
}

// 每個版本的內容必須與自己的 up_to_seq 時的資料庫狀態相同
async function checkConsistent(fails, tag, id) {
  for (const v of await versions(id, "reason <> 'before_restore'")) {
    const at = await tokensAtSeq(id, v.up_to_seq);
    if (at && !eqSet(at, tokSet(v.state))) fails.push(`${tag}版本 ${v.id}（${v.source}，seq ${v.up_to_seq}）內容與當時的資料庫狀態不同`);
  }
}

// 協作伺服器的交易等待鎖（pg_stat_activity）
async function collabWaitingLock() {
  return Number((await db.query(`select count(*) from pg_stat_activity where application_name = 'collab' and wait_event_type = 'Lock'`)).rows[0].count) > 0;
}
async function collabIdleInTx() {
  return Number((await db.query(`select count(*) from pg_stat_activity where application_name = 'collab' and state = 'idle in transaction'`)).rows[0].count) > 0;
}

async function startServer(env = {}, port = PORT) {
  const s = new ServerProc(port, { ...SRV_ENV, ...env });
  await s.start();
  return s;
}

async function typed(url, docId, user, toks, rnd) {
  const c = await mkClient(url, docId, user, rnd);
  c.connect();
  await quiesce([c]);
  for (const t of toks) c.type(t);
  await quiesce([c]);
  return c;
}

const scheduleCount = async id => (await versions(id, "source = 'schedule'")).length;

export async function ver01(n) {
  const rec = new Recorder('VER-01', '自動存版與版本保留：停筆到期、重啟補存、失敗回滾、去重、既有存版相容、鎖等待、還原後存版；90 天清理、還原與清理競態、永久刪除優先；遷移 0003 的安全回滾');
  await resetSchema();
  for (let i = 0; i < n; i++) {
    const seed = 140000 + i;
    const rnd = rng(seed);
    const fails = [], m = {};
    // 時區：偶數輪 Asia/Taipei、奇數輪 UTC（協作伺服器與測試都以資料庫的 now() 判斷，結果應相同）
    const TZ = i % 2 === 0 ? 'Asia/Taipei' : 'UTC';
    try {
      await within(round(), 600000, 'round');
    } catch (e) { fails.push('exception: ' + e.message); }
    await cleanupLive();
    rec.add(i, seed, fails, m);

    async function round() {
      let S = await startServer({ TZ });
      const url = S.url;
      // ---- B1：停筆到期 ----
      const A = await newDocId();
      let c = await typed(url, A, 'ua', ['[a0]', '[a1]', '[a2]'], rnd);
      c.disconnect();
      let p = await pageRow(A);
      if (!p.dirty_since) fails.push('停筆：提交後 dirty_since 應已設定');
      await backdate(A, DUE_S - 10);
      await sleep(1500);
      if (await scheduleCount(A) !== 0) fails.push('未到期（9 分 50 秒）就存了版本');
      const before = (await pageRow(A)).dirty_since;
      await backdate(A, DUE_S + 1);
      await waitFor(async () => (await scheduleCount(A)) > 0, 5000, 'scheduled snapshot').catch(() => fails.push('停筆到期後沒有排程快照'));
      await sleep(1000);
      let vs = await versions(A, "source = 'schedule'");
      p = await pageRow(A);
      if (vs.length !== 1) fails.push(`停筆到期：排程快照 ${vs.length} 個（應為 1）`);
      if (vs[0] && vs[0].up_to_seq !== p.last_seq) fails.push(`停筆到期：up_to_seq ${vs[0].up_to_seq} ≠ last_seq ${p.last_seq}`);
      if (vs[0] && !eqSet(tokSet(vs[0].state), (await loadFromDb(A)).tokens)) fails.push('停筆到期：快照內容與資料庫不同');
      if (p.dirty_since !== null || p.snap_seq !== p.last_seq) fails.push('停筆到期：存版後 dirty_since 應清空、snap_seq 應等於 last_seq');
      m.dueBefore = !!before;

      // ---- B1：無修改（開關頁面、重複更新） ----
      c = await mkClient(url, A, 'ua', rnd);
      c.connect(); await quiesce([c]);
      const anyId = (await db.query('select update_id from doc_update_ids where page_id=$1 limit 1', [A])).rows[0].update_id;
      c.raw({ t: 'update', id: anyId, data: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString('base64') });
      await sleep(500);
      c.disconnect();
      p = await pageRow(A);
      if (p.dirty_since !== null) fails.push('無修改：開關頁面或重複更新後 dirty_since 被設定');
      if (p.last_seq !== p.snap_seq) fails.push('無修改：重複更新讓 last_seq 增加');

      // ---- B1：重啟補存 ----
      const R = await newDocId();
      c = await typed(url, R, 'ua', ['[r0]'], rnd);
      c.disconnect();
      await S.kill9();
      await backdate(R, DUE_S + 5);
      S = await startServer({ TZ });
      await waitFor(async () => (await scheduleCount(R)) > 0, 6000, 'snapshot after restart').catch(() => fails.push('重啟後沒有補存已到期的頁面'));
      await sleep(800);
      if (await scheduleCount(R) !== 1) fails.push(`重啟補存：排程快照 ${await scheduleCount(R)} 個（應為 1）`);

      // ---- B1：存版交易失敗（提交前 kill -9）→ 沒有半張版本、仍未快照；恢復後恰好 1 個 ----
      await S.stop();
      const F = await newDocId();
      S = await startServer({ TZ, FAULT_POINT: 'snapshot:before_commit' });
      c = await typed(S.url, F, 'ua', ['[f0]'], rnd);
      c.disconnect();
      await backdate(F, DUE_S + 1);
      await within(S.exited(), 8000, 'collab killed at snapshot:before_commit').catch(() => fails.push('故障點 snapshot:before_commit 沒有觸發'));
      live.servers.delete(S);
      if ((await versions(F)).length !== 0) fails.push('存版交易失敗：留下了版本');
      if (!(await pageRow(F)).dirty_since) fails.push('存版交易失敗：dirty_since 被清空');
      S = await startServer({ TZ });
      await waitFor(async () => (await scheduleCount(F)) === 1, 6000, 'snapshot after fault').catch(() => fails.push('存版交易失敗後恢復沒有存版'));

      // ---- B1：兩台協作伺服器同時掃描同一頁 → 每個 seq 最多 1 個排程快照 ----
      const D = await newDocId();
      c = await typed(S.url, D, 'ua', ['[d0]', '[d1]'], rnd);
      c.disconnect();
      const S2 = await startServer({ TZ }, PORT2);
      await backdate(D, DUE_S + 1);
      await waitFor(async () => (await scheduleCount(D)) > 0, 6000, 'dual sweep').catch(() => fails.push('兩台伺服器同時掃描時沒有存版'));
      await sleep(1500);
      if (await scheduleCount(D) !== 1) fails.push(`兩台伺服器同時掃描：排程快照 ${await scheduleCount(D)} 個（應為 1）`);
      await S2.stop(); live.servers.delete(S2);

      // ---- B1-P0：既有存版相容 ----
      c = await mkClient(S.url, D, 'ua', rnd);
      c.connect(); await quiesce([c]);
      const vid = 'm1-' + randomUUID();
      let res = await within(c.makeVersion(vid), 5000, 'make_version');
      const rowsAfter = await versions(D);
      const created = rowsAfter.find(v => v.id === vid);
      if (res.t !== 'version_ok' || !created) fails.push('既有存版：同水位的 make_version 沒有建立版本或沒有回 version_ok');
      if (created && (created.reason !== 'auto' || created.source !== 'request')) fails.push(`既有存版：make_version 的版本為 ${created.reason}/${created.source}（應為 auto/request）`);
      res = await within(c.makeVersion(vid), 5000, 'make_version resend');
      if (res.t !== 'version_ok' || (await versions(D)).length !== rowsAfter.length) fails.push('既有存版：同一個 ID 重送沒有回 version_ok 或重複建立');
      const foreignId = (await versions(A))[0].id;
      res = await within(c.makeVersion(foreignId), 5000, 'make_version conflict');
      if (res.t !== 'version_error' || (await versions(D)).length !== rowsAfter.length) fails.push('既有存版：其他頁面的版本 ID 沒有回 version_error 或建立了資料');
      c.type('[dm0]'); await quiesce([c]);   // 手動版落在沒有排程快照的新 seq
      const mid = 'man-' + randomUUID();
      res = await within(c.makeVersion(mid, { manual: true }), 5000, 'manual version');
      const man = (await versions(D)).find(v => v.id === mid);
      if (res.t !== 'version_ok' || !man || man.reason !== 'manual') fails.push('手動存版：沒有建立 reason=manual 的版本');
      // 沒有新更新卻有計時（例如計時欄位殘留）：到期時不存版、清除計時
      p = await pageRow(D);
      if (p.dirty_since !== null || p.snap_seq !== p.last_seq) fails.push('手動存版：存版後 snap_seq 應等於 last_seq、dirty_since 應清空');
      const nBefore = (await versions(D)).length;
      await backdate(D, DUE_S + 1);
      await sleep(1500);
      if ((await versions(D)).length !== nBefore) fails.push('沒有新更新：到期時仍多存了版本');
      if ((await pageRow(D)).dirty_since !== null) fails.push('沒有新更新：到期後計時沒有清除');

      // ---- B1：房間在時的競態（排程快照、手動存版、持續編輯同時發生）----
      const typedToks = [];
      let k = 0;
      const timer = setInterval(() => { const t = `[h${k++}]`; typedToks.push(t); c.type(t); }, 15);
      await sleep(200);
      await backdate(D, DUE_S + 1);
      const m2 = c.makeVersion('man-' + randomUUID(), { manual: true });
      await sleep(1200);
      clearInterval(timer);
      await within(m2, 5000, 'manual during race');
      await quiesce([c]);
      const perSeq = new Map();
      for (const v of await versions(D, "source = 'schedule'")) perSeq.set(v.up_to_seq, (perSeq.get(v.up_to_seq) || 0) + 1);
      if ([...perSeq.values()].some(x => x > 1)) fails.push('競態：同一個 seq 有多個排程快照');
      const dbt = (await loadFromDb(D)).tokens;
      const lost = typedToks.filter(t => !dbt.has(t));
      if (lost.length) fails.push('競態：編輯遺失 ' + lost.slice(0, 5).join(','));
      await checkConsistent(fails, '競態：', D);
      c.disconnect();

      // ---- B1-LOCK：房間不在時，快照等待鎖期間的新更新／壓縮／補救都要看得到 ----
      // 這一段的協作伺服器到期時間設為 6 秒：輸入後重新啟動協作伺服器（記憶體中沒有這一頁的房間，快照必定從資料庫讀），
      // 測試連線依提交的鎖順序（頁面列 → advisory lock）持有鎖並寫入；頁面在持鎖期間到期，快照必定排在鎖後面
      // （以 pg_stat_activity 確認在等待），提交後才繼續
      for (const mode of ['update', 'compact', 'rescue']) {
        await S.stop(); live.servers.delete(S);
        S = await startServer({ TZ, AUTO_VERSION_DELAY_MS: '6000' });
        const L = await newDocId();
        const tg = { update: 'u', compact: 'c', rescue: 'r' }[mode];
        c = await typed(S.url, L, 'ua', [`[l${tg}0]`], rnd);
        c.disconnect();
        await S.stop(); live.servers.delete(S);
        S = await startServer({ TZ, AUTO_VERSION_DELAY_MS: '6000' });
        const tc = await db.connect();
        try {
          await tc.query('begin');
          await tc.query('select 1 from pages where id=$1 for share', [L]);
          await tc.query('select pg_advisory_xact_lock(hashtext($1))', [L]);
          const cur = await loadFromDb(L);
          const last = (await tc.query('select last_seq::int from pages where id=$1', [L])).rows[0].last_seq;
          const extra = `[lk${tg}0]`;
          if (mode === 'compact') {
            await tc.query(`insert into doc_states(page_id, state, up_to_seq) values ($1,$2,$3)
              on conflict (page_id) do update set state=excluded.state, up_to_seq=excluded.up_to_seq`, [L, Buffer.from(cur.update), last]);
            await tc.query('delete from doc_updates where page_id=$1 and seq <= $2', [L, last]);
          } else {
            const d = docFromUpdate(cur.update);
            const sv = Y.encodeStateVector(d);
            insertToken(d, extra, rnd, true);
            await tc.query('insert into doc_updates(page_id, seq, data, user_id, kind) values ($1,$2,$3,$4,$5)',
              [L, last + 1, Buffer.from(Y.encodeStateAsUpdate(d, sv)), mode === 'rescue' ? null : 'ua', mode === 'rescue' ? 'rescue' : 'edit']);
            // 與提交相同的語句（seq 增加時開始計時）
            await tc.query(`update pages set last_seq=$2, dirty_since = case when $2 > last_seq then coalesce(dirty_since, now()) else dirty_since end where id=$1`, [L, last + 1]);
          }
          await waitFor(collabWaitingLock, 8000, 'snapshot waiting for lock').catch(() => fails.push(`鎖等待（${mode}）：快照沒有在等待鎖`));
          await tc.query('commit');
          const pr = await pageRow(L);
          await waitFor(async () => (await versions(L, `source = 'schedule' and up_to_seq = ${pr.last_seq}`)).length === 1, 8000, 'snapshot after lock').catch(() => fails.push(`鎖等待（${mode}）：釋放鎖後沒有存版`));
          const sv = await versions(L, "source = 'schedule'");
          if (sv.length !== 1) fails.push(`鎖等待（${mode}）：排程快照 ${sv.length} 個（應為 1；可能在持鎖前就已存版）`);
          const v = sv[sv.length - 1];
          if (v && v.up_to_seq !== pr.last_seq) fails.push(`鎖等待（${mode}）：up_to_seq ${v.up_to_seq} ≠ 釋放後的 last_seq ${pr.last_seq}（使用了舊資料）`);
          const want = (await loadFromDb(L)).tokens;
          if (v && !eqSet(tokSet(v.state), want)) fails.push(`鎖等待（${mode}）：快照內容與資料庫不同`);
          if (v && mode !== 'compact' && !tokSet(v.state).has(extra)) fails.push(`鎖等待（${mode}）：快照沒有包含等待期間提交的更新`);
        } finally { try { await tc.query('rollback'); } catch { /* 已提交 */ } tc.release(); }
      }

      await S.stop(); live.servers.delete(S);
      S = await startServer({ TZ });

      // ---- B1：還原算一次新變更 ----
      const T = await newDocId();
      c = await typed(S.url, T, 'ua', ['[t0]'], rnd);
      const tv = 'tv-' + randomUUID();
      await within(c.makeVersion(tv), 5000, 'version before restore');
      c.type('[t1]'); await quiesce([c]);
      const lastBefore = (await pageRow(T)).last_seq;
      const rid = randomUUID();
      const rr = new Promise(r => c.on('restore_result', x => { if (x.restoreId === rid) r(x); }));
      c.restore(tv, rid);
      const rres = await within(rr, 8000, 'restore');
      if (rres.status !== 'applied') fails.push('還原後存版：還原沒有套用 ' + rres.status);
      await quiesce([c]);
      p = await pageRow(T);
      if (p.snap_seq !== lastBefore) fails.push(`還原後存版：snap_seq ${p.snap_seq} 應為還原前的 last_seq ${lastBefore}`);
      if (!p.dirty_since) fails.push('還原後存版：還原後 dirty_since 應已設定');
      c.disconnect();
      await backdate(T, DUE_S + 1);
      await waitFor(async () => (await scheduleCount(T)) === 1, 5000, 'snapshot after restore').catch(() => fails.push('還原後存版：10 分鐘後沒有排程快照'));
      const tsv = (await versions(T, "source = 'schedule'"))[0];
      if (tsv && (tsv.up_to_seq !== (await pageRow(T)).last_seq || tokSet(tsv.state).has('[t1]') || !tokSet(tsv.state).has('[t0]'))) fails.push('還原後存版：排程快照不是還原後的內容');
      const br = (await versions(T, "reason = 'before_restore'"))[0];
      if (!br || !tokSet(br.state).has('[t1]')) fails.push('還原後存版：before_restore 沒有包含還原前的修改');

      // ---- B2：90 天清理與還原紀錄 ----
      const old = (await versions(T, `id = '${tv}'`))[0];
      const keep = (await versions(T, "source = 'schedule'"))[0];
      await db.query(`update page_versions set created_at = now() - interval '90 days' - interval '1 second' where id=$1`, [old.id]);
      await db.query(`update page_versions set created_at = now() - interval '89 days 23 hours' where id=$1`, [keep.id]);
      const purgesBefore = Number((await db.query('select count(*) from version_purges')).rows[0].count);
      const pr1 = await purgeVersions(db, 90);
      if ((await versions(T, `id = '${old.id}'`)).length !== 0) fails.push('90 天清理：超過 90 天的版本沒有刪除');
      if ((await versions(T, `id = '${keep.id}'`)).length !== 1) fails.push('90 天清理：未滿 90 天的版本被刪除');
      const job = (await db.query('select target_version_id, target_version_reason, target_version_created_at from restore_jobs where id=$1', [rid])).rows[0];
      if (!job || job.target_version_id !== null || job.target_version_reason !== 'auto' || !job.target_version_created_at) fails.push('90 天清理：還原紀錄的引用沒有設為空值或歷史欄位遺失');
      if (Number((await db.query('select count(*) from version_purges')).rows[0].count) !== purgesBefore + 1 || pr1.purged < 1) fails.push('90 天清理：沒有記錄 version_purges');
      const dangling = Number((await db.query(`select count(*) from restore_jobs j where (j.target_version_id is not null and not exists (select 1 from page_versions v where v.id = j.target_version_id))
          or (j.before_version_id is not null and not exists (select 1 from page_versions v where v.id = j.before_version_id))`)).rows[0].count);
      if (dangling) fails.push(`90 天清理：有 ${dangling} 筆懸空引用`);

      // ---- B2：清理後重送、restore_id 屬於其他頁面、清理先完成 ----
      c = await mkClient(S.url, T, 'ua', rnd);
      c.connect(); await quiesce([c]);
      const ask = (restoreId, versionId) => { const pr = new Promise(r => c.on('restore_result', x => { if (x.restoreId === restoreId) r(x); })); c.raw({ t: 'restore', restoreId, versionId }); return within(pr, 8000, 'restore_result'); };
      let x = await ask(rid, tv);
      if (x.status !== 'already_applied') fails.push('清理後重送：狀態 ' + x.status + '（應為 already_applied）');
      const otherPage = await newDocId();
      const oc = await mkClient(S.url, otherPage, 'ua', rnd);
      oc.connect(); await quiesce([oc]);
      const opr = new Promise(r => oc.on('restore_result', y => { if (y.restoreId === rid) r(y); }));
      oc.raw({ t: 'restore', restoreId: rid, versionId: tv });
      x = await within(opr, 8000, 'cross-page restore_id');
      if (x.status !== 'restore_id_conflict') fails.push('restore_id 屬於其他頁面：狀態 ' + x.status);
      oc.disconnect();
      const epochBefore = (await pageRow(T)).restore_epoch;
      const rid2 = randomUUID();
      x = await ask(rid2, tv);
      if (x.status !== 'no_such_version') fails.push('清理先完成：狀態 ' + x.status + '（應為 no_such_version）');
      if ((await versions(T, `id = 'br-${rid2}'`)).length || (await db.query('select 1 from restore_jobs where id=$1', [rid2])).rows.length || (await pageRow(T)).restore_epoch !== epochBefore) fails.push('清理先完成：留下了 before_restore、還原紀錄或 restore_epoch 改變');
      c.disconnect();

      // ---- B2：還原與清理競態（還原交易鎖住目標版本時暫停 3 秒，期間執行清理）----
      await S.stop(); live.servers.delete(S);
      S = await startServer({ TZ, PAUSE_POINT: 'restore:locked', PAUSE_MS: '3000' });
      const Q = await newDocId();
      c = await typed(S.url, Q, 'ua', ['[q0]'], rnd);
      const qv = 'qv-' + randomUUID();
      await within(c.makeVersion(qv), 5000, 'version for race');
      c.type('[q1]'); await quiesce([c]);
      await db.query(`update page_versions set created_at = now() - interval '91 days' where id=$1`, [qv]);
      const rid3 = randomUUID();
      const rr3 = new Promise(r => c.on('restore_result', y => { if (y.restoreId === rid3) r(y); }));
      c.restore(qv, rid3);
      await waitFor(collabIdleInTx, 5000, 'restore paused in transaction').catch(() => fails.push('還原與清理競態：還原交易沒有暫停'));
      const during = await purgeVersions(db, 90);
      if (during.purged !== 0 || (await versions(Q, `id = '${qv}'`)).length !== 1) fails.push('還原與清理競態：清理刪除了正在被還原的版本');
      x = await within(rr3, 10000, 'restore after race').catch(e => ({ status: e.message }));
      if (x.status !== 'applied') fails.push('還原與清理競態：還原沒有完整套用（' + x.status + '）');
      await quiesce([c]).catch(() => {});
      const qt = (await loadFromDb(Q)).tokens;
      if (!qt.has('[q0]') || qt.has('[q1]')) fails.push('還原與清理競態：文件內容不是被鎖住的版本');
      const after = await purgeVersions(db, 90);
      if (after.purged < 1 || (await versions(Q, `id = '${qv}'`)).length !== 0) fails.push('還原與清理競態：下一輪清理沒有刪除過期版本');
      const qj = (await db.query('select target_version_id from restore_jobs where id=$1', [rid3])).rows[0];
      if (!qj || qj.target_version_id !== null) fails.push('還原與清理競態：還原紀錄的引用沒有設為空值');
      c.disconnect();

      // ---- B2：清理中斷（刪除後、寫入紀錄前終止連線）→ 整筆回滾 ----
      const Z = await newDocId();
      await db.query(`insert into page_versions(id, page_id, state, up_to_seq, reason, created_at) values ($1, $2, '\\x00', 0, 'auto', now() - interval '100 days')`, ['z-' + Z, Z]);
      const blocker = await db.connect();
      let purgeErr = null;
      try {
        await blocker.query('begin');
        await blocker.query('lock table version_purges in access exclusive mode');
        const pp = new pg.Pool({ connectionString: DB_URL, max: 1, application_name: 'purge-under-test' });
        pp.on('error', () => {});   // 被終止的連線會發出 error 事件
        const run = purgeVersions(pp, 90).catch(e => { purgeErr = e; });
        await waitFor(async () => Number((await db.query(`select count(*) from pg_stat_activity where application_name='purge-under-test' and wait_event_type='Lock'`)).rows[0].count) > 0, 5000, 'purge waiting');
        await db.query(`select pg_terminate_backend(pid) from pg_stat_activity where application_name='purge-under-test'`);
        await run; await pp.end().catch(() => {});
      } finally { await blocker.query('rollback'); blocker.release(); }
      if (!purgeErr) fails.push('清理中斷：清理沒有因連線終止而失敗');
      if ((await versions(Z)).length !== 1) fails.push('清理中斷：版本在中斷後已被刪除（沒有整筆回滾）');
      await purgeVersions(db, 90);
      if ((await versions(Z)).length !== 0) fails.push('清理中斷：下一輪清理沒有完成');

      // ---- B2：頁面永久刪除優先（垃圾桶 30 天，與 purgeTrash 相同的刪除句）----
      const P = await newDocId();
      c = await typed(S.url, P, 'ua', ['[p0]'], rnd);
      const pv = 'pv-' + randomUUID();
      await within(c.makeVersion(pv), 5000, 'version before purge');
      const rid4 = randomUUID();
      const rr4 = new Promise(r => c.on('restore_result', y => { if (y.restoreId === rid4) r(y); }));
      c.restore(pv, rid4);
      await within(rr4, 10000, 'restore before purge');
      c.disconnect();
      await db.query(`insert into conflict_copies(id, page_id, user_id, state, content_json) values ($1, $2, 'ua', '\\x00', '[]')`, ['cc-' + P, P]);
      await db.query(`update pages set deleted_at = now() - interval '31 days', trash_batch = gen_random_uuid() where id=$1`, [P]);
      await db.query(`delete from pages where id=$1 and deleted_at < now() - interval '30 days' and trash_batch is not null`, [P]);
      for (const t of ['page_versions', 'restore_jobs', 'conflict_copies', 'doc_updates', 'doc_states']) {
        if (Number((await db.query(`select count(*) from ${t} where page_id=$1`, [P])).rows[0].count)) fails.push(`永久刪除：${t} 還有該頁的資料`);
      }

      // ---- 遷移 0003 ----
      await migrationChecks(fails, m);
    }
  }
  return rec.save();
}

// 遷移 0003（B2-P0-02、B2-ROLLBACK）：在獨立的暫存資料庫上執行
const MIG_DB = 'notes_mig03_test';
async function migrationChecks(fails, m) {
  const u = new URL(DB_URL); u.pathname = '/' + MIG_DB;
  const url = u.toString();
  const admin = new URL(DB_URL); admin.pathname = '/postgres';
  const backupDir = mkdtempSync(join(tmpdir(), 'mig03-'));
  const mig = (...args) => spawnSync(process.execPath, [APP_DIR + 'scripts/migrate.mjs', ...args], { env: { ...process.env, DATABASE_URL: url, BACKUP_DIR: backupDir + '/' }, encoding: 'utf8' });
  const fp = () => mig('fingerprint').stdout;
  const a = new pg.Client({ connectionString: admin.toString() });
  await a.connect();
  let c = null;
  const fresh = async () => {
    if (c) { await c.end(); c = null; }
    await a.query(`drop database if exists "${MIG_DB}" with (force)`);
    await a.query(`create database "${MIG_DB}" template template0 encoding 'UTF8' lc_collate 'C.UTF-8' lc_ctype 'C.UTF-8'`);
    let r = mig('up'); if (r.status !== 0) throw new Error('up ' + r.stderr);
    r = mig('down', '1'); if (r.status !== 0) throw new Error('down to M2-b ' + r.stderr);
    c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`insert into workspaces(name) values ('W')`);
    await c.query(`insert into "user"(id,name,email,email_verified,role,created_at,updated_at) values ('u1','甲','u1@m3.test',true,'admin',now(),now())`);
    const ws = (await c.query('select id from workspaces')).rows[0].id;
    const sp = (await c.query(`select id from spaces where owner_id='u1'`)).rows[0].id;
    const pid = (await c.query(`insert into pages(workspace_id, space_id, title, position, created_by, last_seq) values ($1,$2,'P','a0','u1',7) returning id`, [ws, sp])).rows[0].id;
    await c.query(`insert into page_versions(id,page_id,state,up_to_seq,reason) values ('v1',$1,'\\x00',5,'auto'),('v2',$1,'\\x00',4,'auto'),('br-r1',$1,'\\x00',6,'before_restore')`, [pid]);
    await c.query(`insert into restore_jobs(id,page_id,target_version_id,before_version_id,status,seq) values ('r1',$1,'v1','br-r1','applied',7)`, [pid]);
    return pid;
  };
  const snapshotRows = async () => {
    const out = {};
    for (const t of ['pages', 'page_versions', 'restore_jobs']) out[t] = JSON.stringify((await c.query(`select * from ${t} order by 1`)).rows);
    return out;
  };
  try {
    // 異常引用：停止遷移、資料與結構不變
    let pid = await fresh();
    await c.query(`insert into restore_jobs(id,page_id,target_version_id,status) values ('bad',$1,'missing','applied')`, [pid]);
    let fp0 = fp(), rows0 = await snapshotRows();
    let r = mig('up');
    if (r.status === 0 || !/invalid_restore_refs/.test(r.stderr) || !/bad/.test(r.stderr)) fails.push('遷移：異常引用沒有停止遷移');
    if (fp() !== fp0 || JSON.stringify(await snapshotRows()) !== JSON.stringify(rows0)) fails.push('遷移：異常引用停止後資料或結構有變更');
    // 正常遷移、回填、無損回滾、再套用
    pid = await fresh();
    fp0 = fp(); rows0 = await snapshotRows();
    r = mig('up'); if (r.status !== 0) throw new Error('up ' + r.stderr);
    const pr = (await c.query('select snap_seq::int, dirty_since is not null as d from pages where id=$1', [pid])).rows[0];
    const jr = (await c.query(`select target_version_reason from restore_jobs where id='r1'`)).rows[0];
    if (pr.snap_seq !== 6 || !pr.d || jr.target_version_reason !== 'auto') fails.push('遷移：snap_seq、dirty_since 或還原紀錄的歷史欄位回填錯誤');
    r = mig('down', '1');
    if (r.status !== 0 || fp() !== fp0 || JSON.stringify(await snapshotRows()) !== JSON.stringify(rows0)) fails.push('遷移：沒有新資料時回滾後結構或資料與遷移前不同');
    // 不安全的回滾：每一類各自讓 down 拒絕、資料不變
    const unsafe = {
      '只刪未被引用的舊版本': async () => {
        await c.query(`update page_versions set created_at = now() - interval '100 days' where id='v2'`);
        const pool = new pg.Pool({ connectionString: url, max: 1 });
        try { await purgeVersions(pool, 90); } finally { await pool.end(); }
        if ((await c.query(`select count(*)::int as n from restore_jobs where target_version_id is null`)).rows[0].n) throw new Error('setup: 清理動到了被引用的版本');
      },
      '目標版本已清除': async () => { await c.query(`delete from page_versions where id='v1'`); },
      '手動版本': async () => { await c.query(`insert into page_versions(id,page_id,state,up_to_seq,reason) values ('m1',$1,'\\x00',7,'manual')`, [pid]); },
      '排程快照': async () => { await c.query(`insert into page_versions(id,page_id,state,up_to_seq,reason,source) values ('s1',$1,'\\x00',7,'auto','schedule')`, [pid]); },
    };
    for (const [label, setup] of Object.entries(unsafe)) {
      pid = await fresh();
      r = mig('up'); if (r.status !== 0) throw new Error('up ' + r.stderr);
      await setup();
      const fpa = fp(), rowsA = await snapshotRows();
      r = mig('down', '1');
      if (r.status === 0 || !/unsafe_rollback/.test(r.stderr)) fails.push(`不安全的回滾（${label}）：down 沒有拒絕`);
      if (fp() !== fpa || JSON.stringify(await snapshotRows()) !== JSON.stringify(rowsA)) fails.push(`不安全的回滾（${label}）：拒絕後資料或結構有變更`);
    }
    // 從遷移前的備份還原：與遷移前完全相同
    pid = await fresh();
    fp0 = fp(); rows0 = await snapshotRows();
    for (const f of readdirSync(backupDir)) rmSync(join(backupDir, f), { force: true });
    r = mig('up'); if (r.status !== 0) throw new Error('up ' + r.stderr);
    await c.query(`insert into page_versions(id,page_id,state,up_to_seq,reason) values ('m1',$1,'\\x00',7,'manual')`, [pid]);
    const dump = readdirSync(backupDir).find(f => f.includes('before-0003'));
    if (!dump) fails.push('遷移：沒有產生遷移前的備份');
    else {
      await c.end(); c = null;
      r = mig('restore', join(backupDir, dump));
      c = new pg.Client({ connectionString: url }); await c.connect();
      if (r.status !== 0 || fp() !== fp0 || JSON.stringify(await snapshotRows()) !== JSON.stringify(rows0)) fails.push('遷移：從備份還原後與遷移前不同');
    }
    m.migration = 'checked';
  } finally {
    if (c) await c.end().catch(() => {});
    await a.query(`drop database if exists "${MIG_DB}" with (force)`).catch(() => {});
    await a.end();
    rmSync(backupDir, { recursive: true, force: true });
  }
}
