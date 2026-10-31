// M0-01～11 核心阻斷測試。每個案例回傳 Recorder 結果；失敗會記錄種子以便重現。
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import WS from 'ws';
import { Client } from '../src/client.js';
import { docJSON, tokensOf, containsState, docFromUpdate } from '../src/doc.js';
import {
  db, ServerProc, startProxy, newSession, revoke, setDbFault, terminateServerConnections,
  loadFromDb, versionTokens, conflictCopyTokens, quiesce, waitFor, sleep, rng, between,
  setEq, setDiff, Recorder, live,
} from './harness.js';

// ---------- 共用 ----------
// 每一輪建立的用戶端、伺服器、代理都登記在 live；不論該輪成功、失敗或拋出例外，都會全部清理
function NewClient(opts) {
  const c = new Client({ WebSocketImpl: WS, ...opts });
  live.clients.add(c);
  return c;
}

async function mkClient(url, docId, user, name, rnd, extra = {}) {
  const token = await newSession(user);
  return NewClient({ url, docId, token, userId: user, name, rnd, ...extra });
}

async function cleanupLive() {
  for (const c of live.clients) c.disconnect();
  live.clients.clear();
  for (const p of live.proxies) await p.close();
  live.proxies.clear();
  for (const s of live.servers) await s.stop();
  live.servers.clear();
  await setDbFault(false);
}

// 執行一輪：例外或逾時都記為失敗（附錯誤訊息），然後清理並繼續下一輪
async function runIter(rec, i, seed, fn) {
  let res;
  try { res = await fn(); } catch (e) { res = [['exception: ' + e.message], {}]; }
  await cleanupLive();
  rec.add(i, seed, res[0], res[1] || {});
}

// 等待事件但設定上限：缺陷應表現為明確的失敗，而不是讓測試卡住
function within(p, ms, label) {
  return Promise.race([p, sleep(ms).then(() => { throw new Error('timeout waiting for ' + label); })]);
}

// 持續輸入：回傳 stop()；tokens 與 deleted 由呼叫端提供的 Set 收集
function typing(c, { name, rnd, minMs = 3, maxMs = 10, delProb = 0, blockDelProb = 0, newBlock = false, typed, deleted, onType }) {
  let n = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      const r = rnd();
      if (r < delProb) { const t = c.del(); if (t) deleted.add(t); }
      else if (r < delProb + blockDelProb) { for (const t of c.delBlock()) deleted.add(t); }
      else {
        const tok = `[${name}${n++}]`;
        const id = c.type(tok, newBlock);
        typed.add(tok);
        if (onType) onType(tok, id);
      }
    } catch { /* 唯讀期間略過 */ }
    setTimeout(tick, between(rnd, minMs, maxMs));
  };
  setTimeout(tick, 0);
  return () => { stopped = true; };
}

function trackIds(clients) {
  const ids = new Set();
  for (const c of clients) c.on('local', e => ids.add(e.id));
  return ids;
}

async function idsMissingInDb(docId, ids) {
  const have = new Set((await db.query('select update_id from doc_update_ids where page_id=$1', [docId])).rows.map(r => r.update_id));
  return [...ids].filter(id => !have.has(id));
}

function checkConverged(fails, clients, dbs) {
  const js = clients.map(c => docJSON(c.ydoc));
  if (!js.every(j => j === js[0])) fails.push('clients diverged');
  if (js[0] !== dbs.json) fails.push('client != database');
}

function checkTokens(fails, label, actual, expected) {
  if (!setEq(actual, expected)) {
    fails.push(`${label}: missing=${setDiff(expected, actual).slice(0, 5).join(',')} extra=${setDiff(actual, expected).slice(0, 5).join(',')}`);
  }
}

async function teardown(clients, srv, proxies = []) {
  for (const c of clients) c.disconnect();
  for (const p of proxies) await p.close();
  await srv.stop();
}

// ---------- M0-01：提交後才確認 ----------
export async function m0_01(N) {
  const rec = new Recorder('M0-01', '打字中隨機強制終止協作伺服器；已儲存與已接收的內容在重啟後必須都存在');
  const modes = ['kill9', 'flush:before_commit', 'flush:after_commit'];
  for (let i = 0; i < N; i++) {
    const seed = 10100 + i;
    await runIter(rec, i, seed, async () => {
    const rnd = rng(seed);
    const mode = modes[i % 3];
    const srv = new ServerProc(27101, { COMPACT_EVERY: String(between(rnd, 20, 80)) });
    await srv.start(mode === 'kill9' ? {} : { FAULT_POINT: mode, FAULT_AFTER: String(between(rnd, 2, 25)) });
    const docId = randomUUID();
    const A = await mkClient(srv.url, docId, 'ua', 'A', rnd, { trackReceived: true });
    const B = await mkClient(srv.url, docId, 'ub', 'B', rnd, { trackReceived: true });
    A.connect(); B.connect();
    await quiesce([A, B]);
    const typed = new Set(); const deleted = new Set();
    const stops = [A, B].map(c => typing(c, { name: c.name, rnd, delProb: 0.15, typed, deleted }));
    if (mode === 'kill9') { await sleep(between(rnd, 150, 1200)); await srv.kill9(); }
    else { await Promise.race([srv.exited(), sleep(4000)]); await srv.kill9(); }
    await sleep(between(rnd, 0, 100)); // 伺服器停止後仍在離線輸入
    stops.forEach(s => s());
    const fails = [];
    const dbAfterCrash = await loadFromDb(docId);
    for (const c of [A, B]) {
      if (c.lastSaved && !containsState(dbAfterCrash.update, c.lastSaved.state)) fails.push(`${c.name}: content shown as saved is missing after crash`);
      if (c.received.length && !containsState(dbAfterCrash.update, Y.mergeUpdates(c.received))) fails.push(`${c.name}: received remote content not persisted`);
    }
    const pendingAtCrash = A.pending.length + B.pending.length;
    await srv.start();
    await quiesce([A, B], 20000);
    const fin = await loadFromDb(docId);
    checkConverged(fails, [A, B], fin);
    checkTokens(fails, 'final tokens', fin.tokens, new Set(setDiff(typed, deleted)));
    return [fails, { mode, typed: typed.size, deleted: deleted.size, pendingAtCrash, savedClaims: [A, B].filter(c => c.lastSaved).length }];
    });
  }
  return rec.save();
}

