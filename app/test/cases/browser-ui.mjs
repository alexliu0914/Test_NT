// BR-03：正式介面流程（真正的 Chromium 操作畫面）
// 管理者在設定頁建立邀請 → 受邀者開連結設定密碼 → 首次登入被導向兩步驟驗證設定 → 掃描（讀取密鑰）、保存備援碼、輸入驗證碼
// → 登出後以「密碼＋驗證碼」重新登入 → 兩人同時開著頁面樹：建立、改名、設圖示、拖曳成子頁面、移到垃圾桶、還原，對方 2 秒內看到
// → 有未同步修改時登出會跳出確認
import { db, totp, PASSWORD, sleep } from '../lib/harness.mjs';
import { Recorder, within } from '../lib/recorder.mjs';
import { bootEnv } from '../lib/env.mjs';
import { loadPlaywright, launch, newProfileDir, rmProfile, useAgentCookies, installRelay, waitSynced, typeAtEnd } from '../lib/browser.mjs';

const tree = async ag => (await ag.get('/api/pages')).json.pages;
const row = (P, title) => P.locator('[data-testid="tree-row"]').filter({ hasText: title }).first();

async function waitTitle(P, title, ms = 2000) {
  const t0 = Date.now();
  await row(P, title).waitFor({ state: 'visible', timeout: ms + 3000 });
  return Date.now() - t0;
}

