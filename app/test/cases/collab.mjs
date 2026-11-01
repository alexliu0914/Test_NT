// M2-b 協作可見性與儲存狀態（M2 計畫 v0.5 §4：COL-01～04、COL-06、COL-07、COL-09～11）
// 全部在真正的 Chromium、正式登入（含兩步驟驗證）、正式協作伺服器與隔離的測試資料庫上執行；
// 判定同時檢查兩個用戶端與資料庫（不只看單邊畫面）。
import WebSocket from 'ws';
import { isDeepStrictEqual } from 'node:util';
import { db, newPage, sleep, setDbFault, newDevice, collabToken } from '../lib/harness.mjs';
import { loadFromDb } from '../lib/m0-compat.mjs';
import { Recorder, within, rng } from '../lib/recorder.mjs';
import { bootEnv, COLLAB_PORT } from '../lib/env.mjs';
import { blocksOfState } from '../../shared/export.js';
import { encodeAwareness, decodeAwareness } from '../../shared/awareness-codec.js';
import { deriveSaveState } from '../../shared/save-state.js';
import { loadPlaywright, launch, newProfileDir, rmProfile, useAgentCookies, installRelay, openDoc, waitSynced, typeAtEnd, blocks, status } from '../lib/browser.mjs';

const between = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const canon = x => JSON.parse(JSON.stringify(x));
// 區塊 JSON 中所有文字（遞迴取出 text 欄位）
function allText(x) {
  const out = [];
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') { if (typeof v.text === 'string') out.push(v.text); for (const [k, w] of Object.entries(v)) if (k !== 'text') walk(w); }
  })(x);
  return out.join('\n');
}
const dbBlocks = async docId => blocksOfState((await loadFromDb(docId)).update);
const dbText = async docId => allText(await dbBlocks(docId));
const count = (s, sub) => (sub ? String(s).split(sub).length - 1 : 0);
const lat = arr => { const a = arr.filter(Number.isFinite).sort((x, y) => x - y); return { n: arr.length, p50: a[Math.floor(a.length / 2)] ?? null, p95: a[Math.floor(a.length * 0.95)] ?? null, max: a.at(-1) ?? null }; };

// 每位使用者一個瀏覽器（獨立的設定檔與登入）
async function openBrowsers(pw, users, { relay = [] } = {}) {
  const out = [];
  for (const [i, u] of users.entries()) {
    const dir = newProfileDir();
    const ctx = await launch(pw, dir);
    await useAgentCookies(ctx, u.agent);
    const P = ctx.pages()[0] || await ctx.newPage();
    const r = relay.includes(i) ? await installRelay(P) : null;
    out.push({ u, dir, ctx, P, relay: r });
  }
  return out;
}
async function closeBrowsers(list) { for (const b of list) { await b.ctx.close().catch(() => {}); rmProfile(b.dir); } }
function pageErrors(list, fails) {
  for (const b of list) for (const p of b.ctx.pages()) if (p.__errors && p.__errors.length) { fails.push('page error: ' + p.__errors.slice(0, 3).join(' / ')); p.__errors = []; }
}
async function checkConverged(fails, label, pages, docId) {
  const bs = [];
  for (const P of pages) bs.push(canon(await blocks(P)));
  const bd = canon(await dbBlocks(docId));
  for (let i = 1; i < bs.length; i++) if (!isDeepStrictEqual(bs[0], bs[i])) fails.push(`${label}：第 1 與第 ${i + 1} 個編輯器內容不一致`);
  if (!isDeepStrictEqual(bs[0], bd)) fails.push(`${label}：編輯器與資料庫不一致`);
  return bd;
}
const peers = P => P.evaluate(() => window.__app.peers());
const awId = P => P.evaluate(() => window.__app.awarenessClientId());
const me = P => P.evaluate(() => window.__app.me());
const statusLog = P => P.evaluate(() => window.__app.statusLog());
const focusEnd = async P => { await P.locator('.bn-editor').focus(); await P.keyboard.press('Control+End'); };
const timed = async (fn, ms) => { const t0 = Date.now(); const ok = await fn(ms).then(() => true, () => false); return { ok, ms: Date.now() - t0 }; };

// 沒有瀏覽器的協作連線（COL-04：冒名、跨頁觀察、異常斷線）
async function rawConn(agent, pageId) {
  const token = await collabToken(agent, pageId);
  const ws = new WebSocket(`ws://127.0.0.1:${COLLAB_PORT}`);
  const msgs = [];
  ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ t: 'hello', docId: pageId, token }));
  const t0 = Date.now();
  while (!msgs.some(m => m.t === 'welcome')) { if (Date.now() - t0 > 10000) throw new Error('raw: no welcome'); await sleep(20); }
  const sendAw = (clientId, clock, state) => ws.send(JSON.stringify({ t: 'aw', data: Buffer.from(encodeAwareness([{ clientId, clock, state }])).toString('base64') }));
  return { ws, msgs, welcome: msgs.find(m => m.t === 'welcome'), sendAw, close: () => { try { ws.terminate(); } catch { /* */ } } };
}