// ---------- M0-02：資料庫交易失敗或連線中斷 ----------
export async function m0_02(N) {
  const rec = new Recorder('M0-02', '資料庫寫入失敗或連線被終止時不送確認、不廣播；恢復後補寫');
  for (let i = 0; i < N; i++) {
    const seed = 20200 + i;
    await runIter(rec, i, seed, async () => {
    const rnd = rng(seed);
    await setDbFault(false);
    const srv = new ServerProc(27102);
    await srv.start();
    const docId = randomUUID();
    const A = await mkClient(srv.url, docId, 'ua', 'A', rnd, { failAfterMs: 300 });
    const B = await mkClient(srv.url, docId, 'ub', 'B', rnd, { failAfterMs: 300 });
    const created = trackIds([A, B]);
    const ackedIds = new Set();
    let faultOnSince = 0;
    let deliveriesDuringFault = 0;
    const onDeliver = () => { if (faultOnSince && Date.now() - faultOnSince > 150) deliveriesDuringFault++; };
    for (const c of [A, B]) { c.on('acked', ids => { ids.forEach(x => ackedIds.add(x)); onDeliver(); }); c.on('remote', onDeliver); }
    A.connect(); B.connect();
    await quiesce([A, B]);
    const typed = new Set(); const deleted = new Set();
    const stops = [A, B].map(c => typing(c, { name: c.name, rnd, minMs: 4, maxMs: 14, delProb: 0.15, typed, deleted }));
    let sawFailed = false; let longFaults = 0; let terminations = 0;
    const end = Date.now() + 2200;
    while (Date.now() < end) {
      await sleep(between(rnd, 80, 300));
      if (rnd() < 0.6) {
        const dur = between(rnd, 100, 900);
        await setDbFault(true);
        faultOnSince = Date.now();
        const t0 = Date.now();
        while (Date.now() - t0 < dur) {
          if (A.saveStatus() === 'failed' || B.saveStatus() === 'failed') sawFailed = true;
          await sleep(20);
        }
        if (dur >= 500) longFaults++;
        faultOnSince = 0;
        await setDbFault(false);
      } else {
        terminations += await terminateServerConnections();
      }
    }
    stops.forEach(s => s());
    await setDbFault(false);
    await quiesce([A, B], 20000);
    const fails = [];
    const fin = await loadFromDb(docId);
    checkConverged(fails, [A, B], fin);
    checkTokens(fails, 'final tokens', fin.tokens, new Set(setDiff(typed, deleted)));
    const missing = await idsMissingInDb(docId, created);
    if (missing.length) fails.push(`${missing.length} local updates never persisted`);
    const ackedMissing = await idsMissingInDb(docId, ackedIds);
    if (ackedMissing.length) fails.push(`${ackedMissing.length} acked ids missing in DB`);
    if (deliveriesDuringFault > 0) fails.push(`${deliveriesDuringFault} ack/broadcast delivered while DB writes were failing`);
    if (longFaults > 0 && !sawFailed) fails.push('save status never showed failure during a long DB outage');
    return [fails, { typed: typed.size, longFaults, terminations, sawFailed }];
    });
  }
  await setDbFault(false);
  return rec.save();
}

