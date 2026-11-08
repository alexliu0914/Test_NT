// COL-05、COL-08（M2-c W4）：真正的 Chromium、正式登入，透過版本面板操作。
// COL-05：「存一版」→ 修改 → 版本面板預覽（唯讀）→ 還原 → 另一人 2 秒內看到 → 還原後 Undo 不覆蓋 → 從「還原前」版本再還原回來；
//         手動與自動版標示不同；面板開著時版本被清除，還原顯示「已超過保留期限」；惡意內容的預覽不執行、沒有危險連結。
// COL-08：A 持續輸入時 B 還原：還原前已提交的修改只在「還原前」版本、還原當下 A 尚未確認的修改進衝突副本（不自動放回文件）、
//         還原後的新輸入保留；被還原掉的文字不復活；兩端與資料庫一致；同一個 restore_id 重送只生效一次。
import { randomUUID } from 'node:crypto';
import { db, newPage, sleep } from '../lib/harness.mjs';
import { loadFromDb } from '../lib/m0-compat.mjs';
import { Recorder, within } from '../lib/recorder.mjs';
import { bootEnv } from '../lib/env.mjs';
import { blocksOfState, importBlocks, FORMAT_VERSION } from '../../shared/export.js';
import { isSafeHref } from '../../shared/link-policy.js';
import { purgeVersions } from '../../shared/version-retention.js';
import { loadPlaywright, launch, newProfileDir, rmProfile, useAgentCookies, openDoc, waitSynced, typeAtEnd, tokensIn, installRelay, blocks } from '../lib/browser.mjs';

const stateTokens = state => tokensIn(JSON.stringify(blocksOfState(state)));
const dbTokens = async id => stateTokens((await loadFromDb(id)).update);
const versionTokens = async (id, where) => {
  const out = new Set();
  for (const r of (await db.query(`select state from page_versions where page_id=$1 and ${where}`, [id])).rows) for (const t of stateTokens(new Uint8Array(r.state))) out.add(t);
  return out;
};
const copyTokens = async id => {
  const rows = (await db.query('select content_json from conflict_copies where page_id=$1', [id])).rows;
  const out = new Set();
  for (const r of rows) for (const t of tokensIn(r.content_json)) out.add(t);
  return { tokens: out, count: rows.length };
};
const canon = x => JSON.parse(JSON.stringify(x));
const missing = (need, have) => [...need].filter(t => !have.has(t));
async function converged(fails, label, pages, id) {
  const t0 = Date.now();
  for (;;) {
    const bs = []; for (const P of pages) bs.push(JSON.stringify(canon(await blocks(P))));
    const bd = JSON.stringify(canon(blocksOfState((await loadFromDb(id)).update)));
    if (bs.every(b => b === bd)) return;
    if (Date.now() - t0 > 10000) { fails.push(`${label}：兩端與資料庫不一致`); return; }
    await sleep(200);
  }
}

async function openBrowsers(pw, users) {
  const out = [];
  for (const u of users) {
    const dir = newProfileDir();
    const ctx = await launch(pw, dir);
    await useAgentCookies(ctx, u.agent);
    const P = ctx.pages()[0] || await ctx.newPage();
    P.on('pageerror', e => { P.__errors ||= []; P.__errors.push(String(e)); });
    P.on('dialog', d => { P.__dialogs = (P.__dialogs || 0) + 1; d.dismiss().catch(() => {}); });
    out.push({ dir, ctx, P });
  }
  return out;
}
const pageErrors = (fails, pages) => { for (const P of pages) { if (P.__errors && P.__errors.length) fails.push('page error: ' + P.__errors.slice(0, 2).join(' / ')); P.__errors = []; } };