// ---------------- COL-01：同段落並發輸入，1 秒內可見 ----------------
// 兩人在同一個段落同時輸入（偶數輪：同一位置＝段落結尾；奇數輪：一人在開頭、一人在結尾）。
// 每段輸入完成後量對方編輯器出現該段全部字元的時間（必須 ≤1 秒）；最後兩端與資料庫一致，每個字元的數量與輸入的完全相同（無遺失、無重複）。
const ALPHA_A = '甲乙丙丁戊己庚辛', ALPHA_B = '子丑寅卯辰巳午未';
export async function col01(N) {
  const rec = new Recorder('COL-01', '同段落並發輸入：無字元遺失或重複、兩端與資料庫一致、對方 1 秒內可見（記錄延遲）');
  const env = await bootEnv({ users: 2 });
  const pw = await loadPlaywright();
  const S = await openBrowsers(pw, env.users);
  const all = [];
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try { await within(round(r, fails, m), 120000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      pageErrors(S, fails);
      rec.add(r, 1000 + r, fails, m);
    }
  } finally { await closeBrowsers(S); }
  return rec.save({ latency: lat(all) });

  async function round(r, fails, m) {
    const rnd = rng(1000 + r);
    const docId = await newPage(env.users[0].agent, 'COL-01 ' + r);
    const [A, B] = S.map(s => s.P);
    await openDoc(A, env.base, docId); await openDoc(B, env.base, docId);
    await waitSynced(A); await waitSynced(B);
    await typeAtEnd(A, '段', { where: 'first' });
    await waitSynced(A); await waitSynced(B);
    const same = r % 2 === 0;
    const typed = { A: {}, B: {} };
    const waits = [];
    async function writer(P, other, who, alpha, atStart) {
      for (let i = 0; i < 6; i++) {
        const tok = Array.from({ length: between(rnd, 2, 5) }, () => alpha[Math.floor(rnd() * alpha.length)]).join('');
        await P.locator('.bn-editor').focus();
        await P.keyboard.press('Control+Home');
        if (!atStart) await P.keyboard.press('End');
        await P.keyboard.type(tok);
        for (const ch of tok) typed[who][ch] = (typed[who][ch] || 0) + 1;
        const need = { ...typed[who] };
        const t0 = Date.now();
        waits.push(other.waitForFunction(nd => {
          const t = window.__app.text();
          return Object.entries(nd).every(([ch, n]) => t.split(ch).length - 1 >= n);
        }, need, { timeout: 5000, polling: 10 }).then(() => Date.now() - t0, () => Infinity));
        await sleep(between(rnd, 20, 200));
      }
    }
    await Promise.all([writer(A, B, 'A', ALPHA_A, !same), writer(B, A, 'B', ALPHA_B, false)]);
    const ls = await Promise.all(waits);
    all.push(...ls);
    m.latency = lat(ls); m.same = same;
    const slow = ls.filter(x => x > 1000);
    if (slow.length) fails.push(`對方超過 1 秒才看到：${slow.map(x => (Number.isFinite(x) ? x + 'ms' : '逾時')).join(',')}`);
    await waitSynced(A); await waitSynced(B);
    const bd = await checkConverged(fails, '最終', [A, B], docId);
    const txt = { A: await A.evaluate(() => window.__app.text()), B: await B.evaluate(() => window.__app.text()), DB: allText(bd) };
    for (const [where, t] of Object.entries(txt)) {
      for (const who of ['A', 'B']) for (const [ch, n] of Object.entries(typed[who])) {
        const got = count(t, ch);
        if (got !== n) fails.push(`${where} 中「${ch}」有 ${got} 個，輸入了 ${n} 個（${got < n ? '遺失' : '重複'}）`);
      }
    }
    if (count(txt.DB, '段') !== 1) fails.push('原有文字「段」數量不對：' + count(txt.DB, '段'));
  }
}

// ---------------- COL-02：一方刪除區塊、另一方同時在該區塊輸入 ----------------
// 刪除與輸入同時發生（隨機先後 0～300 毫秒）。判定：沒有頁面錯誤；兩端與資料庫一致；被刪的區塊整個消失（原有文字不復活）；
// 前後兩段完整；B 之後在其他段落的輸入照常保存；兩人仍可繼續編輯並同步；兩端最後都顯示「已儲存」；只有一個頂層文件骨架。
export async function col02(N) {
  const rec = new Recorder('COL-02', '一方刪除區塊、另一方同時輸入：不崩潰、最終一致、刪除依 CRDT 規則生效、其他段落與後續編輯不受影響');
  const env = await bootEnv({ users: 2 });
  const pw = await loadPlaywright();
  const S = await openBrowsers(pw, env.users);
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try { await within(round(r, fails, m), 120000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      pageErrors(S, fails);
      rec.add(r, 2000 + r, fails, m);
    }
  } finally { await closeBrowsers(S); }
  return rec.save();

  async function round(r, fails, m) {
    const rnd = rng(2000 + r);
    const docId = await newPage(env.users[0].agent, 'COL-02 ' + r);
    const [A, B] = S.map(s => s.P);
    await openDoc(A, env.base, docId); await openDoc(B, env.base, docId);
    await waitSynced(A); await waitSynced(B);
    await typeAtEnd(A, `前段${r}`, { where: 'first' });
    await typeAtEnd(A, `目標段${r}`, { newBlock: true });
    await typeAtEnd(A, `後段${r}`, { newBlock: true });
    await waitSynced(A); await waitSynced(B);
    const target = await A.evaluate(t => window.__app.blocks().find(b => JSON.stringify(b.content).includes(t))?.id, `目標段${r}`);
    if (!target) throw new Error('找不到目標區塊');
    // B 把游標放在目標區塊結尾開始輸入；A 在隨機時間刪除整個區塊
    await B.locator('.bn-editor').focus();
    await B.evaluate(id => window.__app.editor.setTextCursorPosition(id, 'end'), target);
    const delay = between(rnd, 0, 300);
    m.delay = delay;
    const bTyping = (async () => { for (let i = 0; i < 4; i++) { await B.keyboard.type(`乙${r}c${i}`); await sleep(between(rnd, 10, 80)); } })();
    await sleep(delay);
    await A.evaluate(id => window.__app.editor.removeBlocks([id]), target);
    await bTyping;
    // 之後 B 在「後段」輸入；A 也在第一段輸入
    await sleep(300);
    const after = `乙${r}after`, afterA = `甲${r}after`;
    const back = await B.evaluate(t => window.__app.blocks().find(b => JSON.stringify(b.content).includes(t))?.id, `後段${r}`);
    if (!back) fails.push('「後段」不見了');
    else {
      await B.locator('.bn-editor').focus();
      await B.evaluate(id => window.__app.editor.setTextCursorPosition(id, 'end'), back);
      await B.keyboard.type(after);
    }
    await typeAtEnd(A, afterA, { where: 'first' });
    await waitSynced(A, 30000); await waitSynced(B, 30000);
    const bd = await checkConverged(fails, '最終', [A, B], docId);
    const t = allText(bd);
    if (t.includes(`目標段${r}`)) fails.push('被刪除的區塊原有文字仍在');
    if (!t.includes(`前段${r}`) || !t.includes(`後段${r}`)) fails.push('前後段落遺失');
    if (!t.includes(after)) fails.push('B 在其他段落的後續輸入遺失');
    if (!t.includes(afterA)) fails.push('A 的後續輸入遺失');
    m.bTokensKept = [0, 1, 2, 3].filter(i => t.includes(`乙${r}c${i}`)).length;
    const skel = (await loadFromDb(docId)).update;
    const tops = blocksOfState(skel);
    if (!Array.isArray(tops)) fails.push('文件骨架異常');
    for (const P of [A, B]) if ((await status(P)) !== 'saved') fails.push('最後狀態不是已儲存：' + await status(P));
  }
}

