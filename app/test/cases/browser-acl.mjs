// ACL-04：真正的瀏覽器、四個帳號（M2-s）
// 建立者以介面建立共享空間並邀請兩位成員 → 每個人的側邊欄只有自己的與參加的空間 → 指向別人個人空間的頁面連結只顯示「無法開啟的頁面」、
// 插入連結的清單不列出看不到的頁面 → 跨空間拖曳時跳出「誰會看到／看不到」的確認 → 頁面被移出後，正在開啟的人看到「你已無法存取」、
// 本機不再保存其他人的內容、連結立即變成無法開啟 → 被移出空間的成員正在開啟的頁面正確提示
import { db, sleep, newPage } from '../lib/harness.mjs';
import { Recorder, within } from '../lib/recorder.mjs';
import { bootEnv } from '../lib/env.mjs';
import { loadPlaywright, launch, newProfileDir, rmProfile, useAgentCookies, waitReady, waitSynced } from '../lib/browser.mjs';

const row = (P, title) => P.locator('[data-testid="tree-row"]').filter({ hasText: title }).first();
const section = (P, spaceId) => P.locator(`[data-testid="space-section"][data-space-id="${spaceId}"]`);
const sidebarSpaces = P => P.locator('[data-testid="space-section"]').evaluateAll(els => els.map(e => e.dataset.spaceId).sort());
const memberSpaces = async uid => (await db.query('select space_id from space_members where user_id=$1 order by space_id', [uid])).rows.map(r => r.space_id).sort();
const linkState = P => P.evaluate(() => [...document.querySelectorAll('a.app-page-link')].map(a => ({ unavailable: !!a.dataset.unavailable, text: a.textContent })));
// 該頁在 IndexedDB 草稿中的快取狀態（失去權限後不得保留其他人的內容）
const idbDoc = (P, pageId) => P.evaluate(key => new Promise(res => {
  const q0 = indexedDB.open('notes-drafts', 1);
  q0.onsuccess = () => { const q = q0.result.transaction('drafts').objectStore('drafts').get(key); q.onsuccess = () => { const v = q.result || {}; res({ docUpdates: (v.docUpdates || []).length, pending: (v.pending || []).length, denied: (v.denied || []).length }); }; };
  q0.onerror = () => res(null);
}), 'doc:' + pageId);

async function timed(fn, ms = 2000, slack = 3000) {
  const t0 = Date.now();
  const ok = await fn(ms + slack).then(() => true, () => false);
  return { ok, ms: Date.now() - t0 };
}

