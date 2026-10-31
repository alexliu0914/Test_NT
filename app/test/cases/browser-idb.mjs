// BR-02：IndexedDB 草稿（M0-B GATE-03 移植到正式網頁與正式登入；S4、S5 為第四輪審核要求以正式認證重跑的項目）
// S1 修改後立刻關閉分頁        S2 輸入中強制終止整個瀏覽器（SIGKILL）後重開   S3 離線修改後關閉瀏覽器、重開上線
// S4 有未同步修改時「這台裝置的登入」被撤銷：編輯器唯讀、草稿保留；同一帳號重新登入後補送
// S5 另一個帳號在同一台裝置登入：被封鎖、可下載、確認後才捨棄，且草稿不會以新帳號送出
// S6 本機寫入變慢時，狀態必須顯示「尚未存到此裝置」；只要顯示的不是這個狀態，關閉後內容就必須還在
import { db, newPage, newDevice, setDbFault, sleep } from '../lib/harness.mjs';
import { loadFromDb } from '../lib/m0-compat.mjs';
import { Recorder, within } from '../lib/recorder.mjs';
import { bootEnv } from '../lib/env.mjs';
import { blocksOfState } from '../../shared/export.js';
import { loadPlaywright, launch, newProfileDir, rmProfile, killBrowser, useAgentCookies, installRelay, openDoc, waitSynced, typeAtEnd, text, status, tokensIn } from '../lib/browser.mjs';

const missing = (need, have) => [...need].filter(t => !have.has(t));
async function dbTokens(docId) { return tokensIn(JSON.stringify(blocksOfState((await loadFromDb(docId)).update))); }
const versions = P => P.evaluate(() => ({ v: window.__app.client.version, pv: window.__app.client.persistedVersion }));
function markPersisted(log, pv, must) { for (const [t, v] of log) if (v <= pv) must.add(t); }
const sessionIdOf = async agent => (await db.query('select id from "session" where token = $1', [decodeURIComponent(agent.cookies.get('better-auth.session_token') || '').split('.')[0]])).rows[0]?.id;