// ---------------- COL-03：一方離線 30 秒仍編輯，再重新連線 ----------------
export async function col03(N) {
  const rec = new Recorder('COL-03', '一方離線 30 秒持續編輯後重新連線：所有待確認 update_id 都被提交與確認，兩端與資料庫一致');
  const env = await bootEnv({ users: 2 });
  const pw = await loadPlaywright();
  const S = await openBrowsers(pw, env.users, { relay: [1] });
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try { await within(round(r, fails, m), 150000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      S[1].relay.goOnline();
      pageErrors(S, fails);
      rec.add(r, 3000 + r, fails, m);
    }
  } finally { await closeBrowsers(S); }
  return rec.save();

  async function round(r, fails, m) {
    const docId = await newPage(env.users[0].agent, 'COL-03 ' + r);
    const [A, B] = S.map(s => s.P);
    const relay = S[1].relay;
    await openDoc(A, env.base, docId); await openDoc(B, env.base, docId);
    await waitSynced(A); await waitSynced(B);
    await typeAtEnd(A, '開始', { where: 'first' });
    await waitSynced(A); await waitSynced(B);
    // 網路中斷但連線沒有關閉（封包不再往返）：B 應在連線存活檢查（8 秒）內改顯示「離線」，不能先顯示「儲存失敗」或「已儲存」
    relay.stall(true);
    const ts = Date.now();
    await typeAtEnd(B, ` 乙${r}s0q`);
    const seenStall = [];
    let offAt = null;
    while (Date.now() - ts < 12000) {
      const s = await status(B); seenStall.push(s);
      if (s === 'offline') { offAt = Date.now() - ts; break; }
      await sleep(100);
    }
    m.stallOfflineMs = offAt;
    if (offAt === null) fails.push('網路靜默中斷 12 秒仍未顯示離線：' + [...new Set(seenStall)].join(','));
    if (seenStall.includes('failed') || seenStall.includes('saved')) fails.push('網路靜默中斷時顯示了' + [...new Set(seenStall)].join(','));
    relay.stall(false);
    relay.goOffline();
    await B.waitForFunction(() => !window.__app.client.ready, null, { timeout: 5000 });
    const t0 = Date.now();
    const tokA = [], tokB = [`乙${r}s0q`];
    let k = 0;
    while (Date.now() - t0 < 30000) {
      const tb = `乙${r}o${k}q`, ta = `甲${r}k${k}q`;
      await typeAtEnd(B, ' ' + tb); tokB.push(tb);
      await typeAtEnd(A, ' ' + ta, { where: 'first' }); tokA.push(ta);
      k++;
      await sleep(4000);
    }
    await B.waitForFunction(() => window.__app.persisted(), null, { timeout: 5000 });
    await B.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.dataset.state === 'offline', null, { timeout: 2000 }).catch(() => {});
    const st = await B.getByTestId('save-status').getAttribute('data-state');
    if (st !== 'offline') fails.push('離線時狀態應為「離線，內容保存在此裝置」，實際 ' + st);
    const ids = await B.evaluate(() => window.__app.client.storage.pending.flatMap(e => [e.id, ...(e.covers || [])]));
    m.pendingIds = ids.length; m.offlineMs = Date.now() - t0;
    if (!ids.length) fails.push('離線期間沒有待確認項目（測試未達目的）');
    const before = await B.evaluate(() => window.__app.statusLog().length);
    relay.goOnline();
    await waitSynced(B, 30000); await waitSynced(A, 30000);
    const got = new Set((await db.query('select update_id from doc_update_ids where page_id=$1 and update_id = any($2::text[])', [docId, ids])).rows.map(x => x.update_id));
    const lost = ids.filter(id => !got.has(id));
    if (lost.length) fails.push(`有 ${lost.length} 個待確認 update_id 沒有提交`);
    await B.waitForFunction(() => window.__app.statusLog().at(-1)?.s === 'saved', null, { timeout: 3000 }).catch(() => {});
    const log = (await statusLog(B)).slice(Math.max(0, before - 1));
    const bad = log.filter(e => e.s === 'saved' && e.pending > 0);
    if (bad.length) fails.push('還有待確認項目時顯示已儲存');
    const bd = await checkConverged(fails, '重新連線後', [A, B], docId);
    const t = allText(bd);
    for (const tk of [...tokA, ...tokB]) if (count(t, tk) !== 1) fails.push(`${tk} 出現 ${count(t, tk)} 次`);
  }
}