// ---------- M0-03：update_id 去重（重放、確認遺失、合併重送，含刪除） ----------
export async function m0_03(N) {
  const rec = new Recorder('M0-03', '重放、確認遺失後重送、合併後重送（含刪除）：不重複寫入且待確認項目全部清除');
  for (let i = 0; i < N; i++) {
    const seed = 30300 + i;
    await runIter(rec, i, seed, async () => {
    const rnd = rng(seed);
    const srv = new ServerProc(27103, { COMPACT_EVERY: '1000000' });
    await srv.start();
    let chaos = true;
    const hooks = {
      onClient: (m, s, st) => (chaos && m.t === 'update' && rnd() < 0.3 ? (st.replays += 2, [s, s, s]) : [s]),
      onServer: m => (chaos && m.t === 'ack' && rnd() < 0.05 ? 'drop_and_cut' : 'pass'),
    };
    const pA = startProxy(27203, 27103, hooks);
    const pB = startProxy(27204, 27103, hooks);
    const docId = randomUUID();
    const A = await mkClient('ws://127.0.0.1:27203', docId, 'ua', 'A', rnd, { autoReconnect: false });
    const B = await mkClient('ws://127.0.0.1:27204', docId, 'ub', 'B', rnd);
    const created = trackIds([A, B]);
    let merges = 0;
    A.on('disconnected', () => {
      if (A.closedByUser) return;
      setTimeout(() => { if (A.closedByUser) return; if (rnd() < 0.7 && A.mergePending()) merges++; A.connect(); }, 30);
    });
    A.connect(); B.connect();
    await quiesce([A, B]);
    const typed = new Set(); const deleted = new Set();
    const stops = [A, B].map(c => typing(c, { name: c.name, rnd, delProb: 0.25, typed, deleted }));
    await sleep(between(rnd, 300, 700));
    // 離線批次：斷線後輸入與刪除，再合併成一筆重送
    A.disconnect();
    for (let k = 0; k < 20; k++) {
      if (rnd() < 0.3) { const t = A.del(); if (t) deleted.add(t); } else { const tok = `[Aoff${k}]`; A.type(tok); typed.add(tok); }
    }
    if (A.mergePending()) merges++;
    A.connect();
    await sleep(between(rnd, 300, 700));
    stops.forEach(s => s());
    chaos = false;
    await quiesce([A, B], 20000);
    const fails = [];
    const fin = await loadFromDb(docId);
    checkConverged(fails, [A, B], fin);
    checkTokens(fails, 'final tokens', fin.tokens, new Set(setDiff(typed, deleted)));
    const missing = await idsMissingInDb(docId, created);
    if (missing.length) fails.push(`${missing.length} local update ids not recorded`);
    const orphanRows = Number((await db.query(`select count(*) from doc_updates u where page_id=$1 and not exists
      (select 1 from doc_update_ids i where i.page_id=u.page_id and i.seq=u.seq)`, [docId])).rows[0].count);
    if (orphanRows) fails.push(`${orphanRows} rows written for already-stored updates`);
    return [fails, { typed: typed.size, deleted: deleted.size, replays: pA.stats.replays + pB.stats.replays, droppedAcks: pA.stats.droppedAcks + pB.stats.droppedAcks, merges }];
    });
  }
  return rec.save();
}

// ---------- M0-04：離線編輯、關閉瀏覽器後重新連線 ----------
export async function m0_04(N) {
  const rec = new Recorder('M0-04', '離線大量編輯（含刪除）後關閉並重開瀏覽器，重新連線補送');
  for (let i = 0; i < N; i++) {
    const seed = 40400 + i;
    await runIter(rec, i, seed, async () => {
    const rnd = rng(seed);
    const srv = new ServerProc(27104, { COMPACT_EVERY: String(between(rnd, 30, 150)) });
    await srv.start();
    const docId = randomUUID();
    let A = await mkClient(srv.url, docId, 'ua', 'A', rnd);
    const B = await mkClient(srv.url, docId, 'ub', 'B', rnd);
    const created = trackIds([A, B]);
    A.connect(); B.connect();
    await quiesce([A, B]);
    const typed = new Set(); const deleted = new Set();
    for (let k = 0; k < 20; k++) { A.type(`[A${k}]`); B.type(`[B${k}]`); typed.add(`[A${k}]`); typed.add(`[B${k}]`); }
    await quiesce([A, B]);
    A.disconnect();
    const ops = between(rnd, 50, 300);
    // A 離線時會整塊刪除；B 只新增區塊，避免「並行刪除整塊」的語意干擾資料完整性判定（該語意另於報告說明）
    const stopB = typing(B, { name: 'Bon', rnd, newBlock: true, typed, deleted });
    for (let k = 0; k < ops; k++) {
      const r = rnd();
      if (r < 0.2) { const t = A.del(); if (t) deleted.add(t); }
      else if (r < 0.28) { for (const t of A.delBlock()) deleted.add(t); }
      else { const tok = `[Aoff${k}]`; A.type(tok); typed.add(tok); }
      if (k % 25 === 0) await sleep(5);
    }
    stopB();
    // 模擬關閉瀏覽器再開啟：用同一份本機儲存建立新的用戶端
    const storage = A.storage;
    const offlinePending = storage.pending.length;
    A = NewClient({ url: srv.url, docId, token: A.token, userId: 'ua', name: 'A', rnd, storage });
    A.on('local', e => created.add(e.id));
    const merged = rnd() < 0.5 && A.mergePending();
    A.connect();
    await quiesce([A, B], 20000);
    const fails = [];
    const fin = await loadFromDb(docId);
    checkConverged(fails, [A, B], fin);
    checkTokens(fails, 'final tokens', fin.tokens, new Set(setDiff(typed, deleted)));
    const missing = await idsMissingInDb(docId, created);
    if (missing.length) fails.push(`${missing.length} local updates never persisted`);
    return [fails, { offlineOps: ops, offlinePending, merged }];
    });
  }
  return rec.save();
}

