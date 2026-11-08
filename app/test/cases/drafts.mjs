// SEC-12（M2-c W5、附錄 B3）：登出流程與本機草稿的帳號隔離。每一輪依序：
//  a. 沒有待送：正常登出，這個帳號的草稿清除、session 撤銷
//  b. 有待送且伺服器可連：登出時 10 秒內同步成功，內容進資料庫後才登出
//  c. 有待送且伺服器連不上：10 秒後出現選項；繼續等待；下載 JSON（內容與待送一致、不含登入憑證）；取消（仍登入、草稿還在）；
//     保留草稿並登出（先顯示共用裝置警告），草稿留在 A 的分區
//  d. 同一台裝置換 B 登入：看不到、讀不到、不送出 A 的草稿，也看不到數量；B 正常登出不影響 A 的草稿
//  e. A 有待送時登入被撤銷，接著 B 登入：B 看不到；A 重新登入前不補送
//  f. B 有待送時失去空間權限，接著 A 在同一台裝置登入：A 看不到 B 的內容
//  g. A 重新登入：保留的草稿與撤銷前的待送恰好一次進入資料庫
//  h. 捨棄並登出（二次確認）：只刪 A 自己的草稿，B 保留的草稿不受影響、之後由 B 補送
//  i. 舊資料遷移：版本 1 的 doc:<頁面> 資料（有 userId 的、沒有 userId 的）、升級中斷回滾、舊分頁擋住升級；
//     無法辨識所有者的草稿只顯示中性數量、不載入不送出，清除需二次確認
import { readFileSync } from 'node:fs';
import { db, newPage, newDevice, sleep } from '../lib/harness.mjs';
import { loadFromDb } from '../lib/m0-compat.mjs';
import { Recorder, within } from '../lib/recorder.mjs';
import { bootEnv } from '../lib/env.mjs';
import { blocksOfState } from '../../shared/export.js';
import { loadPlaywright, launch, newProfileDir, rmProfile, useAgentCookies, installRelay, openDoc, waitSynced, typeAtEnd, text, tokensIn } from '../lib/browser.mjs';

const dbJson = async id => JSON.stringify(blocksOfState((await loadFromDb(id)).update));
const count = (s, sub) => s.split(sub).length - 1;
const sessionIdOf = async agent => (await db.query('select id from "session" where token = $1', [decodeURIComponent(agent.cookies.get('better-auth.session_token') || '').split('.')[0]])).rows[0]?.id;

// 直接讀 IndexedDB（測試用，與產品介面無關）
const rawKeys = P => P.evaluate(() => new Promise(res => {
  const rq = indexedDB.open('notes-drafts');
  rq.onsuccess = () => {
    const db = rq.result;
    if (!db.objectStoreNames.contains('drafts')) { db.close(); res({ version: db.version, keys: [] }); return; }
    const g = db.transaction('drafts', 'readonly').objectStore('drafts').getAllKeys();
    g.onsuccess = () => { const v = db.version; db.close(); res({ version: v, keys: g.result.map(String) }); };
  };
  rq.onerror = () => res({ version: 0, keys: [] });
}));
const rawGet = (P, key) => P.evaluate(k => new Promise(res => {
  const rq = indexedDB.open('notes-drafts');
  rq.onsuccess = () => { const db = rq.result; const g = db.transaction('drafts', 'readonly').objectStore('drafts').get(k); g.onsuccess = () => { db.close(); res(g.result || null); }; };
}), key);