// ---------------- COL-04：游標、名字、顏色 ----------------
// 四個帳號（A＝管理者、B、C、D）；伺服器色票縮為 3 色（PALETTE_SIZE=3），心跳 0.5 秒、存活 2 秒（PRESENCE_TTL_MS）。
// 1. A、B、C 同頁、D 在另一頁：每人 1 秒內看到其他兩人的游標，名字是帳號名稱，三人顏色不同且與伺服器告知的一致
// 2. 冒名：A 的瀏覽器自填名字與顏色、另一條連線冒用 B 的 clientID ── 其他人看到的仍是伺服器確認的身分
// 3. 跨頁：D（另一頁）的畫面、awareness 與另一條在 D 頁面上的連線都收不到這頁的游標；游標不寫入資料庫、不影響「已儲存」
// 4. 同帳號兩條連線：A 開第二個分頁，兩個游標同名同色；關閉其中一個只移除那一個
// 5. 色票：C 離開後 D 加入，D 拿到 C 釋放的顏色；C 回來時色票用完，允許重複顏色但四個名字都不同
// 6. 異常斷線：一條連線停止回應（沒有關閉 TCP），2 秒存活時間後游標被清除
export async function col04(N) {
  const rec = new Recorder('COL-04', '同頁游標／名字／顏色：伺服器確認身分、冒名無效、不跨頁、同帳號雙連線、色票分配與回收、異常斷線清理');
  const env = await bootEnv({ users: 4, collabEnv: { PALETTE_SIZE: '3', HEARTBEAT_MS: '500', PRESENCE_TTL_MS: '2000' } });
  const pw = await loadPlaywright();
  const S = await openBrowsers(pw, env.users);
  const names = Object.fromEntries((await db.query('select id, name from "user"')).rows.map(x => [x.id, x.name]));
  const first = [];
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try { await within(round(r, fails, m), 150000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      pageErrors(S, fails);
      for (const p of S[0].ctx.pages().slice(1)) await p.close().catch(() => {});
      rec.add(r, 4000 + r, fails, m);
    }
  } finally { await closeBrowsers(S); }
  return rec.save({ latency: lat(first) });

  async function round(r, fails, m) {
    const [sa, sb, sc, sd] = S;
    const [A, B, C, D] = S.map(s => s.P);
    const X = await newPage(sa.u.agent, 'COL-04 X ' + r), Y = await newPage(sa.u.agent, 'COL-04 Y ' + r);
    for (const [P, id] of [[A, X], [B, X], [C, X], [D, Y]]) await openDoc(P, env.base, id);
    for (const P of [A, B, C, D]) await waitSynced(P);
    const obsY = await rawConn(sd.u.agent, Y);   // D 頁面上的另一條連線：不應收到 X 的任何游標
    // 1. 三人放置游標；量其他人畫面出現游標的時間
    const nm = s => names[s.u.id];
    const seen = [];
    for (const [P, s] of [[A, sa], [B, sb], [C, sc]]) {
      await focusEnd(P);
      const t0 = Date.now();
      await P.keyboard.type(`${r}`);
      for (const [Q, s2] of [[A, sa], [B, sb], [C, sc]]) if (s2 !== s) seen.push(Q.locator(`[data-testid="remote-cursor"][data-name="${nm(s)}"]`).first().waitFor({ state: 'attached', timeout: 5000 }).then(() => Date.now() - t0, () => Infinity));
    }
    const ls = await Promise.all(seen);
    first.push(...ls); m.cursorMs = lat(ls);
    if (ls.some(x => x > 1000)) fails.push('游標超過 1 秒才出現：' + ls.map(x => (Number.isFinite(x) ? x : '逾時')).join(','));
    const meOf = { A: await me(A), B: await me(B), C: await me(C) };
    const pv = { A: await peers(A), B: await peers(B), C: await peers(C) };
    for (const [k, s] of [['A', sa], ['B', sb], ['C', sc]]) {
      if (!meOf[k] || meOf[k].name !== nm(s)) fails.push(`${k} 的伺服器身分名字不對：${JSON.stringify(meOf[k])}`);
      const others = pv[k];
      if (others.length !== 2) fails.push(`${k} 看到的人數 ${others.length}（應為 2）`);
      for (const [k2, s2] of [['A', sa], ['B', sb], ['C', sc]]) {
        if (k2 === k) continue;
        const p = others.find(x => x.name === nm(s2));
        if (!p) fails.push(`${k} 看不到 ${k2}`);
        else if (p.color !== meOf[k2]?.color) fails.push(`${k} 看到的 ${k2} 顏色 ${p.color} 與伺服器告知的 ${meOf[k2]?.color} 不同`);
      }
    }
    const colors = new Set([meOf.A?.color, meOf.B?.color, meOf.C?.color]);
    if (colors.size !== 3) fails.push('三人同頁卻有相同顏色：' + [...colors].join(','));
    m.colors = meOf;
    // 2. 冒名
    await A.evaluate(() => window.__app.client.awareness.setLocalStateField('user', { name: '偽造者', color: '#000000' }));
    const bId = await awId(B);
    const atk = await rawConn(sa.u.agent, X);
    atk.sendAw(bId, 999, { user: { name: '偽造者B', color: '#000000' }, cursor: null });   // 冒用 B 的 clientID
    atk.sendAw(424242, 1, { user: { name: '偽造者C', color: '#111111' }, name: '偽造者C', cursor: null });
    await sleep(1200);
    for (const [k, P] of [['B', B], ['C', C]]) {
      const ps = await peers(P);
      if (ps.some(p => /偽造/.test(p.name) || p.color === '#000000' || p.color === '#111111')) fails.push(`${k} 看到冒名的名字或顏色：${JSON.stringify(ps)}`);
      const fake = ps.find(p => p.clientId === 424242);
      if (k === 'C' && (!fake || fake.name !== nm(sa) || fake.color !== meOf.A?.color)) fails.push('另一條連線的游標沒有被改成伺服器確認的身分：' + JSON.stringify(fake));
    }
    const cps = await peers(C);
    const bEntry = cps.find(p => p.clientId === bId);
    if (!bEntry || bEntry.name !== nm(sb)) fails.push('冒用 B 的 clientID 改變了 C 看到的 B：' + JSON.stringify(bEntry));
    atk.close();
    // 3. 跨頁與不持久化
    const dPeers = await peers(D);
    if (dPeers.length) fails.push('另一頁的 D 收到游標：' + JSON.stringify(dPeers));
    if (await D.locator('[data-testid="remote-cursor"]').count()) fails.push('另一頁的 D 畫面上有游標');
    // Y 頁上只有 D 自己：收到的游標只能是 D 的
    const leaked = obsY.msgs.filter(x => x.t === 'aw').flatMap(x => decodeAwareness(Buffer.from(x.data, 'base64'))).filter(e => e.state && e.state.user && e.state.user.name !== nm(sd));
    if (leaked.length) fails.push(`另一頁的連線收到 ${leaked.length} 則這一頁的游標：${[...new Set(leaked.map(e => e.state.user.name))].join(',')}`);
    const upsY0 = Number((await db.query('select count(*) from doc_update_ids where page_id=$1', [Y])).rows[0].count);
    await D.locator('.bn-editor').focus();
    for (const k of ['Home', 'End', 'ArrowUp', 'ArrowDown']) { await D.keyboard.press(k); await sleep(120); }
    await sleep(500);
    const upsY1 = Number((await db.query('select count(*) from doc_update_ids where page_id=$1', [Y])).rows[0].count);
    if (upsY1 !== upsY0) fails.push('只移動游標卻寫入了文件更新');
    if ((await status(D)) !== 'saved') fails.push('只移動游標，D 的狀態卻不是已儲存：' + await status(D));
    // 4. 同帳號兩條連線
    const A2 = await sa.ctx.newPage();
    await openDoc(A2, env.base, X); await waitSynced(A2);
    await focusEnd(A2); await A2.keyboard.press('Home');
    const a1Id = await awId(A), a2Id = await awId(A2);
    const two = await timed(ms => B.waitForFunction(([x, y]) => { const ps = window.__app.peers(); return ps.some(p => p.clientId === x) && ps.some(p => p.clientId === y && p.cursor); }, [a1Id, a2Id], { timeout: ms, polling: 20 }), 3000);
    if (!two.ok) fails.push('B 沒有看到 A 的第二條連線');
    else {
      const ps = await peers(B);
      const a = ps.filter(p => p.clientId === a1Id || p.clientId === a2Id);
      if (a.length !== 2 || a.some(p => p.name !== nm(sa) || p.color !== meOf.A?.color)) fails.push('同帳號兩條連線的名字或顏色不一致：' + JSON.stringify(a));
    }
    await A2.close();
    const gone = await timed(ms => B.waitForFunction(([x, y]) => { const ps = window.__app.peers(); return !ps.some(p => p.clientId === y) && ps.some(p => p.clientId === x); }, [a1Id, a2Id], { timeout: ms, polling: 20 }), 2000);
    if (!gone.ok) fails.push('關閉 A 的第二個分頁後，游標沒有正確移除（或錯刪了第一條）：' + JSON.stringify(await peers(B)));
    // 5. 色票回收與用完
    const cColor = meOf.C?.color;
    await openDoc(C, env.base, Y); await waitSynced(C);
    await B.waitForFunction(n => !window.__app.peers().some(p => p.name === n), nm(sc), { timeout: 3000, polling: 20 }).catch(() => fails.push('C 離開後游標沒有移除'));
    await openDoc(D, env.base, X); await waitSynced(D);
    const dMe = await me(D);
    if (dMe?.color !== cColor) fails.push(`D 沒有拿到 C 釋放的顏色（${dMe?.color} ≠ ${cColor}）`);
    await openDoc(C, env.base, X); await waitSynced(C);
    for (const P of [C, D]) { await focusEnd(P); await P.keyboard.press('Home'); }
    const four = await timed(ms => A.waitForFunction(n => { const ps = window.__app.peers(); return n.every(x => ps.some(p => p.name === x)); }, [nm(sb), nm(sc), nm(sd)], { timeout: ms, polling: 20 }), 3000);
    if (!four.ok) fails.push('四人同頁時 A 沒有看到另外三人：' + JSON.stringify(await peers(A)));
    const cMe2 = await me(C);
    const used = [meOf.A?.color, meOf.B?.color, dMe?.color];
    if (!used.includes(cMe2?.color)) fails.push('色票用完時應重複使用既有顏色：' + cMe2?.color);
    const shown = await A.locator('[data-testid="presence-user"]').evaluateAll(els => els.map(e => e.dataset.name));
    if (new Set(shown).size !== shown.length || ![nm(sb), nm(sc), nm(sd)].every(x => shown.includes(x))) fails.push('在線名單的名字無法分辨：' + shown.join(','));
    m.reuse = { c: cMe2?.color, d: dMe?.color };
    // 6. 異常斷線：連線停止回應心跳（TCP 不關閉）
    const frozen = await rawConn(sb.u.agent, X);
    frozen.sendAw(777000 + r, 1, { cursor: null });
    const appear = await timed(ms => A.waitForFunction(id => window.__app.peers().some(p => p.clientId === id), 777000 + r, { timeout: ms, polling: 20 }), 2000);
    if (!appear.ok) fails.push('停止回應前，A 沒有看到該連線的游標');
    frozen.ws._socket.pause();   // 不再讀取：收不到 ping、不回 pong
    const ttl = await timed(ms => A.waitForFunction(id => !window.__app.peers().some(p => p.clientId === id), 777000 + r, { timeout: ms, polling: 50 }), 5000);
    m.ttlMs = ttl.ms;
    if (!ttl.ok) fails.push('異常斷線的游標 5 秒內沒有被清除');
    if (!(await peers(A)).some(p => p.name === nm(sb))) fails.push('清除異常斷線時錯刪了 B 的游標');
    frozen.close(); obsY.close();
  }
}

