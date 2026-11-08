// DEV-01（M2-c，F-M2-12）：開發模式（next dev，React StrictMode 會把元件掛載兩次）下復原／重做仍有作用。
// 每輪兩個情境，網頁用開發模式啟動，其他（協作伺服器、資料庫、登入與兩步驟驗證）與其他瀏覽器案例相同：
// 1. typing：A 打兩段字（中間停超過復原合併時間），Ctrl+Z 只移除後打的那段，Ctrl+Shift+Z 放回；兩端與資料庫一致。
// 2. type：B 打字，A 把該段改成標題，B 在標題裡再打字；A 按 Ctrl+Z 回到一般段落、B 的字都在（F-M2-10 的行為），
//    Ctrl+Shift+Z 又是標題、B 的字都在；兩端與資料庫一致。
import { isDeepStrictEqual } from 'node:util';
import { newPage, sleep } from '../lib/harness.mjs';
import { loadFromDb } from '../lib/m0-compat.mjs';
import { Recorder, within } from '../lib/recorder.mjs';
import { bootEnv } from '../lib/env.mjs';
import { blocksOfState } from '../../shared/export.js';
import { loadPlaywright, launch, newProfileDir, rmProfile, useAgentCookies, waitReady, waitSynced, blocks } from '../lib/browser.mjs';

const canon = x => JSON.parse(JSON.stringify(x));
function allText(x) {
  const out = [];
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') { if (typeof v.text === 'string') out.push(v.text); for (const [k, w] of Object.entries(v)) if (k !== 'text') walk(w); }
  })(x);
  return out.join('\n');
}
const count = (s, sub) => String(s).split(sub).length - 1;

