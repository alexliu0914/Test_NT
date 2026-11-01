// 瀏覽器端到端（M1：正式網頁、正式登入、正式協作伺服器）
// BR-01：M0-B 的 GATE-02 流程移植到正式網頁：兩人以鍵盤編輯（含中文）→ 資料庫提交 → 協作伺服器 kill -9 重啟
//        → 建立版本 → 一方輸入時另一方還原（線上衝突副本）→ 還原後 Undo 不復活 → 離線修改＋還原（離線衝突副本）
//        （音檔與完整匯出分屬 M3、M4，不在此案例）
// BR-02：見 browser-idb.mjs；BR-03：見 browser-ui.mjs
import { isDeepStrictEqual } from 'node:util';
import { db, newPage, sleep } from '../lib/harness.mjs';
import { loadFromDb } from '../lib/m0-compat.mjs';
import { Recorder, within } from '../lib/recorder.mjs';
import { bootEnv } from '../lib/env.mjs';
import { blocksOfState } from '../../shared/export.js';
import { loadPlaywright, launch, newProfileDir, rmProfile, useAgentCookies, installRelay, openDoc, waitReady, waitSynced, typeAtEnd, text, blocks, status, tokensIn } from '../lib/browser.mjs';

const stateTokens = state => tokensIn(JSON.stringify(blocksOfState(state)));
async function dbTokens(docId) { return stateTokens((await loadFromDb(docId)).update); }
async function dbBlocks(docId) { return blocksOfState((await loadFromDb(docId)).update); }
async function versionTokensOf(docId, reason) {
  const out = new Set();
  for (const r of (await db.query('select state from page_versions where page_id=$1 and reason=$2', [docId, reason])).rows)
    for (const t of stateTokens(new Uint8Array(r.state))) out.add(t);
  return out;
}
async function copyTokens(docId) {
  const rows = (await db.query('select content_json from conflict_copies where page_id=$1', [docId])).rows;
  const out = new Set();
  for (const r of rows) for (const t of tokensIn(r.content_json)) out.add(t);
  return { tokens: out, count: rows.length };
}
const canon = x => JSON.parse(JSON.stringify(x));
const missing = (need, have) => [...need].filter(t => !have.has(t));

async function checkConverged(fails, label, A, B, docId) {
  const [ba, bb, bd] = [await blocks(A), await blocks(B), await dbBlocks(docId)];
  if (!isDeepStrictEqual(canon(ba), canon(bb))) fails.push(`${label}: A/B 編輯器內容不一致`);
  if (!isDeepStrictEqual(canon(ba), canon(bd))) fails.push(`${label}: 編輯器與資料庫不一致`);
  return tokensIn(JSON.stringify(ba));
}