// ---------------- COL-06：編輯中強制重啟協作服務 ----------------
export async function col06(N) {
  const rec = new Recorder('COL-06', '編輯中 kill -9 協作服務並重啟：自動重新連線、沒有未確認內容遺失、沒有重複套用');
  const env = await bootEnv({ users: 2 });
  const pw = await loadPlaywright();
  const S = await openBrowsers(pw, env.users);
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try { await within(round(r, fails, m), 150000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      if (!env.collab.proc || env.collab.proc.exitCode !== null || env.collab.proc.signalCode !== null) await env.collab.start();
      pageErrors(S, fails);
      rec.add(r, 6000 + r, fails, m);
    }
  } finally { await closeBrowsers(S); }
  return rec.save();

  async function round(r, fails, m) {
    const rnd = rng(6000 + r);
    const docId = await newPage(env.users[0].agent, 'COL-06 ' + r);
    const [A, B] = S.map(s => s.P);
    await openDoc(A, env.base, docId); await openDoc(B, env.base, docId);
    await waitSynced(A); await waitSynced(B);
    // A 在第一段、B 在第二段輸入（同一位置同時輸入會讓字元交錯，那是 COL-01 的範圍）
    await typeAtEnd(A, '甲段', { where: 'first' });
    await typeAtEnd(B, '乙段', { newBlock: true });
    await waitSynced(A); await waitSynced(B);
    const typed = [];
    let stop = false;
    const writer = async (P, u, opts) => { let i = 0; while (!stop) { const t = `${u}${r}k${i++}q`; await typeAtEnd(P, ' ' + t, opts); typed.push(t); await sleep(between(rnd, 30, 150)); } };
    const ws = [writer(A, 'A', { where: 'first' }), writer(B, 'B', { newBlock: false })];
    await sleep(between(rnd, 300, 1500));
    await env.collab.kill9();
    const down = between(rnd, 300, 2000);
    m.downMs = down;
    await sleep(down);
    await env.collab.start();
    await sleep(1000);
    stop = true;
    await Promise.all(ws);
    await waitSynced(A, 40000); await waitSynced(B, 40000);
    const bd = await checkConverged(fails, '重啟後', [A, B], docId);
    const t = allText(bd);
    const lost = typed.filter(x => count(t, x) === 0), dup = typed.filter(x => count(t, x) > 1);
    if (lost.length) fails.push('遺失：' + lost.join(','));
    if (dup.length) fails.push('重複套用：' + dup.join(','));
    m.typed = typed.length;
  }
}