// 版本面板操作
async function openPanel(P) {
  if (await P.locator('[data-testid="version-row"], [data-testid="version-panel"] :text("還沒有版本")').count()) await P.keyboard.press('Escape');
  await P.locator('[data-testid="open-versions"]').click();
  await P.locator('[data-testid="version-row"]').first().waitFor({ timeout: 10000 });
}
async function closePanel(P) { await P.keyboard.press('Escape'); await P.locator('[data-testid="version-row"]').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {}); }
async function previewText(P, id) {
  await P.locator(`[data-testid="version-row"][data-version-id="${id}"]`).click();
  const pv = P.locator(`[data-testid="version-preview"][data-preview-id="${id}"]`);
  await pv.waitFor({ timeout: 10000 });
  await sleep(200);
  return pv.locator('.bn-editor').innerText();
}
async function restoreFromPreview(P) {
  const msg = P.locator('[data-testid="version-message"]');
  const before = (await msg.count()) ? Number(await msg.getAttribute('data-n')) : 0;
  await P.locator('[data-testid="restore-button"]').click();
  await P.locator('[data-testid="restore-confirm-button"]').click();
  // 等還原結果的新訊息（訊息序號增加）
  await P.waitForFunction(b => { const e = document.querySelector('[data-testid="version-message"]'); return e && Number(e.dataset.n) > b; }, before, { timeout: 10000 });
}

const EVIL = [{ type: 'paragraph', content: [
  { type: 'link', href: 'javascript:window.__pwned=1', content: [{ type: 'text', text: '惡意連結', styles: {} }] },
  { type: 'link', href: 'data:text/html,<script>alert(1)</script>', content: [{ type: 'text', text: '資料連結', styles: {} }] },
  { type: 'text', text: '<img src=x onerror="window.__pwned=2"><script>window.__pwned=3</script>', styles: {} },
] }];