export async function dev01(N) {
  const rec = new Recorder('DEV-01', '開發模式（React StrictMode）下復原／重做有作用：打字與改類型的 Ctrl+Z、Ctrl+Shift+Z，兩端與資料庫一致');
  const env = await bootEnv({ users: 2, dev: true });
  const pw = await loadPlaywright();
  const S = [];
  for (const u of env.users) {
    const dir = newProfileDir();
    const ctx = await launch(pw, dir);
    await useAgentCookies(ctx, u.agent);
    const P = ctx.pages()[0] || await ctx.newPage();
    P.on('pageerror', e => { P.__errors ||= []; P.__errors.push(String(e)); });
    S.push({ dir, ctx, P });
  }
  const [A, B] = S.map(s => s.P);
  // 開發模式第一次開啟頁面時才編譯，等待時間放寬
  const open = async (P, docId) => { await P.goto(`${env.base}/p/${docId}`, { timeout: 180000 }); await waitReady(P, 180000); };
  const press = async (P, keys) => { await P.locator('.bn-editor').focus(); await P.keyboard.press(keys); };
  const dbBlocks = async docId => blocksOfState((await loadFromDb(docId)).update);
  const converged = async (fails, label, pages, docId) => {
    for (const P of pages) await waitSynced(P, 40000);
    const t0 = Date.now();
    let bs, bd;
    for (;;) {
      bs = []; for (const P of pages) bs.push(canon(await blocks(P)));
      bd = canon(await dbBlocks(docId));
      if (bs.every(b => isDeepStrictEqual(b, bd)) || Date.now() - t0 > 15000) break;
      await sleep(200);
    }
    for (let i = 0; i < bs.length; i++) if (!isDeepStrictEqual(bs[i], bd)) fails.push(`${label}：第 ${i + 1} 個編輯器與資料庫不一致`);
    return bd;
  };
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try { await within(round(r, fails, m), 300000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      for (const P of [A, B]) if (P.__errors && P.__errors.length) { fails.push('page error: ' + P.__errors.slice(0, 3).join(' / ')); P.__errors = []; }
      rec.add(r, 12000 + r, fails, m);
    }
  } finally { for (const s of S) { await s.ctx.close().catch(() => {}); rmProfile(s.dir); } }
  return rec.save();

  async function round(r, fails, m) {
    // 1. typing
    {
      const tag = 'typing：', first = `甲${r}一`, second = `甲${r}二`;
      const docId = await newPage(env.users[0].agent, `DEV-01 打字 ${r}`);
      await open(A, docId); await waitSynced(A);
      await A.locator('.bn-editor').focus();
      await A.keyboard.type(first); await waitSynced(A);
      await sleep(800); // 超過復原合併時間（500 毫秒），兩段字是兩筆復原紀錄
      await A.keyboard.type(second); await waitSynced(A);
      m.typingUndoDepth = await A.evaluate(() => window.__app.undoInfo().depth);
      await press(A, 'Control+z');
      await A.waitForFunction(t => !window.__app.text().includes(t), second, { timeout: 5000 }).catch(() => {});
      let t = allText(await converged(fails, `${tag}復原後`, [A], docId));
      if (count(t, second) !== 0) fails.push(`${tag}Ctrl+Z 之後「${second}」仍在（復原沒有作用）`);
      if (count(t, first) !== 1) fails.push(`${tag}Ctrl+Z 之後「${first}」出現 ${count(t, first)} 次（應為 1）`);
      await press(A, 'Control+Shift+z');
      await A.waitForFunction(t => window.__app.text().includes(t), second, { timeout: 5000 }).catch(() => {});
      t = allText(await converged(fails, `${tag}重做後`, [A], docId));
      if (count(t, second) !== 1) fails.push(`${tag}Ctrl+Shift+Z 之後「${second}」出現 ${count(t, second)} 次（應為 1）`);
      if (count(t, first) !== 1) fails.push(`${tag}Ctrl+Shift+Z 之後「${first}」出現 ${count(t, first)} 次（應為 1）`);
    }
    // 2. type（兩人：改類型後復原只改回類型）
    {
      const tag = 'type：', base = `乙${r}原`, late = `乙${r}後`;
      const docId = await newPage(env.users[0].agent, `DEV-01 改類型 ${r}`);
      await open(A, docId); await open(B, docId);
      await waitSynced(A); await waitSynced(B);
      await B.locator('.bn-editor').focus();
      await B.evaluate(() => { const e = window.__app.editor; e.setTextCursorPosition(e.document[0].id, 'start'); });
      await B.keyboard.type(base); await waitSynced(B);
      await A.waitForFunction(t => window.__app.text().includes(t), base, { timeout: 10000 });
      const id = await A.evaluate(() => window.__app.editor.document[0].id);
      await A.locator('.bn-editor').focus();
      await A.evaluate(i => window.__app.editor.setTextCursorPosition(i, 'start'), id);
      await A.keyboard.press('Control+Alt+1');
      await waitSynced(A);
      await B.waitForFunction(() => window.__app.editor.document[0]?.type === 'heading', null, { timeout: 10000 });
      await B.evaluate(i => window.__app.editor.setTextCursorPosition(i, 'end'), id);
      await B.keyboard.type(late); await waitSynced(B);
      await A.waitForFunction(t => window.__app.text().includes(t), late, { timeout: 10000 });
      const check = async (label, type) => {
        const bd = await converged(fails, `${tag}${label}`, [A, B], docId);
        if (!bd.length || bd[0].type !== type) fails.push(`${tag}${label}第一個區塊是 ${bd[0] && bd[0].type}（應為 ${type}）`);
        const t = allText(bd);
        for (const tok of [base, late]) if (count(t, tok) !== 1) fails.push(`${tag}${label}「${tok}」出現 ${count(t, tok)} 次（應為 1）`);
      };
      await check('改類型後', 'heading');
      await press(A, 'Control+z');
      await A.waitForFunction(() => window.__app.editor.document[0]?.type === 'paragraph', null, { timeout: 5000 }).catch(() => {});
      await check('Ctrl+Z 之後', 'paragraph');
      await press(A, 'Control+Shift+z');
      await A.waitForFunction(() => window.__app.editor.document[0]?.type === 'heading', null, { timeout: 5000 }).catch(() => {});
      await check('Ctrl+Shift+Z 之後', 'heading');
    }
  }
}