// ---------------- COL-07：顯示「已儲存」後立即 kill -9；不對應的確認不能造成「已儲存」 ----------------
export async function col07(N) {
  const rec = new Recorder('COL-07', '顯示已儲存後立即強制終止協作服務：已確認的修改在資料庫與重啟後完整；不對應的確認不會讓狀態變成已儲存');
  const env = await bootEnv({ users: 2 });
  const pw = await loadPlaywright();
  const S = await openBrowsers(pw, env.users, { relay: [0] });
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try { await within(round(r, fails, m), 120000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      S[0].relay.setFilter(null); S[0].relay.goOnline();
      if (!env.collab.proc || env.collab.proc.exitCode !== null || env.collab.proc.signalCode !== null) await env.collab.start();
      pageErrors(S, fails);
      rec.add(r, 7000 + r, fails, m);
    }
  } finally { await closeBrowsers(S); }
  return rec.save();

  async function round(r, fails, m) {
    const docId = await newPage(env.users[0].agent, 'COL-07 ' + r);
    const [A, B] = S.map(s => s.P);
    const relay = S[0].relay;
    await openDoc(A, env.base, docId); await openDoc(B, env.base, docId);
    await waitSynced(A); await waitSynced(B);
    // 1. 輸入後一顯示「已儲存」就 kill -9
    const toks = [0, 1, 2].map(i => `A${r}k${i}`);
    for (const t of toks) await typeAtEnd(A, ' ' + t, { where: 'first' });
    await A.waitForFunction(() => window.__app.status() === 'saved', null, { timeout: 20000, polling: 5 });
    await env.collab.kill9();
    const dbt = await dbText(docId);
    const lostDb = toks.filter(t => !dbt.includes(t));
    if (lostDb.length) fails.push('顯示已儲存但資料庫沒有：' + lostDb.join(','));
    await env.collab.start();
    await waitSynced(A, 30000); await waitSynced(B, 30000);
    await checkConverged(fails, '重啟後', [A, B], docId);
    // 2. 不對應的確認：攔下 A 的確認，改送一個其他 update_id 的確認
    relay.setFilter(msg => (msg.includes('"t":"ack"') ? 'drop' : 'pass'));
    const t2 = `A${r}x0`;
    await typeAtEnd(A, ' ' + t2, { where: 'first' });
    await A.waitForFunction(() => window.__app.client.storage.pending.length > 0 && window.__app.persisted(), null, { timeout: 5000 });
    await sleep(300);
    relay.inject({ t: 'ack', ids: ['00000000-0000-4000-8000-' + String(r).padStart(12, '0')], seq: 1 });
    const samples = [];
    for (let i = 0; i < 15; i++) { samples.push(await status(A)); await sleep(100); }
    m.samples = [...new Set(samples)];
    if (samples.includes('saved')) fails.push('收到不對應的確認後顯示已儲存');
    // 放行後重新連線：伺服器依 update_id 去重並確認
    relay.setFilter(null);
    relay.dropConnections();
    await waitSynced(A, 30000); await waitSynced(B, 30000);
    const t = await dbText(docId);
    if (count(t, t2) !== 1) fails.push(`${t2} 在資料庫出現 ${count(t, t2)} 次`);
    await checkConverged(fails, '最終', [A, B], docId);
  }
}

// ---------------- COL-09：協作中撤銷登入 ----------------
// A 用兩個 session（兩台「裝置」）開同一頁、B 觀察。A 的第二台裝置以「登入裝置管理」撤銷第一台：
// 2 秒內第一台中斷並顯示登入失效、B 看不到它的游標（第二台的游標保留）；之後第一台的任何輸入都不會送出（重新整理後也不會補送）。
// 最後第二台異常斷線（網路中斷）時，B 也在 2 秒內看不到它的游標。
export async function col09(N) {
  const rec = new Recorder('COL-09', '協作中撤銷登入：2 秒內中斷、游標移除、不再推送內容、多連線只移除被撤銷的、未重新驗證不補送');
  const env = await bootEnv({ users: 2 });
  const pw = await loadPlaywright();
  const [UA, UB] = env.users;
  const S = await openBrowsers(pw, [UA, UA, UB], { relay: [1] });
  const lats = [];
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try { await within(round(r, fails, m), 120000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      S[1].relay.goOnline();
      pageErrors(S, fails);
      rec.add(r, 9000 + r, fails, m);
    }
  } finally { await closeBrowsers(S); }
  return rec.save({ latency: lat(lats) });

  async function round(r, fails, m) {
    const rnd = rng(9000 + r);
    // 每輪兩個新的 session
    const a1 = await newDevice(env.base, UA);
    const s1 = (await a1.get('/api/sessions')).json.sessions.find(s => s.current).id;
    const a2 = await newDevice(env.base, UA);
    await useAgentCookies(S[0].ctx, a1); await useAgentCookies(S[1].ctx, a2);
    const docId = await newPage(UB.agent, 'COL-09 ' + r);
    const [A1, A2, B] = S.map(s => s.P);
    for (const P of [A1, A2, B]) await openDoc(P, env.base, docId);
    for (const P of [A1, A2, B]) await waitSynced(P);
    for (const P of [A1, A2]) { await focusEnd(P); await P.keyboard.type(P === A1 ? '一' : '二'); }
    const id1 = await awId(A1), id2 = await awId(A2);
    await B.waitForFunction(([x, y]) => { const ps = window.__app.peers(); return ps.some(p => p.clientId === x && p.cursor) && ps.some(p => p.clientId === y && p.cursor); }, [id1, id2], { timeout: 5000, polling: 20 });
    // A1 持續輸入；隨機時間撤銷 A1 的 session
    let stop = false; const typedAfter = [];
    const writer = (async () => {
      let i = 0;
      while (!stop) {
        const revoked = (await status(A1)) === 'revoked';
        const t = `甲${r}k${i++}`;
        await typeAtEnd(A1, ' ' + t);
        if (revoked) typedAfter.push(t);
        await sleep(between(rnd, 30, 120));
      }
    })();
    await sleep(between(rnd, 200, 800));
    const seqAt = Number((await db.query('select last_seq from pages where id=$1', [docId])).rows[0].last_seq);
    const t0 = Date.now();
    const rv = await a2.del(`/api/sessions/${encodeURIComponent(s1)}`);
    if (rv.status !== 200) throw new Error('撤銷失敗 ' + rv.status + rv.text);
    const down = await timed(ms => A1.waitForFunction(() => window.__app.status() === 'revoked' && !window.__app.client.ready, null, { timeout: ms, polling: 10 }), 2000);
    const cur = await timed(ms => B.waitForFunction(x => !window.__app.peers().some(p => p.clientId === x), id1, { timeout: ms, polling: 10 }), Math.max(1, 2000 - (Date.now() - t0)));
    m.revokeMs = down.ms; m.cursorGoneMs = Date.now() - t0;
    lats.push(down.ms);
    if (!down.ok) fails.push('撤銷後 2 秒內沒有中斷');
    if (!cur.ok) fails.push('撤銷後 2 秒內 B 仍看到被撤銷連線的游標');
    if (!(await peers(B)).some(p => p.clientId === id2)) fails.push('撤銷一個 session 時錯刪了另一個 session 的游標');
    await sleep(1500);
    stop = true; await writer;
    // 被撤銷後輸入的內容：不在 B、不在資料庫；不會重新連線
    const bt = await B.evaluate(() => window.__app.text()), dt = await dbText(docId);
    const leak = typedAfter.filter(t => bt.includes(t) || dt.includes(t));
    if (leak.length) fails.push('撤銷後的輸入送到了伺服器：' + leak.join(','));
    if (await A1.evaluate(() => window.__app.client.ready)) fails.push('被撤銷的連線又連上了');
    // 撤銷之後這個帳號沒有新的文件更新（第二台裝置沒有輸入）
    const late = Number((await db.query('select count(*) from doc_updates where page_id=$1 and seq > $2 and user_id=$3', [docId, seqAt, UA.id])).rows[0].count);
    m.rowsAfterRevoke = late;
    // 重新整理：登入已失效，回到登入頁（或顯示登入失效），不補送
    await A1.reload();
    await A1.waitForLoadState('load');
    await sleep(800);
    const atLogin = new URL(A1.url()).pathname.startsWith('/login');
    const st = atLogin ? 'login' : await A1.evaluate(() => window.__app?.status()).catch(() => null);
    if (!atLogin && st !== 'revoked') fails.push('重新整理後沒有回到登入頁，也不是登入失效：' + st);
    const dt2 = await dbText(docId);
    if (typedAfter.some(t => dt2.includes(t))) fails.push('重新整理後補送了撤銷後的輸入');
    // 第二台網路中斷：B 2 秒內看不到它的游標
    S[1].relay.goOffline();
    const off = await timed(ms => B.waitForFunction(y => !window.__app.peers().some(p => p.clientId === y), id2, { timeout: ms, polling: 10 }), 2000);
    if (!off.ok) fails.push('另一連線中斷後 2 秒內游標仍在');
    m.typedAfter = typedAfter.length;
  }
}