export async function col05(N) {
  const rec = new Recorder('COL-05', '版本面板：存一版、預覽、還原、另一人 2 秒內看到、還原後 Undo 不覆蓋、從還原前版本再還原；手動／自動標示；過期版本；惡意內容預覽');
  const env = await bootEnv({ users: 2, collabEnv: { VERSION_SWEEP_MS: '300' } });
  const pw = await loadPlaywright();
  const S = await openBrowsers(pw, env.users);
  const [A, B] = S.map(s => s.P);
  const evilState = Buffer.from(importBlocks({ formatVersion: FORMAT_VERSION, blocks: EVIL }));
  const lat = [];
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try { await within(round(r, fails, m), 180000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      pageErrors(fails, [A, B]);
      rec.add(r, 150000 + r, fails, m);
    }
  } finally { for (const s of S) { await s.ctx.close().catch(() => {}); rmProfile(s.dir); } }
  const sorted = lat.slice().sort((a, b) => a - b);
  return rec.save({ restoreVisibleMs: { n: sorted.length, p50: sorted[Math.floor(sorted.length / 2)] ?? null, max: sorted.at(-1) ?? null } });

  async function round(r, fails, m) {
    const docId = await newPage(env.users[0].agent, 'COL-05 ' + r);
    await openDoc(A, env.base, docId); await openDoc(B, env.base, docId);
    await waitSynced(A); await waitSynced(B);
    const orig = `A${r}k1`, later = `A${r}k2`;
    await typeAtEnd(A, ` ${orig}`, { mode: 'insert' });
    await waitSynced(A);
    // 1. 存一版（介面）
    await A.locator('[data-testid="save-version"]').click();
    await A.locator('[data-testid="version-message"]:has-text("已存一版")').waitFor({ timeout: 10000 }).catch(() => fails.push('存一版沒有顯示「已存一版」'));
    const manual = (await db.query(`select id from page_versions where page_id=$1 and reason='manual'`, [docId])).rows;
    if (manual.length !== 1) { fails.push(`存一版：手動版本 ${manual.length} 個（應為 1）`); return; }
    const mv = manual[0].id;
    await typeAtEnd(A, ` ${later}`, { mode: 'insert' });
    await waitSynced(A); await B.waitForFunction(t => window.__app.text().includes(t), later, { timeout: 10000 });
    // 2. 預覽：只有存版當時的內容，唯讀
    await openPanel(A);
    if ((await A.locator(`[data-testid="version-row"][data-version-id="${mv}"]`).getAttribute('data-kind')) !== '手動') fails.push('手動版本的標示不是「手動」');
    const pv = await previewText(A, mv);
    if (!pv.includes(orig) || pv.includes(later)) fails.push('預覽內容不是存版當時的內容');
    if ((await A.locator('[data-testid="version-preview"] [contenteditable="true"]').count()) !== 0) fails.push('預覽可以編輯');
    // 3. 還原：另一人 2 秒內看到
    const t0 = Date.now();
    await restoreFromPreview(A);
    const msg = await A.locator('[data-testid="version-message"]').innerText();
    if (!msg.includes('已還原')) fails.push('還原訊息：' + msg);
    try {
      await B.waitForFunction(t => !window.__app.text().includes(t), later, { timeout: 2000, polling: 20 });
      lat.push(Date.now() - t0); m.visibleMs = Date.now() - t0;
    } catch { fails.push('另一人 2 秒內沒有看到還原'); }
    await closePanel(A);
    await waitSynced(A); await waitSynced(B);
    let dbt = await dbTokens(docId);
    if (!dbt.has(orig) || dbt.has(later)) fails.push('還原後資料庫內容不正確');
    await converged(fails, '還原後', [A, B], docId);
    // 4. 還原後 Undo 不覆蓋還原
    await A.locator('.bn-editor').focus();
    for (let k = 0; k < 3; k++) { await A.keyboard.press('Control+z'); await sleep(100); }
    await sleep(500); await waitSynced(A);
    dbt = await dbTokens(docId);
    if (dbt.has(later) || !dbt.has(orig)) fails.push('還原後 Undo 讓還原前的內容回來或刪掉了還原的內容');
    // 5. 從「還原前」版本再還原回來
    await openPanel(A);
    const br = (await db.query(`select id from page_versions where page_id=$1 and reason='before_restore'`, [docId])).rows[0];
    if (!br) { fails.push('沒有「還原前」版本'); return; }
    if ((await A.locator(`[data-testid="version-row"][data-version-id="${br.id}"]`).getAttribute('data-kind')) !== '還原前') fails.push('還原前版本的標示不是「還原前」');
    if (!(await A.locator('[data-testid="restore-row"]').count())) fails.push('版本面板沒有還原紀錄');
    const brText = await previewText(A, br.id);
    if (!brText.includes(later)) fails.push('還原前版本的預覽缺少還原前的內容');
    await restoreFromPreview(A);
    await closePanel(A);
    await B.waitForFunction(t => window.__app.text().includes(t), later, { timeout: 5000 }).catch(() => fails.push('再次還原後另一人沒有看到內容回來'));
    await waitSynced(A); await waitSynced(B);
    dbt = await dbTokens(docId);
    if (!dbt.has(orig) || !dbt.has(later)) fails.push('從還原前版本還原後內容沒有往返');
    await converged(fails, '再次還原後', [A, B], docId);
    // 6. 手動與自動版的標示不同
    await db.query(`update pages set dirty_since = now() - interval '601 seconds' where id=$1`, [docId]);
    const auto = await (async () => { for (let k = 0; k < 50; k++) { const x = (await db.query(`select id from page_versions where page_id=$1 and source='schedule'`, [docId])).rows[0]; if (x) return x.id; await sleep(200); } return null; })();
    if (!auto) fails.push('沒有建立排程快照');
    else {
      await openPanel(A);
      const kind = await A.locator(`[data-testid="version-row"][data-version-id="${auto}"]`).getAttribute('data-kind');
      if (kind !== '自動') fails.push(`排程快照的標示是「${kind}」（應為「自動」）`);
      await closePanel(A);
    }
    // 7. 面板開著時版本被清除：預覽後清除，再按還原 → 顯示已超過保留期限，文件不變
    await openPanel(A);
    await previewText(A, mv);
    await db.query(`update page_versions set created_at = now() - interval '91 days' where id=$1`, [mv]);
    await purgeVersions(db, 90);
    const before = await dbTokens(docId);
    await restoreFromPreview(A);
    const msg2 = await A.locator('[data-testid="version-message"]').innerText();
    if (!msg2.includes('保留期限')) fails.push('還原已清除的版本：訊息為「' + msg2 + '」');
    await closePanel(A);
    await openPanel(A);
    if (await A.locator(`[data-testid="version-row"][data-version-id="${mv}"]`).count()) fails.push('已清除的版本仍在清單中');
    await closePanel(A);
    const after = await dbTokens(docId);
    if ([...before].sort().join() !== [...after].sort().join()) fails.push('還原已清除的版本時文件被改變');
    // 8. 惡意內容的預覽：不執行、沒有危險連結、文字保留
    const ev = 'evil-' + randomUUID();
    await db.query(`insert into page_versions(id, page_id, state, up_to_seq, reason) values ($1,$2,$3,0,'auto')`, [ev, docId, evilState]);
    A.__dialogs = 0;
    await openPanel(A);
    const et = await previewText(A, ev);
    await sleep(500);
    if (!et.includes('惡意連結') || !et.includes('資料連結')) fails.push('惡意內容預覽遺失文字');
    const hrefs = await A.locator('[data-testid="version-preview"] a').evaluateAll(as => as.map(a => a.getAttribute('href')));
    const bad = hrefs.filter(h => h && !isSafeHref(h));
    if (bad.length) fails.push('預覽有危險連結：' + bad.join(','));
    if (await A.evaluate(() => window.__pwned !== undefined)) fails.push('預覽執行了惡意內容');
    if (A.__dialogs) fails.push('預覽觸發了對話框');
    await closePanel(A);
  }
}