export async function sec12(N) {
  const rec = new Recorder('SEC-12', '登出：無待送正常登出、10 秒同步、逾時的等待／下載／保留／捨棄／取消；草稿依帳號分區（換帳號、撤銷、失去權限）；舊草稿遷移與無所有者隔離');
  const env = await bootEnv({ users: 2 });
  const [UA, UB] = env.users;
  const pw = await loadPlaywright();
  for (let r = 0; r < N; r++) {
    const fails = [], m = {};
    const dir = newProfileDir();
    const ctx = await launch(pw, dir);
    try { await within(round(r, fails, m, ctx), 420000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
    for (const P of ctx.pages()) { if (P.__errors && P.__errors.length) fails.push('page error: ' + P.__errors.slice(0, 2).join(' / ')); }
    await ctx.close().catch(() => {});
    rmProfile(dir);
    rec.add(r, 170000 + r, fails, m);
  }
  return rec.save();

  async function round(r, fails, m, ctx) {
    const page = async () => { const P = await ctx.newPage(); P.on('pageerror', e => { P.__errors ||= []; P.__errors.push(String(e)); }); const relay = await installRelay(P); return { P, relay }; };
    const loginAs = async U => { const dev = await newDevice(env.base, U); await useAgentCookies(ctx, dev); return dev; };
    const toSettings = async P => { await P.goto(`${env.base}/settings`); await P.locator('[data-testid="logout-button"]').waitFor({ timeout: 15000 }); };
    const loggedOut = async P => P.waitForURL(/\/login/, { timeout: 30000 }).then(() => true).catch(() => false);
    const ownKeys = (keys, U) => keys.filter(k => k.startsWith(`draft:${U.id}:`));
    const typeOffline = async (P, relay, docId, toks) => {
      await openDoc(P, env.base, docId); await waitSynced(P);
      relay.goOffline();
      for (const t of toks) await typeAtEnd(P, ` ${t}`, { mode: 'insert' });
      await P.waitForFunction(() => window.__app.persisted() && window.__app.client.storage.pending.length > 0, null, { timeout: 5000 });
    };

    // ---- a. 沒有待送：正常登出 ----
    let dev = await loginAs(UA);
    let { P, relay } = await page();
    const P1 = await newPage(UA.agent, `SEC-12 a ${r}`);
    await openDoc(P, env.base, P1); await typeAtEnd(P, ` A${r}k1`, { mode: 'insert' }); await waitSynced(P);
    const sidA = await sessionIdOf(dev);
    await toSettings(P);
    await P.locator('[data-testid="logout-button"]').click();
    if (!(await loggedOut(P))) fails.push('a. 沒有待送時沒有直接登出');
    if (ownKeys((await rawKeys(P)).keys, UA).length) fails.push('a. 正常登出後 A 的草稿沒有清除');
    if ((await db.query('select 1 from "session" where id=$1', [sidA])).rows.length) fails.push('a. 登出後 session 沒有撤銷');
    await P.close();

    // ---- b. 有待送、伺服器可連：10 秒內同步後登出 ----
    dev = await loginAs(UA);
    ({ P, relay } = await page());
    const P2 = await newPage(UA.agent, `SEC-12 b ${r}`);
    const tb = `A${r}c2`;
    await typeOffline(P, relay, P2, [tb]);
    await toSettings(P);
    relay.goOnline();
    await P.locator('[data-testid="logout-button"]').click();
    if (!(await loggedOut(P))) fails.push('b. 伺服器可連時沒有同步後登出');
    if (count(await dbJson(P2), tb) !== 1) fails.push('b. 登出前同步的內容沒有恰好一次進入資料庫');
    if (ownKeys((await rawKeys(P)).keys, UA).length) fails.push('b. 同步成功登出後 A 的草稿沒有清除');
    await P.close();

    // ---- c. 有待送、伺服器連不上：10 秒後的選項 ----
    dev = await loginAs(UA);
    ({ P, relay } = await page());
    const P3 = await newPage(UA.agent, `SEC-12 c ${r}`);
    const tc = [`A${r}c3`, `A${r}c4`];
    await typeOffline(P, relay, P3, tc);
    await toSettings(P);
    const t0 = Date.now();
    await P.locator('[data-testid="logout-button"]').click();
    await P.locator('[data-testid="logout-wait"]').waitFor({ timeout: 20000 });
    m.waitMs = Date.now() - t0;
    if (m.waitMs < 9500) fails.push(`c. 不到 10 秒（${m.waitMs} 毫秒）就放棄同步`);
    await P.locator('[data-testid="logout-wait"]').click();
    await P.locator('[data-testid="logout-wait"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await P.locator('[data-testid="logout-wait"]').waitFor({ timeout: 20000 }).catch(() => fails.push('c. 繼續等待後沒有回到選項'));
    const [dl] = await Promise.all([P.waitForEvent('download', { timeout: 10000 }), P.locator('[data-testid="logout-download"]').click()]);
    const file = JSON.parse(readFileSync(await dl.path(), 'utf8'));
    const d3 = (file.drafts || []).find(d => d.pageId === P3);
    if (!d3 || !d3.pending || d3.pending.length < 1 || !tc.every(t => JSON.stringify(d3.blocks).includes(t))) fails.push('c. 下載的 JSON 缺少頁面、待送修改或內容');
    if (!file.formatVersion || !file.exportedAt) fails.push('c. 下載的 JSON 缺少格式版本或匯出時間');
    const tokenVal = decodeURIComponent(dev.cookies.get('better-auth.session_token') || '').split('.')[0];
    const fileText = readFileSync(await dl.path(), 'utf8');
    if (tokenVal && fileText.includes(tokenVal)) fails.push('c. 下載的 JSON 含登入憑證');
    if (/"token"|collab|secret|password/i.test(fileText)) fails.push('c. 下載的 JSON 含憑證或秘密欄位');
    await P.locator('[data-testid="logout-cancel"]').click();
    await sleep(500);
    if (!(await P.evaluate(async () => (await fetch('/api/sessions')).status === 200))) fails.push('c. 取消後被登出');
    const k3 = `draft:${UA.id}:${P3}`;
    if (!(await rawGet(P, k3))) fails.push('c. 下載或取消後草稿不見');
    await P.locator('[data-testid="logout-button"]').click();
    await P.locator('[data-testid="logout-keep"]').waitFor({ timeout: 20000 });
    await P.locator('[data-testid="logout-keep"]').click();
    await P.locator('[data-testid="shared-device-warning"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => fails.push('c. 保留草稿前沒有顯示共用裝置警告'));
    await P.locator('[data-testid="logout-keep-confirm"]').click();
    if (!(await loggedOut(P))) fails.push('c. 保留草稿並登出沒有登出');
    const kept = await rawGet(P, k3);
    if (!kept || kept.userId !== UA.id || !(kept.pending || []).length) fails.push('c. 保留草稿並登出後草稿被清除');
    await P.close();

    // ---- d. 同一台裝置換 B 登入 ----
    await loginAs(UB);
    ({ P, relay } = await page());
    await openDoc(P, env.base, P3); await waitSynced(P);
    if (await P.evaluate(() => window.__app.status()) === 'blocked') fails.push('d. B 被 A 的草稿封鎖');
    const shownB = tokensIn(await text(P));
    if (tc.some(t => shownB.has(t))) fails.push('d. B 的編輯器顯示了 A 的草稿');
    await sleep(400);
    const dbAfterB = await dbJson(P3);
    if (tc.some(t => dbAfterB.includes(t))) fails.push('d. A 的草稿在 B 登入時被送出');
    await toSettings(P);
    const setB = await P.locator('body').innerText();
    if (tc.some(t => setB.includes(t)) || Number(await P.locator('[data-testid="drafts-count"]').getAttribute('data-unsynced')) !== 0) fails.push('d. B 的設定頁顯示了 A 的草稿或數量');
    if (await P.locator('[data-testid="orphans"]').count()) fails.push('d. B 的設定頁出現不屬於 B 的草稿數量');
    await P.locator('[data-testid="logout-button"]').click();
    if (!(await loggedOut(P))) fails.push('d. B 沒有待送時沒有直接登出');
    if (!(await rawGet(P, k3))) fails.push('d. B 登出時清掉了 A 的草稿');
    await P.close();

    // ---- e. A 有待送時登入被撤銷，接著 B 登入 ----
    dev = await loginAs(UA);
    ({ P, relay } = await page());
    const P5 = await newPage(UA.agent, `SEC-12 e ${r}`);
    const te = `A${r}c5`;
    await openDoc(P, env.base, P5); await waitSynced(P);
    relay.stall(true);                                  // 修改送不到伺服器（連線未關閉）
    await typeAtEnd(P, ` ${te}`, { mode: 'insert' });
    await P.waitForFunction(() => window.__app.persisted() && window.__app.client.storage.pending.length > 0, null, { timeout: 5000 });
    await UA.agent.del(`/api/sessions/${await sessionIdOf(dev)}`);
    relay.stall(false);
    await P.waitForFunction(() => window.__app.status() === 'revoked', null, { timeout: 10000 }).catch(() => fails.push('e. 撤銷後沒有顯示登入失效'));
    await P.close();
    await loginAs(UB);
    ({ P } = await page());
    await openDoc(P, env.base, P5); await waitSynced(P);
    if (tokensIn(await text(P)).has(te)) fails.push('e. B 看到 A 被撤銷前的待送內容');
    await sleep(400);
    if ((await dbJson(P5)).includes(te)) fails.push('e. A 重新驗證前待送內容被送出');
    await P.close();

    // ---- f. B 有待送時失去空間權限，接著 A 在同一台裝置登入 ----
    const sp2 = (await UA.agent.post('/api/spaces', { name: `SEC-12 f ${r}` })).json.space.id;
    await UA.agent.post(`/api/spaces/${sp2}/members`, { userId: UB.id });
    const P6 = await newPage(UA.agent, `SEC-12 f ${r}`, { spaceId: sp2 });
    ({ P, relay } = await page());
    await openDoc(P, env.base, P6); await waitSynced(P);
    relay.stall(true);
    const tf = `B${r}c6`;
    await typeAtEnd(P, ` ${tf}`, { mode: 'insert' });
    await P.waitForFunction(() => window.__app.persisted() && window.__app.client.storage.pending.length > 0, null, { timeout: 5000 });
    await UA.agent.del(`/api/spaces/${sp2}/members/${UB.id}`);
    relay.stall(false);
    await P.waitForFunction(() => ['denied', 'page_closed'].includes(window.__app.status()), null, { timeout: 15000 }).catch(() => {});
    await P.close();
    await loginAs(UA);
    ({ P } = await page());
    await openDoc(P, env.base, P6); await waitSynced(P);
    if (tokensIn(await text(P)).has(tf)) fails.push('f. A 看到 B 失去權限前的待送內容');
    if ((await dbJson(P6)).includes(tf)) fails.push('f. B 失去權限後待送內容被提交');
    await P.close();

    // ---- g. A 重新登入：保留的草稿與撤銷前的待送都恰好一次進入資料庫 ----
    for (const [docId, toks] of [[P3, tc], [P5, [te]]]) {
      ({ P } = await page());
      await openDoc(P, env.base, docId); await waitSynced(P);
      const j = await dbJson(docId);
      for (const t of toks) if (count(j, t) !== 1) fails.push(`g. A 重新登入後 ${t} 出現 ${count(j, t)} 次（應為 1）`);
      await P.close();
    }

    // ---- h. 捨棄並登出：只刪 A 自己的草稿 ----
    await loginAs(UB);
    ({ P, relay } = await page());
    const P7 = await newPage(UB.agent, `SEC-12 h-B ${r}`);
    const th = `B${r}c7`;
    await typeOffline(P, relay, P7, [th]);
    await toSettings(P);
    await P.locator('[data-testid="logout-button"]').click();
    await P.locator('[data-testid="logout-keep"]').waitFor({ timeout: 20000 });
    await P.locator('[data-testid="logout-keep"]').click();
    await P.locator('[data-testid="logout-keep-confirm"]').click();
    await loggedOut(P); await P.close();
    await loginAs(UA);
    ({ P, relay } = await page());
    const P8 = await newPage(UA.agent, `SEC-12 h-A ${r}`);
    const tA8 = `A${r}c8`;
    await typeOffline(P, relay, P8, [tA8]);
    await toSettings(P);
    await P.locator('[data-testid="logout-button"]').click();
    await P.locator('[data-testid="logout-discard"]').waitFor({ timeout: 20000 });
    await P.locator('[data-testid="logout-discard"]').click();
    await P.locator('[data-testid="logout-discard-confirm"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => fails.push('h. 捨棄沒有二次確認'));
    await P.locator('[data-testid="logout-discard-confirm"]').click();
    if (!(await loggedOut(P))) fails.push('h. 捨棄並登出沒有登出');
    if (await rawGet(P, `draft:${UA.id}:${P8}`)) fails.push('h. 捨棄後 A 的草稿仍在');
    if (!(await rawGet(P, `draft:${UB.id}:${P7}`))) fails.push('h. 捨棄 A 的草稿時刪掉了 B 的草稿');
    await P.close();
    await loginAs(UB);
    ({ P } = await page());
    await openDoc(P, env.base, P7); await waitSynced(P);
    if (count(await dbJson(P7), th) !== 1) fails.push('h. B 保留的草稿沒有恰好一次補送');
    if ((await dbJson(P8)).includes(tA8)) fails.push('h. 捨棄的內容被送出');
    await P.close();

    // ---- i. 舊資料遷移 ----
    await loginAs(UA);
    ({ P, relay } = await page());
    const P9 = await newPage(UA.agent, `SEC-12 i ${r}`), P10 = await newPage(UA.agent, `SEC-12 i2 ${r}`), P11 = await newPage(UA.agent, `SEC-12 i3 ${r}`);
    const ti = `A${r}o9`;
    await typeOffline(P, relay, P9, [ti]);
    const legacy = await rawGet(P, `draft:${UA.id}:${P9}`);
    await P.goto(`${env.base}/login`);
    // 改寫成版本 1 的舊格式：A 的待送（doc:P9）、沒有 userId 的草稿（doc:P10，內容是 P9 的待送，若被誤用會送到 P10）
    await P.evaluate(async ([v, p9, p10]) => {
      await new Promise(r2 => { const d = indexedDB.deleteDatabase('notes-drafts'); d.onsuccess = d.onerror = d.onblocked = () => r2(); });
      await new Promise((r2, j2) => {
        const rq = indexedDB.open('notes-drafts', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('drafts');
        rq.onsuccess = () => { const db = rq.result; const tx = db.transaction('drafts', 'readwrite'); const o = { ...v }; delete o.userId;
          tx.objectStore('drafts').put(v, 'doc:' + p9); tx.objectStore('drafts').put(o, 'doc:' + p10); tx.oncomplete = () => { db.close(); r2(); }; tx.onerror = j2; };
        rq.onerror = j2;
      });
    }, [legacy, P9, P10]);
    await P.close();
    // 升級中斷：整個升級回滾，舊資料原封不動
    const Q = await ctx.newPage();
    Q.on('pageerror', () => {});
    await Q.addInitScript(() => { globalThis.__notesIdbUpgradeFail = true; });
    await Q.goto(`${env.base}/p/${P9}`);
    await Q.locator('[role="alert"]').first().waitFor({ timeout: 15000 }).catch(() => {});
    const afterFail = await rawKeys(Q);
    if (afterFail.version !== 1 || !afterFail.keys.includes('doc:' + P9) || !afterFail.keys.includes('doc:' + P10) || afterFail.keys.length !== 2) fails.push('i. 升級中斷後舊資料或版本被改動：' + JSON.stringify(afterFail));
    await Q.close();
    // 舊分頁擋住升級：舊版程式的分頁開著版本 1 的連線，並在關閉前寫入最後一筆（doc:P11）
    const O = await ctx.newPage();
    await O.goto(`${env.base}/login`);
    await O.evaluate(() => new Promise(r2 => { const rq = indexedDB.open('notes-drafts', 1); rq.onsuccess = () => { window.__old = rq.result; r2(); }; }));
    ({ P, relay } = await page());
    await P.goto(`${env.base}/p/${P9}`);
    await P.locator('[data-testid="idb-blocked"]').waitFor({ timeout: 15000 }).catch(() => fails.push('i. 升級被舊分頁擋住時沒有提示'));
    await O.evaluate(([v, p11]) => new Promise(r2 => { const tx = window.__old.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put({ ...v }, 'doc:' + p11); tx.oncomplete = () => r2(); }), [legacy, P11]);
    await O.close();
    await P.waitForFunction(() => window.__app && window.__app.status() !== 'loading', null, { timeout: 20000 }).catch(() => fails.push('i. 舊分頁關閉後沒有完成升級'));
    await waitSynced(P).catch(() => {});
    const migrated = await rawKeys(P);
    const ks = migrated.keys;
    if (migrated.version !== 2 || ks.some(k => k.startsWith('doc:')) || !ks.includes(`draft:${UA.id}:${P9}`) || !ks.includes(`draft:${UA.id}:${P11}`) || ks.filter(k => k.startsWith(`orphan:${P10}:`)).length !== 1) fails.push('i. 遷移結果不正確：' + JSON.stringify(ks));
    if (count(await dbJson(P9), ti) !== 1) fails.push('i. 遷移後 A 的待送沒有恰好一次補送');
    // 無所有者的草稿：不載入、不送出；設定頁只顯示中性數量，清除需二次確認
    await sleep(500);
    if ((await dbJson(P10)).includes(ti)) fails.push('i. 無法辨識所有者的草稿被送出');
    await toSettings(P);
    if (Number(await P.locator('[data-testid="orphans-count"]').getAttribute('data-n').catch(() => '0')) !== 1) fails.push('i. 設定頁沒有顯示無所有者草稿的數量');
    await P.locator('[data-testid="orphans-clear"]').click();
    await P.locator('[data-testid="drafts-delete-confirm"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => fails.push('i. 清除無所有者草稿沒有二次確認'));
    await P.locator('[data-testid="drafts-delete-confirm"]').click();
    await sleep(500);
    if ((await rawKeys(P)).keys.some(k => k.startsWith('orphan:'))) fails.push('i. 確認後無所有者草稿沒有清除');
    await P.close();
  }
}