// ---------------- COL-10：離線修改、關閉瀏覽器、重新連網開啟 ----------------
export async function col10(N) {
  const rec = new Recorder('COL-10', '離線修改後關閉瀏覽器、恢復網路重新開啟：草稿存活並補送，收到確認後才顯示已儲存');
  const env = await bootEnv({ users: 2 });
  const pw = await loadPlaywright();
  const [UA, UB] = env.users;
  const dB = newProfileDir(), cB = await launch(pw, dB);
  await useAgentCookies(cB, UB.agent);
  const B = cB.pages()[0] || await cB.newPage();
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      const dA = newProfileDir();
      try { await within(round(r, dA, fails, m), 120000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      rmProfile(dA);
      if (B.__errors && B.__errors.length) { fails.push('page error: ' + B.__errors.join(' / ')); B.__errors = []; }
      rec.add(r, 10000 + r, fails, m);
    }
  } finally { await cB.close(); rmProfile(dB); }
  return rec.save();

  async function round(r, dA, fails, m) {
    const docId = await newPage(UA.agent, 'COL-10 ' + r);
    let ctx = await launch(pw, dA);
    await useAgentCookies(ctx, UA.agent);
    let A = ctx.pages()[0] || await ctx.newPage();
    let relay = await installRelay(A);
    await openDoc(A, env.base, docId); await openDoc(B, env.base, docId);
    await waitSynced(A); await waitSynced(B);
    // 瀏覽器回報離線（context.setOffline 觸發 offline 事件）：2 秒內改為離線
    await ctx.setOffline(true);
    const off = await timed(ms => A.waitForFunction(() => !window.__app.client.ready && window.__app.status() !== 'saving', null, { timeout: ms, polling: 20 }), 2000);
    m.offlineMs = off.ms;
    if (!off.ok) fails.push('瀏覽器離線後 2 秒內沒有改為離線');
    const toks = [0, 1, 2].map(i => `A${r}o${i}`);
    for (const t of toks) await typeAtEnd(A, ' ' + t);
    await A.waitForFunction(() => window.__app.persisted(), null, { timeout: 5000 });
    await A.waitForFunction(() => document.querySelector('[data-testid="save-status"]')?.dataset.state === 'offline', null, { timeout: 2000 }).catch(() => {});
    const st = await A.getByTestId('save-status').getAttribute('data-state');
    const label = await A.getByTestId('save-status').textContent();
    if (st !== 'offline' || !label.includes('離線，內容保存在此裝置')) fails.push(`離線時狀態應為「離線，內容保存在此裝置」，實際 ${st}／${label}`);
    // 側邊欄標示這一頁有尚未同步的修改
    const mark = await A.locator(`[data-testid="tree-row"][data-page-id="${docId}"] [data-testid="unsynced-mark"]`).waitFor({ timeout: 5000 }).then(() => true, () => false);
    if (!mark) fails.push('側邊欄沒有標示未同步');
    if (A.__errors && A.__errors.length) fails.push('page error: ' + A.__errors.join(' / '));
    await ctx.close();
    // 同一台裝置換成另一個帳號（B）開啟：看得到這一頁，但不能顯示 A 的未同步標示
    {
      const cx = await launch(pw, dA);
      await useAgentCookies(cx, UB.agent);
      const P = cx.pages()[0] || await cx.newPage();
      await P.goto(env.base + '/');
      await P.locator(`[data-testid="tree-row"][data-page-id="${docId}"]`).waitFor({ timeout: 15000 });
      await sleep(2500);
      if (await P.locator('[data-testid="unsynced-mark"]').count()) fails.push('另一個帳號在同一台裝置上看到 A 的未同步標示');
      await cx.close();
    }
    // 恢復網路、重新開啟；伺服器的訊息延遲 1.5 秒送達，以觀察「收到確認之前」的狀態
    ctx = await launch(pw, dA);
    await useAgentCookies(ctx, UA.agent);   // 登入 cookie 是工作階段 cookie，重新開啟瀏覽器時重新放入（同 BR-02）
    A = ctx.pages()[0] || await ctx.newPage();
    relay = await installRelay(A);
    relay.setDelay(1500);
    await openDoc(A, env.base, docId);
    const local = await A.evaluate(() => window.__app.text());
    const missLocal = toks.filter(t => !local.includes(t));
    if (missLocal.length) fails.push('重新開啟後本機草稿遺失：' + missLocal.join(','));
    const early = [];
    for (let i = 0; i < 8; i++) { early.push(await status(A)); await sleep(100); }
    m.early = [...new Set(early)];
    if (early.includes('saved')) fails.push('伺服器確認前就顯示已儲存');
    await waitSynced(A, 30000);
    relay.setDelay(0);
    await A.waitForFunction(() => window.__app.statusLog().some(e => e.s === 'saved'), null, { timeout: 3000 }).catch(() => {});
    const log = await statusLog(A);
    if (log.some(e => e.s === 'saved' && e.pending > 0)) fails.push('還有待確認項目時顯示已儲存');
    const firstSaved = log.findIndex(e => e.s === 'saved');
    if (firstSaved < 0) fails.push('沒有出現已儲存');
    const dt = await dbText(docId);
    const lost = toks.filter(t => count(dt, t) !== 1);
    if (lost.length) fails.push('資料庫沒有（或重複）補送的內容：' + lost.join(','));
    await waitSynced(B, 30000);
    await checkConverged(fails, '補送後', [A, B], docId);
    const cleared = await A.locator(`[data-testid="tree-row"][data-page-id="${docId}"] [data-testid="unsynced-mark"]`).waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false);
    if (!cleared) fails.push('同步後側邊欄仍標示未同步');
    if (A.__errors && A.__errors.length) fails.push('page error: ' + A.__errors.join(' / '));
    await ctx.close();
  }
}