// ---------- M0-05：還原與並行輸入 ----------
export async function m0_05(N) {
  const rec = new Recorder('M0-05', 'A 持續輸入時 B 還原：結果一致、被還原的內容不復活、A 的輸入沒有無聲遺失');
  for (let i = 0; i < N; i++) {
    const seed = 50500 + i;
    await runIter(rec, i, seed, async () => {
    const rnd = rng(seed);
    const srv = new ServerProc(27105, { COMPACT_EVERY: String(between(rnd, 40, 200)) });
    await srv.start();
    const docId = randomUUID();
    const A = await mkClient(srv.url, docId, 'ua', 'A', rnd);
    const B = await mkClient(srv.url, docId, 'ub', 'B', rnd);
    A.connect(); B.connect();
    await quiesce([A, B]);
    for (let k = 0; k < 20; k++) A.type(`[Aa${k}]`);
    await quiesce([A, B]);
    const target = await B.makeVersion('t-' + docId);
    const targetTokens = new Set(JSON.parse(target.json).join(' ').match(/\[[A-Za-z]+\d+\]/g) || []);
    for (let k = 0; k < 30; k++) A.type(`[Ab${k}]`);
    await quiesce([A, B]);
    const typed = new Set(); const post = new Set(); let inflight = new Set();
    const tokEntry = new Map();
    let restoredSeen = false;
    A.on('restored', () => {
      restoredSeen = true;
      const pend = new Set(A.pending.map(e => e.id));
      inflight = new Set([...tokEntry].filter(([, id]) => pend.has(id)).map(([t]) => t));
    });
    const stop = typing(A, { name: 'Ac', rnd, minMs: 2, maxMs: 8, typed, deleted: new Set(), onType: (t, id) => { tokEntry.set(t, id); if (restoredSeen) post.add(t); } });
    await sleep(between(rnd, 50, 400));
    const res = new Promise(r => B.once('restore_result', r));
    B.restore('t-' + docId);
    await within(res, 15000, 'restore result');
    await sleep(300);
    stop();
    await quiesce([A, B], 20000);
    // 之後持續同步：B 輸入、A 重開瀏覽器後再輸入
    for (let k = 0; k < 10; k++) B.type(`[Bz${k}]`);
    const storage = A.storage;
    A.disconnect();
    const A2 = NewClient({ url: srv.url, docId, token: A.token, userId: 'ua', name: 'A', rnd, storage });
    A2.connect();
    await quiesce([A2, B], 20000);
    for (let k = 0; k < 10; k++) A2.type(`[Az${k}]`);
    await quiesce([A2, B], 20000);
    await sleep(200);
    const fails = [];
    const fin = await loadFromDb(docId);
    checkConverged(fails, [A2, B], fin);
    const phase2 = new Set([...Array(10).keys()].flatMap(k => [`[Bz${k}]`, `[Az${k}]`]));
    const allowed = new Set([...targetTokens, ...post, ...inflight, ...phase2]);
    const extra = setDiff(fin.tokens, allowed);
    if (extra.length) fails.push(`restored-away content reappeared: ${extra.slice(0, 5).join(',')}`);
    for (const t of phase2) if (!fin.tokens.has(t)) fails.push('post-restore edit missing ' + t);
    const before = await versionTokens(docId, 'before_restore');
    const copies = await conflictCopyTokens(docId);
    const lost = [...typed].filter(t => !fin.tokens.has(t) && !before.has(t) && !copies.tokens.has(t));
    if (lost.length) fails.push(`silently lost: ${lost.slice(0, 5).join(',')} (${lost.length})`);
    const jobs = (await db.query('select count(*) from restore_jobs where page_id=$1', [docId])).rows[0].count;
    if (Number(jobs) !== 1) fails.push('restore_jobs != 1');
    return [fails, { typedDuring: typed.size, inflight: inflight.size, post: post.size, conflictCopies: copies.count }];
    });
  }
  return rec.save();
}