export async function acl04(N) {
  const rec = new Recorder('ACL-04', '真正的瀏覽器、四個帳號：建立共享空間、邀請、跨空間拖曳確認、被移除時的提示；側邊欄只有自己的與參加的空間；連結不洩漏看不到的頁面');
  const env = await bootEnv({ users: 4, shared: false });
  const [D, A, B, C] = env.users;   // D＝管理者（不是成員）、A＝建立者
  const pw = await loadPlaywright();
  const lat = [];
  for (let r = 0; r < N; r++) {
    const fails = [], m = {};
    const dirs = env.users.map(() => newProfileDir());
    const ctxs = [];
    const check2s = (label, res) => { if (!res.ok || res.ms > 2000) fails.push(`${label}：${res.ok ? res.ms + ' 毫秒' : '逾時'}`); else lat.push(res.ms); };
    try {
      await within((async () => {
        const P = {};
        for (const [k, u] of [['D', D], ['A', A], ['B', B], ['C', C]]) {
          const ctx = await launch(pw, dirs[ctxs.length]); ctxs.push(ctx);
          await useAgentCookies(ctx, u.agent);
          const page = ctx.pages()[0] || await ctx.newPage();
          page.on('pageerror', e => fails.push(`${k} page error: ${e}`));
          await page.goto(env.base + '/');
          await page.locator('[data-testid="tree"]').waitFor();
          P[k] = page;
        }
        // 1. A 以介面建立共享空間、邀請 B、C
        const name = `瀏覽器共享${r}`;
        await P.A.getByRole('button', { name: '＋ 新增共享空間' }).click();
        await P.A.fill('#space-name', name);
        await P.A.getByRole('button', { name: '建立', exact: true }).click();
        await P.A.getByRole('button', { name: `空間設定：${name}` }).click();
        for (const u of [B, C]) {
          await P.A.locator('#add-member').click();
          await P.A.getByRole('option', { name: new RegExp(u.email.replace(/[.]/g, '\\.')) }).click();
          await P.A.getByRole('button', { name: '加入', exact: true }).click();
          await P.A.getByTestId('space-members').locator(`text=${u.email}`).waitFor({ timeout: 5000 });
        }
        await P.A.keyboard.press('Escape');
        const S = (await db.query(`select id from spaces where name=$1`, [name])).rows[0]?.id;
        if (!S) throw new Error('空間沒有建立');
        const pA = (await db.query(`select id from spaces where owner_id=$1 and kind='personal'`, [A.id])).rows[0].id;
        check2s('B 看到新空間', await timed(ms => section(P.B, S).waitFor({ timeout: ms })));
        check2s('C 看到新空間', await timed(ms => section(P.C, S).waitFor({ timeout: ms })));
        // 2. 每個人的側邊欄只有自己的與參加的空間
        await sleep(500);
        for (const [k, u] of [['D', D], ['A', A], ['B', B], ['C', C]]) {
          const got = await sidebarSpaces(P[k]);
          const want = await memberSpaces(u.id);
          if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${k} 的側邊欄空間與成員身分不一致（${got.length}／${want.length}）`);
        }
        if (await section(P.D, S).count()) fails.push('D（不是成員）看得到共享空間');
        // 3. A 的私人頁與共享頁；共享頁中有連到私人頁的連結
        const secret = `私人頁${r}`, shared = `共享頁${r}`;
        const priv = await newPage(A.agent, secret, { spaceId: null });
        const pub = await newPage(A.agent, shared, { spaceId: S });
        await P.A.goto(`${env.base}/p/${pub}`);
        await waitReady(P.A);
        await P.A.evaluate(id => { const e = window.__app.editor; e.insertBlocks([{ type: 'pageLink', props: { pageId: id } }], e.document[e.document.length - 1], 'after'); }, priv);
        await waitSynced(P.A);
        // B 開啟共享頁：連結只顯示「無法開啟」、不含標題；插入連結的清單沒有 A 的私人頁
        await P.B.goto(`${env.base}/p/${pub}`);
        await waitReady(P.B);
        await P.B.waitForFunction(() => document.querySelectorAll('a.app-page-link').length > 0 && window.__app.pageRegistryLoaded(), null, { timeout: 10000 });
        let ls = await linkState(P.B);
        if (!ls[0]?.unavailable || ls[0].text.includes(secret)) fails.push('B 看得到別人個人空間頁面的連結標題 ' + JSON.stringify(ls));
        if ((await P.B.evaluate(() => window.__app.visiblePages())).includes(priv)) fails.push('B 的頁面連結清單包含看不到的頁面');
        if (await row(P.B, secret).count()) fails.push('B 的側邊欄看得到 A 的私人頁');
        // 4. A 把私人頁拖到共享空間：跳出確認（B、C 會看到）→ 確認後 B 2 秒內看到、連結變成可開啟
        await row(P.A, secret).waitFor();
        await row(P.A, secret).dragTo(section(P.A, S).getByTestId('space-header'));
        const dlg = P.A.getByTestId('move-summary');
        await dlg.waitFor({ timeout: 5000 });
        const sum = await dlg.textContent();
        m.moveIn = sum;
        if (!sum.includes(name) || !sum.includes('使用者2') || !sum.includes('使用者3') || !sum.includes('會看到')) fails.push('移入確認沒有列出會看到的人：' + sum);
        if (sum.includes('看不到')) fails.push('移入共享空間時不應有人失去存取：' + sum);
        if ((await db.query('select space_id from pages where id=$1', [priv])).rows[0].space_id !== pA) fails.push('確認前頁面就被移動了');
        await P.A.getByRole('button', { name: '確認移動' }).click();
        const tm = Date.now();
        check2s('B 的連結在移入後變成可開啟', await timed(ms => P.B.waitForFunction(t => [...document.querySelectorAll('a.app-page-link')].some(a => !a.dataset.unavailable && a.textContent.includes(t)), secret, { timeout: ms })));
        check2s('B 的側邊欄出現移入的頁面', await timed(ms => row(P.B, secret).waitFor({ timeout: ms })));
        m.moveInMs = Date.now() - tm;
        // 5. B 開著移入的頁面；A 把它拖回「我的頁面」：確認列出「B、C 將看不到」→ B 2 秒內看到「你已無法存取」、本機不再保存其他人的內容
        await P.B.goto(`${env.base}/p/${priv}`);
        await waitReady(P.B);
        await waitSynced(P.B);
        if ((await idbDoc(P.B, priv)).docUpdates === 0) fails.push('前提：開啟頁面後本機應有快取');
        await row(P.A, secret).dragTo(section(P.A, pA).getByTestId('space-header'));
        await dlg.waitFor({ timeout: 5000 });
        const sum2 = await dlg.textContent();
        m.moveOut = sum2;
        if (!sum2.includes('將看不到') || !sum2.includes('使用者2') || !sum2.includes('使用者3')) fails.push('移出確認沒有列出將看不到的人：' + sum2);
        await P.A.getByRole('button', { name: '確認移動' }).click();
        check2s('B 正在開啟的頁面提示已無法存取', await timed(ms => P.B.getByTestId('access-denied').waitFor({ timeout: ms })));
        const idb = await idbDoc(P.B, priv);
        if (idb && idb.docUpdates) fails.push('失去權限後 IndexedDB 仍保存伺服器的文件狀態 ' + JSON.stringify(idb));
        if (await P.B.locator('.bn-editor').count()) fails.push('失去權限後仍顯示文件內容');
        if ((await P.B.getByTestId('save-status').getAttribute('data-state')) !== 'denied') fails.push('狀態列沒有顯示已無法存取');
        // 連結立即變成無法開啟
        await P.B.goto(`${env.base}/p/${pub}`);
        await waitReady(P.B);
        await P.B.waitForFunction(() => document.querySelectorAll('a.app-page-link').length > 0 && window.__app.pageRegistryLoaded(), null, { timeout: 10000 });
        ls = await linkState(P.B);
        if (!ls[0]?.unavailable || ls[0].text.includes(secret)) fails.push('頁面移出後 B 的連結沒有變成無法開啟 ' + JSON.stringify(ls));
        // 6. C 開著共享頁；A 以介面把 C 移出空間 → C 看到提示、側邊欄 2 秒內不再有這個空間
        await P.C.goto(`${env.base}/p/${pub}`);
        await waitReady(P.C);
        await waitSynced(P.C);
        await P.A.getByRole('button', { name: `空間設定：${name}` }).click();
        await P.A.getByRole('button', { name: '移除 使用者3' }).click();
        const tr = Date.now();
        check2s('C 正在開啟的頁面提示已無法存取', await timed(ms => P.C.getByTestId('access-denied').waitFor({ timeout: ms })));
        check2s('C 的側邊欄不再有這個空間', await timed(ms => section(P.C, S).waitFor({ state: 'detached', timeout: ms })));
        m.removeMs = Date.now() - tr;
        await P.A.keyboard.press('Escape');
        if (await section(P.D, S).count()) fails.push('D 在任何時候都不應看到這個空間');
      })(), 240000, 'round');
    } catch (e) { fails.push('exception: ' + e.message); }
    for (const c of ctxs) await c.close().catch(() => {});
    dirs.forEach(rmProfile);
    rec.add(r, r, fails, m);
  }
  lat.sort((a, b) => a - b);
  return rec.save({ latency: { p50: lat[Math.floor(lat.length / 2)], max: lat.at(-1) } });
}