// ---------------- COL-11：資料庫無法寫入期間繼續編輯 ----------------
// 協作伺服器的待寫入上限縮為 5（MAX_INBOX），驗證背壓。資料庫故障期間：狀態顯示「儲存失敗」而不是「已儲存」、
// 修改已寫入本機、伺服器回覆 busy；恢復後所有輸入只出現一次、兩端與資料庫一致。另檢查狀態判定表的交疊情境（save-state.js）。
export async function col11(N) {
  const rec = new Recorder('COL-11', '資料庫不可寫期間繼續編輯：顯示儲存失敗、背壓與本機暫存生效；恢復後無遺失、無重複');
  const env = await bootEnv({ users: 2, collabEnv: { MAX_INBOX: '5' } });
  const pw = await loadPlaywright();
  const S = await openBrowsers(pw, env.users);
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try { await within(round(r, fails, m), 150000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      await setDbFault(false);
      pageErrors(S, fails);
      rec.add(r, 11000 + r, fails, m);
    }
  } finally { await setDbFault(false); await closeBrowsers(S); }
  return rec.save();

  async function round(r, fails, m) {
    tableCheck(fails);
    const docId = await newPage(env.users[0].agent, 'COL-11 ' + r);
    const other = await newPage(env.users[0].agent, 'COL-11 其他 ' + r);
    const [A, B] = S.map(s => s.P);
    await openDoc(A, env.base, docId); await openDoc(B, env.base, docId);
    await waitSynced(A); await waitSynced(B);
    const health = async () => (await fetch(`http://127.0.0.1:${COLLAB_PORT}/health`)).json();
    const busy0 = (await health()).busy;
    await setDbFault(true);
    const toks = [];
    const t0 = Date.now();
    let sawFailed = null;
    const samples = [];
    // 連續輸入（每個字元一筆更新，超過待寫入上限會收到 busy）
    for (let i = 0; i < 8; i++) {
      const t = `A${r}f${i}`; toks.push(t);
      await typeAtEnd(A, ' ' + t, { where: 'first' });
      const s = await status(A);
      samples.push(s);
      if (s === 'failed' && sawFailed === null) sawFailed = Date.now() - t0;
      await sleep(150);
    }
    for (let i = 0; i < 20; i++) { const s = await status(A); samples.push(s); if (s === 'failed' && sawFailed === null) sawFailed = Date.now() - t0; await sleep(100); }
    m.failedAfterMs = sawFailed;
    m.samples = [...new Set(samples)];
    if (samples.includes('saved')) fails.push('資料庫無法寫入期間顯示已儲存');
    if (sawFailed === null || sawFailed > 3000) fails.push('資料庫故障後 3 秒內沒有顯示儲存失敗：' + m.samples.join(','));
    const label = await A.getByTestId('save-status').textContent();
    if (!label.includes('儲存失敗')) fails.push('狀態文字不是「儲存失敗」：' + label);
    if (!(await A.evaluate(() => window.__app.persisted()))) fails.push('故障期間修改沒有寫入本機');
    const idbPending = await A.evaluate(() => window.__app.store.load().then(v => (v?.pending || []).length));
    if (!idbPending) fails.push('本機草稿中沒有待確認的修改');
    const h = await health();
    m.busy = h.busy - busy0;
    if (!(h.busy > busy0)) fails.push('沒有觸發背壓（busy）');
    if (!h.dbDownSince) fails.push('/health 沒有顯示資料庫失效');
    // 站內切換頁面：仍有尚未同步的修改 → 等 1.5 秒後詢問；選「留在此頁」不切換
    await A.locator(`[data-testid="tree-row"][data-page-id="${other}"] button`).filter({ hasText: 'COL-11 其他' }).first().click();
    const asked = await A.getByTestId('leave-confirm').waitFor({ timeout: 5000 }).then(() => true, () => false);
    if (!asked) fails.push('有尚未同步的修改時切換頁面沒有詢問');
    else {
      await A.getByRole('button', { name: '留在此頁' }).click();
      await sleep(300);
      if (!A.url().includes(docId)) fails.push('選「留在此頁」後仍然切換了頁面');
    }
    const dbDuring = await dbText(docId);
    if (toks.some(t => dbDuring.includes(t))) fails.push('故障期間的修改竟已寫入資料庫（故障注入未生效）');
    await setDbFault(false);
    await waitSynced(A, 40000); await waitSynced(B, 40000);
    const t = await dbText(docId);
    for (const tk of toks) if (count(t, tk) !== 1) fails.push(`${tk} 在資料庫出現 ${count(t, tk)} 次`);
    await checkConverged(fails, '恢復後', [A, B], docId);
  }
}

// 狀態判定表（W3 要求的交疊情境）
function tableCheck(fails) {
  const base = { unsynced: true, unpersisted: false, connected: true, dbFailing: false, oldestPendingAgeMs: 0, failAfterMs: 10000 };
  const cases = [
    [{ unsynced: false }, 'saved'],
    [{}, 'saving'],
    [{ unpersisted: true }, 'unsaved'],
    [{ connected: false }, 'offline'],
    [{ dbFailing: true }, 'failed'],
    [{ oldestPendingAgeMs: 20000 }, 'failed'],
    [{ dbFailing: true, unpersisted: true }, 'unsaved'],
    [{ dbFailing: true, connected: false }, 'offline'],
    [{ dbFailing: true, connected: false, unpersisted: true }, 'unsaved'],
    [{ unsynced: false, dbFailing: true }, 'saved'],
  ];
  for (const [over, want] of cases) {
    const got = deriveSaveState({ ...base, ...over });
    if (got !== want) fails.push(`狀態判定 ${JSON.stringify(over)} → ${got}（應為 ${want}）`);
  }
}