// ---------- M0-06：離線修改＋還原 ----------
export async function m0_06(N) {
  const rec = new Recorder('M0-06', '離線期間被還原：同步前完整保存本機原始內容為衝突副本，主頁面等於目標版本');
  for (let i = 0; i < N; i++) {
    const seed = 60600 + i;
    await runIter(rec, i, seed, async () => {
    const rnd = rng(seed);
    const srv = new ServerProc(27106);
    await srv.start();
    let dropOnce = rnd() < 0.3;
    const proxy = startProxy(27206, 27106, { onServer: m => (m.t === 'cc_ack' && dropOnce ? (dropOnce = false, 'drop_and_cut') : 'pass') });
    const docId = randomUUID();
    let A = await mkClient('ws://127.0.0.1:27206', docId, 'ua', 'A', rnd);
    const B = await mkClient(srv.url, docId, 'ub', 'B', rnd);
    A.connect(); B.connect();
    await quiesce([A, B]);
    for (let k = 0; k < 15; k++) A.type(`[Aa${k}]`);
    await quiesce([A, B]);
    const target = await B.makeVersion('t-' + docId);
    for (let k = 0; k < 15; k++) A.type(`[Ab${k}]`);
    await quiesce([A, B]);
    A.disconnect();
    const ops = between(rnd, 10, 40);
    for (let k = 0; k < ops; k++) { const r = rnd(); if (r < 0.2) A.del(); else if (r < 0.25) A.delBlock(); else A.type(`[Aoff${k}]`); }
    const res = new Promise(r => B.once('restore_result', r));
    B.restore('t-' + docId);
    await within(res, 15000, 'restore result');
    const bAfter = rnd() < 0.5;
    const bTokens = new Set();
    if (bAfter) for (let k = 0; k < 8; k++) { B.type(`[Bpost${k}]`); bTokens.add(`[Bpost${k}]`); }
    await quiesce([B]);
    const localBefore = docJSON(A.ydoc);
    const reopen = rnd() < 0.5;
    if (reopen) { const st = A.storage; A = NewClient({ url: 'ws://127.0.0.1:27206', docId, token: A.token, userId: 'ua', name: 'A', rnd, storage: st }); }
    const resolved = new Promise(r => A.once('offline_conflict_resolved', r));
    A.connect();
    await within(resolved, 15000, 'conflict copy resolved');
    await quiesce([A, B], 20000);
    const fails = [];
    const fin = await loadFromDb(docId);
    checkConverged(fails, [A, B], fin);
    const copies = (await db.query('select content_json from conflict_copies where page_id=$1', [docId])).rows;
    if (copies.length !== 1) fails.push(`conflict copies = ${copies.length}`);
    else if (copies[0].content_json !== localBefore) fails.push('conflict copy differs from offline content');
    const tgt = new Set(JSON.parse(target.json).join(' ').match(/\[[A-Za-z]+\d+\]/g) || []);
    if (!bAfter && fin.json !== target.json) fails.push('main page != target version');
    if (bAfter) checkTokens(fails, 'main page tokens', fin.tokens, new Set([...tgt, ...bTokens]));
    return [fails, { offlineOps: ops, droppedCopyAck: proxy.stats.droppedAcks, reopen, bAfter }];
    });
  }
  return rec.save();
}

// ---------- M0-07：還原後 Undo／Redo ----------
async function undoScenario(rnd, port, clearUndo) {
  const srv = new ServerProc(port);
  await srv.start();
  const docId = randomUUID();
  const A = await mkClient(srv.url, docId, 'ua', 'A', rnd, { clearUndoOnRestore: clearUndo });
  const B = await mkClient(srv.url, docId, 'ub', 'B', rnd, { clearUndoOnRestore: clearUndo });
  A.connect(); B.connect();
  await quiesce([A, B]);
  for (let k = 0; k < 10; k++) A.type(`[Aa${k}]`);
  await quiesce([A, B]);
  const target = await B.makeVersion('t-' + docId);
  for (let k = 0; k < 15; k++) { A.type(`[Ab${k}]`); B.type(`[Bb${k}]`); }
  for (let k = 0; k < 3; k++) { A.del(); A.delBlock(); B.del(); }
  await quiesce([A, B]);
  const res = new Promise(r => B.once('restore_result', r));
  B.restore('t-' + docId);
  await within(res, 15000, 'restore result');
  await waitFor(() => A.storage.knownEpoch === 1, 5000, 'A sees restore');
  for (let k = 0; k < 20; k++) {
    const c = rnd() < 0.5 ? A : B;
    if (rnd() < 0.6) c.undo(); else c.redo();
    await sleep(between(rnd, 0, 15));
  }
  await quiesce([A, B], 20000);
  const fin = await loadFromDb(docId);
  const fails = [];
  checkConverged(fails, [A, B], fin);
  if (fin.json !== target.json) fails.push('content after undo/redo != restored version');
  await teardown([A, B], srv);
  return fails;
}

export async function m0_07(N) {
  const rec = new Recorder('M0-07', '還原後多次 Undo／Redo 不會恢復還原前的內容');
  for (let i = 0; i < N; i++) {
    const seed = 70700 + i;
    await runIter(rec, i, seed, async () => [await undoScenario(rng(seed), 27107, true), {}]);
  }
  // 對照組：不清空 Undo 堆疊，證明這項對策是必要的
  let controlFail = 0;
  const C = Math.min(N, 30);
  for (let i = 0; i < C; i++) {
    try { if ((await undoScenario(rng(70700 + i), 27107, false)).length) controlFail++; } catch { controlFail++; }
    await cleanupLive();
  }
  return rec.save({ control: { iterations: C, resurrected: controlFail, note: '不清空 Undo 堆疊時，還原前的內容被 Undo 加回的次數' } });
}