export async function br01(N) {
  const rec = new Recorder('BR-01', '瀏覽器端到端（正式網頁與登入）：兩人編輯／協作伺服器重啟／版本還原／衝突副本／Undo／離線');
  const env = await bootEnv({ users: 2 });
  const [UA, UB] = env.users;
  const pw = await loadPlaywright();
  const dA = newProfileDir(), dB = newProfileDir();
  const cA = await launch(pw, dA), cB = await launch(pw, dB);
  await useAgentCookies(cA, UA.agent); await useAgentCookies(cB, UB.agent);
  const pA = cA.pages()[0] || await cA.newPage();
  const pB = cB.pages()[0] || await cB.newPage();
  const relayB = await installRelay(pB);
  let onlineCopies = 0;
  try {
    for (let r = 0; r < N; r++) {
      const fails = [];
      const m = {};
      const t0 = Date.now();
      try { await within(round(r, fails, m), 150000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      m.ms = Date.now() - t0;
      for (const p of [pA, pB]) if (p.__errors && p.__errors.length) { fails.push('page error: ' + p.__errors.join(' / ')); p.__errors = []; }
      relayB.setDelay(0); relayB.goOnline();
      if (!env.collab.proc || env.collab.proc.exitCode !== null || env.collab.proc.signalCode !== null) await env.collab.start();
      rec.add(r, r, fails, m);
    }
  } finally {
    await cA.close(); await cB.close(); rmProfile(dA); rmProfile(dB);
  }
  return rec.save({ meta: { onlineCopyRounds: onlineCopies } });

  async function round(r, fails, m) {
    const docId = await newPage(UA.agent, '端到端 ' + r);
    const typed = new Set();
    const tk = (u, kind, i) => { const t = `${u}${r}${kind}${i}`; typed.add(t); return t; };
    const A = await openDoc(pA, env.base, docId);
    const B = await openDoc(pB, env.base, docId);
    await waitSynced(A); await waitSynced(B);

    // 1. 兩人以鍵盤輸入（含中文）：A 寫第一段，B 另起一段；之後兩人同時在各自的段落輸入
    await typeAtEnd(A, `甲${tk('A', 'k', 0)}`, { where: 'first' });
    await waitSynced(A); await waitSynced(B);
    await typeAtEnd(B, `乙${tk('B', 'k', 0)}`, { newBlock: true });
    await waitSynced(A); await waitSynced(B);
    await Promise.all([
      (async () => { for (let i = 1; i < 4; i++) await typeAtEnd(A, ` 甲${tk('A', 'k', i)}`, { where: 'first' }); })(),
      (async () => { for (let i = 1; i < 4; i++) await typeAtEnd(B, ` 乙${tk('B', 'k', i)}`); })(),
    ]);
    await waitSynced(A); await waitSynced(B);
    let cur = await checkConverged(fails, '1-編輯', A, B, docId);
    const miss1 = missing(typed, await dbTokens(docId));
    if (miss1.length) fails.push('1-資料庫缺少: ' + miss1.join(','));

    // 2. 伺服器 kill -9；停機期間兩人繼續輸入，必須先存到本機，重啟後補送
    await env.collab.kill9();
    await typeAtEnd(A, ` ${tk('A', 'd', 0)}`, { mode: 'insert', where: 'first' });
    await typeAtEnd(B, ` ${tk('B', 'd', 0)}`, { mode: 'insert' });
    await A.waitForFunction(() => window.__app.persisted(), null, { timeout: 5000 });
    await B.waitForFunction(() => window.__app.persisted(), null, { timeout: 5000 });
    const sDown = [await status(A), await status(B)];
    if (sDown.some(s => !['saving', 'offline'].includes(s))) fails.push('2-停機時狀態應為 saving/offline，實際 ' + sDown);
    await env.collab.start();
    await waitSynced(A); await waitSynced(B);
    cur = await checkConverged(fails, '2-重啟', A, B, docId);
    const miss2 = missing(typed, await dbTokens(docId));
    if (miss2.length) fails.push('2-重啟後資料庫缺少: ' + miss2.join(','));

    // 3. 建立版本 V1
    const v1 = 'v1-' + docId;
    await A.evaluate(id => window.__app.makeVersion(id), v1);
    const v1Tokens = new Set(cur);

    // 4. V1 之後的修改（還原後應消失，但保留在「還原前」版本）
    const after = [tk('A', 'k', 10), tk('A', 'k', 11)];
    for (const t of after) await typeAtEnd(A, ` ${t}`, { mode: 'insert', where: 'first' });
    await waitSynced(A); await waitSynced(B);

    // 5. 線上還原，同時 B 正在輸入（B 的回覆延遲 250ms，確保還原抵達時 B 仍有未確認修改）
    relayB.setDelay(250);
    const bTyping = (async () => { for (let i = 0; i < 6; i++) { await typeAtEnd(B, ` ${tk('B', 'c', i)}`, { mode: 'insert' }); await sleep(40); } })();
    await sleep(90);
    const rr = await A.evaluate(id => window.__app.restoreAndWait(id), v1);
    if (rr.status !== 'applied') fails.push('5-還原結果 ' + rr.status);
    await bTyping;
    relayB.setDelay(0);
    await waitSynced(A); await waitSynced(B);
    cur = await checkConverged(fails, '5-線上還原', A, B, docId);
    const before5 = await versionTokensOf(docId, 'before_restore');
    const copies5 = await copyTokens(docId);
    if (copies5.count > 0) onlineCopies++;
    m.onlineCopies = copies5.count;
    const lost5 = missing(typed, new Set([...cur, ...before5, ...copies5.tokens]));
    if (lost5.length) fails.push('5-遺失（不在現況／還原前版本／衝突副本）: ' + lost5.join(','));
    const missV1 = missing(v1Tokens, cur);
    if (missV1.length) fails.push('5-還原後缺少 V1 內容: ' + missV1.join(','));
    const resurrected = after.filter(t => cur.has(t));
    if (resurrected.length) fails.push('5-V1 之後的修改未被還原移除: ' + resurrected.join(','));
    if (missing(after, before5).length) fails.push('5-還原前版本缺少: ' + missing(after, before5).join(','));

    // 6. 還原後 Undo 不得讓還原前的內容復活（M0-07 的瀏覽器版本）
    //    還原前先在編輯器裡刪除 V1 既有的文字、再輸入新內容，讓 Undo 堆疊裡同時有「刪除」與「插入」；
    //    還原後連按 Undo，內容必須仍與 V1 完全相同（不清空 Undo 堆疊時，被刪除的舊文字會被加回來）
    const v1Blocks = canon(blocksOfState(new Uint8Array((await db.query('select state from page_versions where id=$1', [v1])).rows[0].state)));
    const selectBlockAndDelete = async (P, where) => {
      await P.locator('.bn-editor').focus();
      if (where === 'first') { await P.keyboard.press('Control+Home'); await P.keyboard.press('Shift+End'); }
      else { await P.keyboard.press('Control+End'); await P.keyboard.press('Shift+Home'); }
      await P.keyboard.press('Backspace');
    };
    const pressUndo = async (P, n) => { await P.locator('.bn-editor').focus(); for (let i = 0; i < n; i++) { await P.keyboard.press('Control+z'); await sleep(20); } };
    const checkIsV1 = async label => {
      await sleep(150); await waitSynced(A); await waitSynced(B);
      cur = await checkConverged(fails, label, A, B, docId);
      if (!isDeepStrictEqual(canon(await blocks(A)), v1Blocks)) fails.push(`${label}: Undo 後內容不等於還原目標 V1（${[...cur].filter(t => !v1Tokens.has(t)).join(',') || '結構不同'}）`);
    };
    // 6a. 他人還原
    await selectBlockAndDelete(A, 'first');
    await sleep(600);   // 讓下一個動作成為獨立的 Undo 步驟
    const u0 = tk('A', 'u', 0);
    await typeAtEnd(A, ` ${u0}`, { mode: 'insert' });
    await waitSynced(A); await waitSynced(B);
    const ui0 = await A.evaluate(() => window.__app.undoInfo());
    if (ui0.managers < 1 || ui0.depth < 1) fails.push('6a-還原前編輯器 Undo 堆疊應有內容 ' + JSON.stringify(ui0));
    await B.evaluate(id => window.__app.restoreAndWait(id), v1);
    await waitSynced(A); await waitSynced(B);
    const ui1 = await A.evaluate(() => window.__app.undoInfo());
    if (ui1.depth !== 0) fails.push('6a-收到還原後編輯器 Undo 堆疊未清空 ' + JSON.stringify(ui1));
    m.undoDepthBeforeRestore = ui0.depth;
    await pressUndo(A, 4);
    await checkIsV1('6a-他人還原後 Undo');
    // 6b. 自己還原
    await selectBlockAndDelete(A, 'first');
    await selectBlockAndDelete(B, 'last');
    await sleep(600);
    const u1 = tk('A', 'u', 1);
    await typeAtEnd(A, ` ${u1}`, { mode: 'insert', newBlock: true });
    await waitSynced(A); await waitSynced(B);
    await A.evaluate(id => window.__app.restoreAndWait(id), v1);
    await waitSynced(A); await waitSynced(B);
    await pressUndo(A, 4); await pressUndo(B, 4);
    await checkIsV1('6b-自己還原後 Undo');
    // 對照：確認鍵盤 Undo 確實有作用（否則上面的檢查沒有意義）
    const z = tk('A', 'u', 9);
    await typeAtEnd(A, ` ${z}`, { mode: 'insert' });
    await waitSynced(A);
    await sleep(600);
    await pressUndo(A, 1);
    await waitSynced(A); await waitSynced(B);
    if (tokensIn(await text(A)).has(z)) fails.push('6-對照：Ctrl+Z 沒有作用，Undo 測試無效');
    typed.delete(z);
    cur = await checkConverged(fails, '6-Undo', A, B, docId);

    // 7. B 離線修改；離線期間 A 還原；B 回線後先存衝突副本，再改用伺服器版本
    relayB.goOffline();
    await B.waitForFunction(() => !window.__app.client.ready, null, { timeout: 5000 });
    const offTok = [tk('B', 'o', 0), tk('B', 'o', 1)];
    for (const t of offTok) await typeAtEnd(B, ` ${t}`, { mode: 'insert' });
    await B.waitForFunction(() => window.__app.persisted(), null, { timeout: 5000 });
    await A.evaluate(id => window.__app.restoreAndWait(id), v1);
    await waitSynced(A);
    const copiesBefore = (await copyTokens(docId)).count;
    const reloaded = B.waitForEvent('load', { timeout: 20000 });
    relayB.goOnline();
    await reloaded;          // 衝突副本確認後頁面會重新載入
    await waitReady(B); await waitSynced(B); await waitSynced(A);
    cur = await checkConverged(fails, '7-離線還原', A, B, docId);
    const copies7 = await copyTokens(docId);
    if (copies7.count <= copiesBefore) fails.push('7-沒有建立離線衝突副本');
    if (missing(offTok, copies7.tokens).length) fails.push('7-衝突副本缺少離線內容: ' + missing(offTok, copies7.tokens).join(','));
    if (offTok.some(t => cur.has(t))) fails.push('7-離線內容未經確認就合併進還原後的頁面');
    const allVersions = new Set([...await versionTokensOf(docId, 'before_restore'), ...await versionTokensOf(docId, 'auto')]);
    const lost7 = missing(typed, new Set([...cur, ...allVersions, ...copies7.tokens]));
    if (lost7.length) fails.push('7-遺失: ' + lost7.join(','));

    m.typed = typed.size;
  }
}

export { text, status, waitReady };