export async function br02(N) {
  const rec = new Recorder('BR-02', 'IndexedDB（正式網頁）：關閉分頁／強制終止瀏覽器／離線重開／登入撤銷／不同帳號／慢速寫入');
  const env = await bootEnv({ users: 2 });
  const [UA, UB] = env.users;
  const pw = await loadPlaywright();
  const agg = { s1LastLost: 0, s2Kills: 0, s2MustSurvive: 0, s6Unsaved: 0, s6LostWhileUnsaved: 0 };
  for (let r = 0; r < N; r++) {
    const fails = [], m = {};
    const t0 = Date.now();
    const opened = [];
    try { await within(round(r, fails, m, opened), 180000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
    for (const o of opened) { try { await o.ctx.close(); } catch { /* 已被終止 */ } killBrowser(o.dir); rmProfile(o.dir); }
    await setDbFault(false);
    m.ms = Date.now() - t0;
    rec.add(r, r, fails, m);
  }
  return rec.save({ meta: agg });

  async function round(r, fails, m, opened) {
    const start = async (dir, agent) => { const ctx = await launch(pw, dir); opened.push({ ctx, dir }); await useAgentCookies(ctx, agent); return ctx; };
    const pageWithRelay = async ctx => { const P = ctx.pages()[0] || await ctx.newPage(); const relay = await installRelay(P); return { P, relay }; };
    const freshPage = async ctx => { const P = await ctx.newPage(); const relay = await installRelay(P); return { P, relay }; };
    const errs = P => { if (P.__errors && P.__errors.length) fails.push('page error: ' + P.__errors.join(' / ')); };

    // ---- S1：修改後立刻關閉分頁 ----
    {
      const docId = await newPage(UA.agent, 'S1'), dir = newProfileDir(), dev = await newDevice(env.base, UA);
      const ctx = await start(dir, dev);
      let { P, relay } = await pageWithRelay(ctx);
      await openDoc(P, env.base, docId); await waitSynced(P);
      relay.goOffline();
      const must = new Set(), all = [], log = [];
      const k = 3 + (r % 4);
      for (let i = 0; i < k; i++) {
        const t = `A${r}k${i}`; all.push(t);
        await typeAtEnd(P, ` ${t}`, { mode: 'insert' });
        const { v, pv } = await versions(P);
        log.push([t, v]); markPersisted(log, pv, must);
        if (i < k - 1) await sleep(r % 3 === 0 ? 0 : 30);
      }
      await P.close();
      ({ P } = await freshPage(ctx));
      await openDoc(P, env.base, docId); await waitSynced(P);
      const ed = tokensIn(await text(P)), indb = await dbTokens(docId);
      if (missing(must, ed).length) fails.push('S1-已存本機但重開後遺失: ' + missing(must, ed).join(','));
      if (missing(ed, indb).length) fails.push('S1-重開後未同步進資料庫: ' + missing(ed, indb).join(','));
      if (!ed.has(all.at(-1))) agg.s1LastLost++;
      m.s1 = { typed: all.length, must: must.size, survived: ed.size };
      errs(P); await ctx.close();
    }

    // ---- S2：持續輸入中強制終止整個瀏覽器 ----
    {
      const docId = await newPage(UA.agent, 'S2'), dir = newProfileDir(), dev = await newDevice(env.base, UA);
      let ctx = await start(dir, dev);
      let { P, relay } = await pageWithRelay(ctx);
      await openDoc(P, env.base, docId); await waitSynced(P);
      if (r % 2 === 0) relay.goOffline();
      const must = new Set(), all = [], log = [];
      let killed = false;
      const killAt = 150 + ((r * 397) % 900);
      const killer = sleep(killAt).then(() => { killed = true; agg.s2Kills += killBrowser(dir) > 0 ? 1 : 0; });
      try {
        for (let i = 0; i < 400 && !killed; i++) {
          const t = `A${r}d${i}`;
          await typeAtEnd(P, ` ${t}`, { mode: 'insert' });
          all.push(t);
          const { v, pv } = await versions(P);
          log.push([t, v]); markPersisted(log, pv, must);
          await sleep(5);
        }
      } catch { /* 瀏覽器被終止後，頁面操作會失敗 */ }
      await killer; await sleep(200);
      ctx = await start(dir, dev);
      ({ P } = await pageWithRelay(ctx));
      await openDoc(P, env.base, docId); await waitSynced(P);
      const ed = tokensIn(await text(P)), indb = await dbTokens(docId);
      if (missing(must, ed).length) fails.push('S2-已存本機但強制終止後遺失: ' + missing(must, ed).slice(0, 5).join(','));
      if (missing(ed, indb).length) fails.push('S2-重開後未同步進資料庫: ' + missing(ed, indb).slice(0, 5).join(','));
      agg.s2MustSurvive += must.size;
      m.s2 = { killAt, typed: all.length, must: must.size, survived: ed.size, offline: r % 2 === 0 };
      errs(P); await ctx.close();
    }

    // ---- S3：離線修改後正常關閉瀏覽器，重開時上線 ----
    {
      const docId = await newPage(UA.agent, 'S3'), dir = newProfileDir(), dev = await newDevice(env.base, UA);
      let ctx = await start(dir, dev);
      let { P, relay } = await pageWithRelay(ctx);
      await openDoc(P, env.base, docId); await waitSynced(P);
      relay.goOffline();
      await P.waitForFunction(() => !window.__app.client.ready, null, { timeout: 5000 });
      const toks = [0, 1, 2].map(i => `A${r}o${i}`);
      for (const t of toks) await typeAtEnd(P, ` ${t}`);
      await P.waitForFunction(() => window.__app.persisted(), null, { timeout: 5000 });
      const st = await status(P);
      if (!['saving', 'failed'].includes(st)) fails.push('S3-離線時狀態應為 saving/failed，實際 ' + st);
      await ctx.close();
      ctx = await start(dir, dev);
      ({ P } = await pageWithRelay(ctx));
      await openDoc(P, env.base, docId); await waitSynced(P);
      const ed = tokensIn(await text(P)), indb = await dbTokens(docId);
      if (missing(toks, ed).length || missing(toks, indb).length) fails.push(`S3-離線內容遺失 editor=${missing(toks, ed)} db=${missing(toks, indb)}`);
      errs(P); await ctx.close();
    }

    // ---- S4：這台裝置的登入被撤銷（從另一台裝置的設定頁）；同一帳號重新登入後補送 ----
    const dir45 = newProfileDir();
    {
      const docId = await newPage(UA.agent, 'S4'), dev = await newDevice(env.base, UA);
      const ctx = await start(dir45, dev);
      let { P } = await pageWithRelay(ctx);
      await openDoc(P, env.base, docId); await waitSynced(P);
      await setDbFault(true);                              // 伺服器寫不進資料庫 → 修改停在待確認
      const toks = [0, 1].map(i => `A${r}c${i}`);
      for (const t of toks) await typeAtEnd(P, ` ${t}`, { mode: 'insert' });
      await P.waitForFunction(() => window.__app.persisted() && window.__app.client.storage.pending.length > 0, null, { timeout: 5000 });
      const sid = await sessionIdOf(dev);
      const del = await UA.agent.del(`/api/sessions/${sid}`);
      if (del.status !== 200) fails.push('S4-撤銷失敗 ' + del.status);
      await P.waitForFunction(() => window.__app.status() === 'revoked', null, { timeout: 10000 });
      if (await P.locator('.bn-editor[contenteditable="true"]').count()) fails.push('S4-撤銷後編輯器仍可編輯');
      await setDbFault(false);
      await sleep(300);
      const dev2 = await newDevice(env.base, UA);
      await useAgentCookies(ctx, dev2);
      await P.reload(); await P.waitForFunction(() => window.__app && window.__app.status() !== 'loading', null, { timeout: 20000 });
      await waitSynced(P);
      const ed = tokensIn(await text(P)), indb = await dbTokens(docId);
      if (missing(toks, ed).length || missing(toks, indb).length) fails.push(`S4-重新登入後未補送 editor=${missing(toks, ed)} db=${missing(toks, indb)}`);
      errs(P); await ctx.close();
    }

    // ---- S5：同一台裝置換成另一個帳號登入 ----
    {
      const docA = await newPage(UA.agent, 'S5-A'), docB = await newPage(UB.agent, 'S5-B');
      const devA = await newDevice(env.base, UA);
      const ctx = await start(dir45, devA);
      let { P, relay } = await pageWithRelay(ctx);
      await openDoc(P, env.base, docA); await waitSynced(P);
      relay.goOffline();
      const toksA = [0, 1].map(i => `A${r}u${i}`);
      for (const t of toksA) await typeAtEnd(P, ` ${t}`, { mode: 'insert' });
      await P.waitForFunction(() => window.__app.persisted(), null, { timeout: 5000 });
      await P.close();
      const devB = await newDevice(env.base, UB);
      await useAgentCookies(ctx, devB);
      ({ P } = await freshPage(ctx));
      await openDoc(P, env.base, docB);
      if (await status(P) !== 'blocked') fails.push('S5-另一帳號未被封鎖，狀態 ' + await status(P));
      if (await P.locator('.bn-editor').count()) fails.push('S5-被封鎖時仍顯示編輯器');
      const drafts = await P.evaluate(() => window.__app.foreignDrafts());
      const dl = tokensIn(JSON.stringify(drafts.map(d => d.json)));
      if (missing(toksA, dl).length) fails.push('S5-下載的草稿缺少: ' + missing(toksA, dl).join(','));
      await openDoc(P, env.base, docA);              // B 也能看到 A 的頁面：仍須被封鎖，草稿不可用 B 的身分送出
      if (await status(P) !== 'blocked') fails.push('S5-以另一帳號開啟同一文件未被封鎖');
      await sleep(400);
      const leaked = [...await dbTokens(docA)].filter(t => toksA.includes(t));
      if (leaked.length) fails.push('S5-另一帳號的草稿被送到伺服器: ' + leaked.join(','));
      await P.evaluate(() => window.__app.discardForeign());
      await openDoc(P, env.base, docB); await waitSynced(P);
      if ((await P.evaluate(() => window.__app.foreignDrafts())).length) fails.push('S5-捨棄後仍有其他帳號草稿');
      errs(P); await ctx.close();
    }

    // ---- S6：本機寫入延遲 1.5 秒；狀態必須如實顯示「尚未存到此裝置」 ----
    {
      const docId = await newPage(UA.agent, 'S6'), dir = newProfileDir(), dev = await newDevice(env.base, UA);
      const ctx = await start(dir, dev);
      let { P, relay } = await pageWithRelay(ctx);
      await openDoc(P, env.base, docId); await waitSynced(P);
      relay.goOffline();
      await P.evaluate(() => { window.__app.store.delayMs = 1500; });
      const t = `A${r}k90`;
      await typeAtEnd(P, ` ${t}`, { mode: 'insert' });
      const st = await status(P);
      if (st === 'unsaved') agg.s6Unsaved++;
      else fails.push('S6-本機寫入尚未完成，狀態卻顯示 ' + st);
      await P.close();
      ({ P } = await freshPage(ctx));
      await openDoc(P, env.base, docId); await waitSynced(P);
      const survived = tokensIn(await text(P)).has(t);
      if (!survived && st !== 'unsaved') fails.push(`S6-狀態顯示「${st}」但關閉後內容遺失（狀態不誠實）`);
      if (!survived) agg.s6LostWhileUnsaved++;
      m.s6 = { statusAtClose: st, survived };
      errs(P); await ctx.close();
    }
    rmProfile(dir45);
  }
}