// ---------- M0-08：同時還原＋一般編輯 ----------
export async function m0_08(N) {
  const rec = new Recorder('M0-08', 'A、B 同時還原到不同版本，C 同時輸入：依佇列順序套用，結果一致');
  for (let i = 0; i < N; i++) {
    const seed = 80800 + i;
    await runIter(rec, i, seed, async () => {
    const rnd = rng(seed);
    const srv = new ServerProc(27108);
    await srv.start();
    const docId = randomUUID();
    const A = await mkClient(srv.url, docId, 'ua', 'A', rnd);
    const B = await mkClient(srv.url, docId, 'ub', 'B', rnd);
    const C = await mkClient(srv.url, docId, 'uc', 'C', rnd);
    A.connect(); B.connect(); C.connect();
    await quiesce([A, B, C]);
    for (let k = 0; k < 10; k++) A.type(`[Aa${k}]`);
    await quiesce([A, B, C]);
    const v1 = await A.makeVersion('v1-' + docId);
    for (let k = 0; k < 10; k++) B.type(`[Bb${k}]`);
    await quiesce([A, B, C]);
    const v2 = await B.makeVersion('v2-' + docId);
    for (let k = 0; k < 10; k++) A.type(`[Ac${k}]`);
    await quiesce([A, B, C]);
    const withTyping = i % 2 === 0;
    const typed = new Set();
    const stop = withTyping ? typing(C, { name: 'Cx', rnd, minMs: 2, maxMs: 8, typed, deleted: new Set() }) : () => {};
    await sleep(between(rnd, 20, 150));
    const rA = new Promise(r => A.once('restore_result', r));
    const rB = new Promise(r => B.once('restore_result', r));
    // 同一個事件循環內送出，先後隨機
    if (rnd() < 0.5) { A.restore('v1-' + docId); B.restore('v2-' + docId); } else { B.restore('v2-' + docId); A.restore('v1-' + docId); }
    await within(Promise.all([rA, rB]), 15000, 'both restore results');
    await sleep(200);
    stop();
    await quiesce([A, B, C], 20000);
    const fails = [];
    const fin = await loadFromDb(docId);
    checkConverged(fails, [A, B, C], fin);
    const jobs = (await db.query('select target_version_id, seq from restore_jobs where page_id=$1 order by seq', [docId])).rows;
    if (jobs.length !== 2) fails.push('restore_jobs != 2');
    const later = jobs[jobs.length - 1]?.target_version_id;
    const laterJson = later?.startsWith('v1') ? v1.json : v2.json;
    const brCount = Number((await db.query(`select count(*) from page_versions where page_id=$1 and reason='before_restore'`, [docId])).rows[0].count);
    if (brCount !== 2) fails.push('before_restore versions != 2');
    const ep = (await db.query('select restore_epoch from pages where id=$1', [docId])).rows[0].restore_epoch;
    if (ep !== 2) fails.push('restore_epoch != 2');
    if (!withTyping && fin.json !== laterJson) fails.push('final != later restore target');
    if (withTyping) {
      const nonC = new Set([...fin.tokens].filter(t => !t.startsWith('[Cx')));
      const laterTokens = new Set(JSON.parse(laterJson).join(' ').match(/\[[A-Za-z]+\d+\]/g) || []);
      checkTokens(fails, 'non-C tokens vs later target', nonC, laterTokens);
      const before = await versionTokens(docId, 'before_restore');
      const copies = await conflictCopyTokens(docId);
      const lost = [...typed].filter(t => !fin.tokens.has(t) && !before.has(t) && !copies.tokens.has(t));
      if (lost.length) fails.push(`C silently lost ${lost.length}`);
    }
    return [fails, { withTyping, order: jobs.map(j => j.target_version_id.slice(0, 2)).join('>') }];
    });
  }
  return rec.save();
}

// ---------- M0-09：還原流程中途當機 ----------
export async function m0_09(Nper) {
  const points = ['restore:before_tx', 'restore:mid_tx', 'restore:before_commit', 'restore:after_commit', 'restore:after_broadcast'];
  const rec = new Recorder('M0-09', '在還原流程各步驟之間強制終止，以同一 restore_id 重試：完全未套用或只套用一次');
  let i = 0;
  for (const p of points) {
    for (let k = 0; k < Nper; k++, i++) {
      const seed = 90900 + i;
      await runIter(rec, i, seed, async () => {
      const rnd = rng(seed);
      const srv = new ServerProc(27109, { COMPACT_EVERY: '1000000' });
      await srv.start();
      const docId = randomUUID();
      const A = await mkClient(srv.url, docId, 'ua', 'A', rnd);
      const B = await mkClient(srv.url, docId, 'ub', 'B', rnd);
      A.connect(); B.connect();
      await quiesce([A, B]);
      for (let j = 0; j < 10; j++) A.type(`[Aa${j}]`);
      await quiesce([A, B]);
      const target = await B.makeVersion('t-' + docId);
      for (let j = 0; j < 10; j++) A.type(`[Ab${j}]`);
      await quiesce([A, B]);
      await srv.stop();
      await srv.start({ FAULT_POINT: p });
      await quiesce([A, B]);
      const restoreId = B.restore('t-' + docId);
      await srv.exited();
      await srv.start();
      const fails = [];
      try {
        await waitFor(() => B.storage.pendingRestores.length === 0, 15000, 'restore retried');
        await quiesce([A, B], 20000);
      } catch (e) { fails.push(e.message); }
      const fin = await loadFromDb(docId);
      checkConverged(fails, [A, B], fin);
      const q = async (sql) => Number((await db.query(sql, [docId, restoreId])).rows[0].count);
      if (await q('select count(*) from restore_jobs where page_id=$1 and id=$2') !== 1) fails.push('restore_jobs != 1');
      if (await q(`select count(*) from doc_update_ids where page_id=$1 and update_id='restore:'||$2`) !== 1) fails.push('restore update count != 1');
      if (await q(`select count(*) from page_versions where page_id=$1 and restore_id=$2 and reason='before_restore'`) !== 1) fails.push('before_restore != 1');
      const ep = (await db.query('select restore_epoch from pages where id=$1', [docId])).rows[0].restore_epoch;
      if (ep !== 1) fails.push('restore_epoch = ' + ep);
      if (fin.json !== target.json) fails.push('final != target');
      return [fails, { point: p }];
    });
    }
  }
  return rec.save();
}