export async function col08(N) {
  const rec = new Recorder('COL-08', 'A 持續輸入、B 還原：還原前已提交只在還原前版本、未確認的進衝突副本、還原後新輸入保留、不復活、兩端與資料庫一致、restore_id 冪等');
  const env = await bootEnv({ users: 2 });
  const pw = await loadPlaywright();
  const S = await openBrowsers(pw, env.users);
  const [A, B] = S.map(s => s.P);
  const relayA = await installRelay(A);
  let copiesSeen = 0;
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try { await within(round(r, fails, m), 180000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      relayA.goOnline(); relayA.setDelay(0);
      pageErrors(fails, [A, B]);
      rec.add(r, 160000 + r, fails, m);
    }
  } finally { for (const s of S) { await s.ctx.close().catch(() => {}); rmProfile(s.dir); } }
  return rec.save({ roundsWithCopies: copiesSeen });

  async function round(r, fails, m) {
    const docId = await newPage(env.users[0].agent, 'COL-08 ' + r);
    await openDoc(A, env.base, docId); await openDoc(B, env.base, docId);
    await waitSynced(A); await waitSynced(B);
    const base = `A${r}k0`;
    await typeAtEnd(A, ` ${base}`, { mode: 'insert' }); await waitSynced(A);
    const v0 = 'v0-' + randomUUID();
    await B.evaluate(id => window.__app.makeVersion(id), v0);
    // 還原前已提交
    const committed = [1, 2].map(i => `A${r}d${i}`);
    for (const t of committed) await typeAtEnd(A, ` ${t}`, { mode: 'insert' });
    await waitSynced(A);
    // 還原當下尚未確認：A 離線輸入
    relayA.goOffline();
    await A.waitForFunction(() => !window.__app.client.ready, null, { timeout: 10000 });
    const unconfirmed = [1, 2].map(i => `A${r}u${i}`);
    for (const t of unconfirmed) await typeAtEnd(A, ` ${t}`, { mode: 'insert' });
    await A.waitForFunction(() => window.__app.persisted(), null, { timeout: 5000 });
    // B 從版本面板還原
    await B.locator('[data-testid="open-versions"]').click();
    await B.locator(`[data-testid="version-row"][data-version-id="${v0}"]`).click();
    await B.locator('[data-testid="restore-button"]').click();
    await B.locator('[data-testid="restore-confirm-button"]').click();
    await B.locator('[data-testid="version-message"]:has-text("已還原到所選版本")').waitFor({ timeout: 10000 }).catch(() => fails.push('B 的還原沒有完成'));
    await B.keyboard.press('Escape');
    const job = (await db.query('select id from restore_jobs where page_id=$1', [docId])).rows[0];
    // A 恢復連線：未確認的修改進衝突副本，然後持續輸入（還原後的新輸入）
    relayA.goOnline();
    await A.evaluate(() => window.__app && window.__app.client.reconnectNow());
    // 還原後重新連線：先把未確認的修改存成衝突副本，確認後頁面重新載入（M1 行為）
    await A.waitForFunction(() => { const a = window.__app; if (!a) return false; const s = a.client.storage; return a.client.ready && !s.offlineCopy && s.unackedCopies.length === 0 && !a.client.awaitingOfflineCopy; }, null, { timeout: 20000, polling: 50 })
      .catch(() => fails.push('A 沒有重新連線並存好衝突副本'));
    await sleep(800);
    await A.waitForFunction(() => window.__app && window.__app.status() !== 'loading', null, { timeout: 20000 });
    await waitSynced(A);
    const post = [1, 2, 3].map(i => `A${r}o${i}`);
    // 持續輸入（同時 B 也輸入），確認還原後的新內容都保留
    const bTok = `B${r}o1`;
    await Promise.all([
      (async () => { for (const t of post) { await typeAtEnd(A, ` ${t}`, { mode: 'insert' }); await sleep(30); } })(),
      typeAtEnd(B, ` ${bTok}`, { mode: 'insert' }),
    ]);
    await waitSynced(A); await waitSynced(B);
    const cur = await dbTokens(docId);
    const before = await versionTokens(docId, "reason = 'before_restore'");
    const copies = await copyTokens(docId);
    if (copies.count) copiesSeen++;
    m.copies = copies.count;
    if (!cur.has(base)) fails.push('還原後缺少版本內容 ' + base);
    const res1 = committed.filter(t => cur.has(t));
    if (res1.length) fails.push('還原前已提交的修改沒有被還原移除（復活）: ' + res1.join(','));
    if (missing(committed, before).length) fails.push('還原前版本缺少已提交的修改: ' + missing(committed, before).join(','));
    const res2 = unconfirmed.filter(t => cur.has(t));
    if (res2.length) fails.push('還原當下未確認的修改被自動放回文件: ' + res2.join(','));
    if (missing(unconfirmed, copies.tokens).length) fails.push('未確認的修改沒有進衝突副本: ' + missing(unconfirmed, copies.tokens).join(','));
    if (missing([...post, bTok], cur).length) fails.push('還原後的新輸入遺失: ' + missing([...post, bTok], cur).join(','));
    await converged(fails, '還原後', [A, B], docId);
    // restore_id 重送：只生效一次
    if (job) {
      const epoch0 = (await db.query('select restore_epoch, last_seq from pages where id=$1', [docId])).rows[0];
      const res = await B.evaluate(([rid, vid]) => new Promise(resolve => {
        const c = window.__app.client;
        const h = x => { if (x.restoreId === rid) { c.off('restore_result', h); resolve(x.status); } };
        c.on('restore_result', h);
        c.raw({ t: 'restore', restoreId: rid, versionId: vid });
      }), [job.id, v0]);
      const epoch1 = (await db.query('select restore_epoch, last_seq from pages where id=$1', [docId])).rows[0];
      if (res !== 'already_applied' || epoch0.restore_epoch !== epoch1.restore_epoch || epoch0.last_seq !== epoch1.last_seq) fails.push('restore_id 重送不是冪等：' + res);
      if (Number((await db.query(`select count(*) from page_versions where page_id=$1 and reason='before_restore'`, [docId])).rows[0].count) !== 1) fails.push('restore_id 重送產生了第二個還原前版本');
    } else fails.push('沒有還原紀錄');
  }
}