export async function br03(N) {
  const rec = new Recorder('BR-03', '正式介面：邀請→設定密碼→強制兩步驟驗證→重新登入→兩人同時操作頁面樹（2 秒內同步）→未同步時登出確認');
  const env = await bootEnv({ users: 1 });
  const admin = env.users[0];
  const pw = await loadPlaywright();
  const lat = [];
  for (let r = 0; r < N; r++) {
    const fails = [], m = {};
    const dirs = [newProfileDir(), newProfileDir()];
    const ctxs = [];
    try {
      await within((async () => {
        const cAdm = await launch(pw, dirs[0]); ctxs.push(cAdm);
        await useAgentCookies(cAdm, admin.agent);
        const PA = cAdm.pages()[0] || await cAdm.newPage();
        PA.on('pageerror', e => fails.push('admin page error: ' + e));

        // 1. 管理者在設定頁建立邀請
        const email = `ui${r}@example.test`;
        await PA.goto(env.base + '/settings');
        await PA.fill('#invite-email', email);
        await PA.getByRole('button', { name: '建立邀請連結' }).click();
        const url = (await PA.getByTestId('invite-url').textContent({ timeout: 10000 })).trim();

        // 2. 受邀者設定密碼
        const cNew = await launch(pw, dirs[1]); ctxs.push(cNew);
        const PN = cNew.pages()[0] || await cNew.newPage();
        PN.on('pageerror', e => fails.push('member page error: ' + e));
        await PN.goto(url);
        await PN.fill('#name', '介面測試');
        await PN.fill('#new-password', PASSWORD);
        await PN.fill('#confirm-password', PASSWORD);
        await PN.getByRole('button', { name: '建立帳號' }).click();
        await PN.waitForURL(/\/login$/, { timeout: 10000 });

        // 3. 首次登入 → 強制設定兩步驟驗證
        await PN.fill('#email', email);
        await PN.fill('#password', PASSWORD);
        await PN.getByRole('button', { name: '登入' }).click();
        await PN.waitForURL(/\/setup-2fa$/, { timeout: 10000 });
        await PN.fill('#password', PASSWORD);
        await PN.getByRole('button', { name: '開始設定' }).click();
        const secret = (await PN.getByTestId('totp-secret').textContent({ timeout: 10000 })).trim();
        const codes = await PN.getByTestId('backup-codes').locator('code').count();
        if (codes !== 10) fails.push('備援碼數量 ' + codes);
        await PN.check('#saved');
        await PN.locator('input[inputmode="numeric"]').first().click();
        await PN.keyboard.type(totp(secret));
        await PN.getByRole('button', { name: '完成設定' }).click();
        await PN.waitForURL(u => !/setup-2fa|login/.test(u.pathname), { timeout: 10000 });

        // 4. 登出後以密碼＋驗證碼重新登入
        await PN.goto(env.base + '/settings');
        await PN.getByTestId('sessions').locator('tbody tr').first().waitFor();   // 等頁面完成載入（按鈕已可操作）
        await PN.getByRole('button', { name: '登出' }).last().click();
        await PN.waitForURL(/\/login$/, { timeout: 10000 });
        await PN.fill('#email', email);
        await PN.fill('#password', PASSWORD);
        await PN.getByRole('button', { name: '登入' }).click();
        await PN.locator('input[inputmode="numeric"]').first().waitFor({ timeout: 10000 });
        await PN.locator('input[inputmode="numeric"]').first().click();
        await PN.keyboard.type(totp(secret));
        await PN.getByRole('button', { name: '驗證' }).click();
        await PN.waitForURL(u => !/login/.test(u.pathname), { timeout: 10000 });

        // 5. 兩人同時開著頁面樹
        await PA.goto(env.base + '/');
        await PA.locator('[data-testid="tree"]').waitFor();
        await PN.locator('[data-testid="tree"]').waitFor();
        const title1 = `介面頁${r}`;
        await PN.getByRole('button', { name: '＋ 新增頁面' }).click();
        const input = PN.getByRole('textbox', { name: '頁面名稱' });
        await input.waitFor();
        await input.fill(title1);
        await input.press('Enter');
        const t1 = await waitTitle(PA, title1).catch(() => null);
        if (t1 === null || t1 > 2000) fails.push('對方 2 秒內沒有看到新頁面 ' + t1); else lat.push(t1);
        // 從首頁點進頁面：側邊欄必須是同一個 DOM 節點（沒有重新掛載，F-M1-03）
        if (r === 0) {
          await PA.locator('[data-testid="tree"]').evaluate(el => { el.__mark = 'same'; });
          await row(PA, title1).getByText(title1).click();
          await PA.waitForURL(/\/p\//, { timeout: 10000 });
          await PA.locator('.bn-editor').waitFor({ timeout: 15000 });
          const same = await PA.locator('[data-testid="tree"]').evaluate(el => el.__mark === 'same');
          if (!same) fails.push('從首頁進入頁面時側邊欄被重新掛載');
        }
        // 對方改名（雙擊）
        const title2 = `改名${r}`;
        await row(PA, title1).getByText(title1).dblclick();
        const inputA = PA.getByRole('textbox', { name: '頁面名稱' });
        await inputA.fill(title2); await inputA.press('Enter');
        const t2 = await waitTitle(PN, title2).catch(() => null);
        if (t2 === null || t2 > 2000) fails.push('2 秒內沒有看到改名 ' + t2); else lat.push(t2);
        // 設圖示
        await row(PN, title2).getByRole('button', { name: '設定圖示' }).click();
        await PN.getByRole('button', { name: '圖示 📚' }).click();
        await sleep(300);
        const pg = (await tree(admin.agent)).find(p => p.title === title2);
        if (!pg || pg.icon !== '📚') fails.push('圖示沒有設定成功');
        // 拖曳：新頁面拖到上一頁的中央 → 成為子頁面
        const title3 = `子頁${r}`;
        await PN.getByRole('button', { name: '＋ 新增頁面' }).click();
        const input3 = PN.getByRole('textbox', { name: '頁面名稱' });
        await input3.fill(title3); await input3.press('Enter');
        await waitTitle(PN, title3);
        await row(PN, title3).dragTo(row(PN, title2));
        await sleep(500);
        const t = await tree(admin.agent);
        const parent = t.find(p => p.title === title2), child = t.find(p => p.title === title3);
        if (!parent || !child || child.parentId !== parent.id) fails.push('拖曳後沒有成為子頁面');
        // 移到垃圾桶 → 對方看不到 → 從垃圾桶還原
        await row(PN, title2).getByRole('button', { name: '頁面選項' }).click();
        await PN.getByRole('menuitem', { name: '移到垃圾桶' }).click();
        await row(PA, title2).waitFor({ state: 'detached', timeout: 4000 }).catch(() => fails.push('對方仍看得到已刪除的頁面'));
        await PA.getByRole('button', { name: /^垃圾桶/ }).click();
        await PA.getByTestId('trash').getByRole('button', { name: '還原' }).first().click();
        await waitTitle(PN, title2).catch(() => fails.push('還原後對方沒有看到'));
        const t4 = await tree(admin.agent);
        if (t4.find(p => p.title === title3)?.parentId !== t4.find(p => p.title === title2)?.id) fails.push('還原後子頁面結構不正確');

        // 6. 有未同步修改時登出：跳出確認
        // Playwright 只會攔截「安裝之後才載入的文件」裡的 WebSocket，所以安裝後重新載入該頁
        const relay = await installRelay(PN);
        await PN.goto(`${env.base}/p/${t4.find(p => p.title === title2).id}`);
        await PN.waitForFunction(() => window.__app && window.__app.status() !== 'loading', null, { timeout: 15000 });
        await waitSynced(PN);
        relay.goOffline();
        await typeAtEnd(PN, ' 未同步內容', { mode: 'insert' });
        await PN.waitForFunction(() => window.__app.persisted() && window.__app.client.storage.pending.length > 0, null, { timeout: 5000 });
        await PN.goto(env.base + '/settings');
        await PN.getByTestId('sessions').locator('tbody tr').first().waitFor();   // 等頁面完成載入（按鈕已可操作）
        await PN.getByRole('button', { name: '登出' }).last().click();
        const modal = await PN.getByText('還有尚未同步的修改').waitFor({ timeout: 5000 }).then(() => true, () => false);
        if (!modal) {
          const dump = await PN.evaluate(() => new Promise(res => { const q0 = indexedDB.open('notes-drafts', 1); q0.onsuccess = () => { const q = q0.result.transaction('drafts').objectStore('drafts').getAll(); q.onsuccess = () => res(q.result.map(v => ({ u: v.userId, p: v.pending && v.pending.length }))); }; })).catch(e => String(e));
          fails.push('有未同步修改時登出沒有跳出確認 ' + PN.url() + ' ' + JSON.stringify(dump) + ' ' + (await PN.content()).length);
        }
        await PN.getByRole('button', { name: '取消，先回去同步' }).click();
        if (/\/login$/.test(PN.url())) fails.push('取消後仍被登出');
        m.secretLen = secret.length;
      })(), 150000, 'round');
    } catch (e) { fails.push('exception: ' + e.message); }
    for (const c of ctxs) await c.close().catch(() => {});
    dirs.forEach(rmProfile);
    rec.add(r, r, fails, m);
  }
  lat.sort((a, b) => a - b);
  return rec.save({ latency: { p50: lat[Math.floor(lat.length / 2)], max: lat.at(-1) } });
}

export { db };