// ---------- M0-10：登出與本機草稿 ----------
export async function m0_10(Nper) {
  const rec = new Recorder('M0-10', '登出、被撤銷、換帳號：未經明確捨棄，未確認的修改都不會被清除');
  let i = 0;
  for (let k = 0; k < Nper; k++) {
    // (a) 沒有未確認修改：直接登出並清除
    {
      const seed = 101000 + i;
      await runIter(rec, i++, seed, async () => {
      const rnd = rng(seed); const fails = [];
      const srv = new ServerProc(27110); await srv.start();
      const docId = randomUUID();
      const A = await mkClient(srv.url, docId, 'ua', 'A', rnd);
      A.connect(); await quiesce([A]);
      A.type('[A0]'); await quiesce([A]);
      const r = await A.logout({ waitMs: 2000 });
      if (r.status !== 'logged_out' || A.storage.docUpdates.length !== 0) fails.push('clean logout did not clear');
      return [fails, { scenario: 'a-clean' }];
      });
    }
    // (b) 伺服器無法連線時登出：保留草稿，須確認才可捨棄；恢復後同步再登出
    {
      const seed = 101000 + i;
      await runIter(rec, i++, seed, async () => {
      const rnd = rng(seed); const fails = [];
      const srv = new ServerProc(27110); await srv.start();
      const docId = randomUUID();
      const A = await mkClient(srv.url, docId, 'ua', 'A', rnd);
      A.connect(); await quiesce([A]);
      await srv.kill9();
      for (let j = 0; j < 5; j++) A.type(`[Ab${j}]`);
      const n = A.pending.length;
      const r1 = await A.logout({ waitMs: 300 });
      if (r1.status !== 'unsynced' || A.pending.length !== n) fails.push('unsynced logout cleared drafts');
      const r2 = await A.discardAndLogout({});
      if (r2.status !== 'confirm_required' || A.pending.length !== n) fails.push('discard without confirmation cleared drafts');
      await srv.start();
      const r3 = await A.logout({ waitMs: 10000 });
      if (r3.status !== 'logged_out') fails.push('logout after recovery failed: ' + r3.status);
      const fin = await loadFromDb(docId);
      for (let j = 0; j < 5; j++) if (!fin.tokens.has(`[Ab${j}]`)) fails.push('draft not persisted before logout');
      return [fails, { scenario: 'b-offline' }];
      });
    }
    // (c) 有未確認修改時被其他裝置撤銷：草稿保留；同一帳號重新登入後補送
    {
      const seed = 101000 + i;
      await runIter(rec, i++, seed, async () => {
      const rnd = rng(seed); const fails = [];
      const srv = new ServerProc(27110); await srv.start();
      const docId = randomUUID();
      const A = await mkClient(srv.url, docId, 'ua', 'A', rnd);
      A.connect(); await quiesce([A]);
      await setDbFault(true);
      for (let j = 0; j < 5; j++) A.type(`[Ac${j}]`);
      await sleep(50);
      const revoked = new Promise(r => A.once('revoked', r));
      await revoke(A.token);
      await within(revoked, 5000, 'revoked event');
      if (A.pending.length === 0) fails.push('pending lost on revoke');
      await setDbFault(false);
      const storage = A.storage;
      const A2 = NewClient({ url: srv.url, docId, token: await newSession('ua'), userId: 'ua', name: 'A', rnd, storage });
      A2.connect();
      await quiesce([A2], 15000);
      const fin = await loadFromDb(docId);
      for (let j = 0; j < 5; j++) if (!fin.tokens.has(`[Ac${j}]`)) fails.push('draft not resent after re-login');
      return [fails, { scenario: 'c-revoked' }];
      });
    }
    // (d) 另一個帳號在同一裝置登入：須先下載或捨棄舊草稿
    {
      const seed = 101000 + i;
      await runIter(rec, i++, seed, async () => {
      const rnd = rng(seed); const fails = [];
      const srv = new ServerProc(27110); await srv.start();
      const docId = randomUUID();
      const A = await mkClient(srv.url, docId, 'ua', 'A', rnd);
      A.connect(); await quiesce([A]);
      await srv.kill9();
      for (let j = 0; j < 5; j++) A.type(`[Ad${j}]`);
      A.disconnect();
      const storage = A.storage;
      const U2 = NewClient({ url: srv.url, docId, token: await newSession('u2'), userId: 'u2', name: 'U', rnd, storage });
      let threw = false;
      try { U2.connect(); } catch { threw = true; }
      if (!threw || U2.blocked !== 'other_user_drafts') fails.push('other user was not blocked');
      const dl = U2.downloadUnsynced();
      if (!(dl.json.includes('[Ad0]') && dl.pending.length > 0)) fails.push('download missing drafts');
      if ((await U2.discardAndLogout({})).status !== 'confirm_required' || storage.pending.length === 0) fails.push('discard without confirm');
      if ((await U2.discardAndLogout({ confirm: true })).status !== 'logged_out_discarded') fails.push('confirmed discard failed');
      return [fails, { scenario: 'd-other-user' }];
      });
    }
    await setDbFault(false);
  }
  return rec.save();
}

// ---------- M0-11：撤銷登入後中斷連線 ----------
export async function m0_11(N) {
  const rec = new Recorder('M0-11', '協作中撤銷登入：2 秒內中斷，舊憑證無法重新連線');
  const lat = [];
  for (let i = 0; i < N; i++) {
    const seed = 111100 + i;
    await runIter(rec, i, seed, async () => {
    const rnd = rng(seed); const fails = [];
    const srv = new ServerProc(27111);
    await srv.start();
    const docId = randomUUID();
    const A = await mkClient(srv.url, docId, 'ua', 'A', rnd);
    A.connect(); await quiesce([A]);
    const stop = typing(A, { name: 'A', rnd, typed: new Set(), deleted: new Set() });
    await sleep(between(rnd, 20, 200));
    const revoked = new Promise(r => A.once('revoked', r));
    const t0 = Date.now();
    await revoke(A.token);
    const ok = await Promise.race([revoked.then(() => true), sleep(2000).then(() => false)]);
    const ms = Date.now() - t0;
    stop();
    if (!ok) fails.push('not disconnected within 2s');
    lat.push(ms);
    const A2 = NewClient({ url: srv.url, docId, token: A.token, userId: 'ua', name: 'A', rnd });
    const rej = new Promise(r => A2.once('revoked', r));
    A2.connect();
    const rejected = await Promise.race([rej.then(() => true), sleep(2000).then(() => false)]);
    if (!rejected) fails.push('revoked token could reconnect');
    return [fails, { latencyMs: ms }];
    });
  }
  lat.sort((a, b) => a - b);
  return rec.save({ latency: { p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)], max: lat[lat.length - 1] } });
}

// ---------- M0-17：資料庫長時間失效時的背壓與監控 ----------
// 審核指出 withRetry 無上限重試：本案例確認（1）待寫入佇列不超過 MAX_INBOX，超過時回覆 busy；
// （2）/health 揭露 dbDownSince 供告警；（3）資料庫恢復後所有修改都寫入、沒有遺失、沒有假的「已儲存」。
export async function m0_17(N) {
  const rec = new Recorder('M0-17', '資料庫失效 1～3 秒＋小佇列上限：佇列有界、回覆 busy、可監控、恢復後零遺失');
  const MAX = 25;
  for (let i = 0; i < N; i++) {
    const seed = 117000 + i;
    await runIter(rec, i, seed, async () => {
      const rnd = rng(seed); const fails = [];
      const srv = new ServerProc(27117, { MAX_INBOX: String(MAX) });
      await srv.start();
      const health = async () => (await fetch(`http://127.0.0.1:${srv.port}/health`)).json();
      const docId = randomUUID();
      const A = await mkClient(srv.url, docId, 'ua', 'A', rnd);
      const B = await mkClient(srv.url, docId, 'ub', 'B', rnd);
      A.connect(); B.connect();
      await quiesce([A, B]);
      const typed = new Set();
      let falseSaved = 0;
      // 資料庫失效期間不得出現「已儲存」：此時任何本輪新輸入都不可能已提交
      const stops = [A, B].map(c => typing(c, { name: c.name, rnd, minMs: 1, maxMs: 4, newBlock: c.name === 'B', typed, deleted: new Set() }));
      await sleep(between(rnd, 100, 400));
      await setDbFault(true);
      const outMs = between(rnd, 1000, 3000);
      const t0 = Date.now();
      let sawDown = false, maxInbox = 0;
      while (Date.now() - t0 < outMs) {
        const h = await health();
        if (h.dbDownSince) sawDown = true;
        maxInbox = Math.max(maxInbox, h.maxInbox);
        for (const c of [A, B]) if (c.saveStatus() === 'saved' && c.pending.length === 0 && Date.now() - t0 > 300) falseSaved++;
        await sleep(50);
      }
      await setDbFault(false);
      await sleep(between(rnd, 100, 300));
      stops.forEach(s => s());
      await quiesce([A, B], 30000);
      const h = await health();
      const fin = await loadFromDb(docId);
      checkConverged(fails, [A, B], fin);
      checkTokens(fails, 'database', fin.tokens, typed);
      if (!sawDown) fails.push('/health 未顯示 dbDownSince');
      if (h.dbDownSince) fails.push('恢復後 /health 仍顯示資料庫失效');
      if (h.maxInbox > MAX) fails.push(`待寫入佇列超過上限 ${h.maxInbox} > ${MAX}`);
      if (h.busy === 0) fails.push('沒有觸發 busy 背壓（測試未達目的）');
      if (falseSaved) fails.push('資料庫失效期間顯示已儲存 ' + falseSaved + ' 次');
      return [fails, { outMs, typed: typed.size, busy: h.busy, maxInbox: h.maxInbox, retries: h.retries }];
    });
  }
  return rec.save();
}

// 每個指定輪數包含的情境數（執行器據此檢查實際輪數是否完整）
m0_09.roundsPer = 5;   // 五個故障點
m0_10.roundsPer = 4;   // 四個情境
