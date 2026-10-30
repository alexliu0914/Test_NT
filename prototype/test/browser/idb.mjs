// BR-02（GATE-03）：真正的 Chromium＋IndexedDB（持久化設定檔）
// S1 修改後立刻關閉分頁        S2 強制終止瀏覽器（SIGKILL）後重開   S3 離線修改後關閉瀏覽器、重開上線
// S4 有未同步修改時登入被撤銷，同帳號重新登入後補送
// S5 另一個帳號在同一台裝置：被封鎖、可下載、確認後才捨棄，且草稿不會以新帳號送出
// S6 本機寫入變慢時，狀態必須顯示「尚未存到本機」；只要顯示的不是這個狀態，關閉後內容就必須還在
// 共同判定：任何在「已存本機」（persisted）之後才關閉／終止的修改，都必須在重開後出現在編輯器，並同步進資料庫
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { db, ServerProc, newSession, revoke, setDbFault, loadFromDb, Recorder, sleep } from '../harness.js';
import { blocksOfState } from '../../src/export.js';
import { loadPlaywright, launchPersistent, newProfileDir, openPage, waitSynced, typeAtEnd, text, status, tokensIn, startRelay, rmProfile } from './bharness.js';

const within = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error('timeout: ' + label); })]);
const missing = (need, have) => [...need].filter(t => !have.has(t));
async function dbTokens(docId) { return tokensIn(JSON.stringify(blocksOfState((await loadFromDb(docId)).update))); }
// 本機版本號：每次輸入後記下當下的版本 v；之後只要觀察到 persistedVersion >= v，該次輸入就「已存本機」，必須存活
const versions = P => P.evaluate(() => ({ v: window.__m0.client.version, pv: window.__m0.client.persistedVersion }));
function markPersisted(log, pv, must) { for (const [t, v] of log) if (v <= pv) must.add(t); }

// 找出使用這個設定檔的所有 Chromium 行程並 kill -9（模擬當機／被系統強制結束）
function killBrowser(profileDir) {
  let pids = [];
  try { pids = execSync(`pgrep -f -- "--user-data-dir=${profileDir}"`, { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* none */ }
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
  return pids.length;
}

export async function br_02(N) {
  const rec = new Recorder('BR-02', 'GATE-03 IndexedDB：關閉分頁／強制終止瀏覽器／離線重開／登入撤銷／不同帳號／慢速寫入');
  const pw = await loadPlaywright();
  const PORT = 47330, RELAY = 47331;
  const base = `http://127.0.0.1:${PORT}`;
  const relayWs = `ws://127.0.0.1:${RELAY}`;
  const srv = new ServerProc(PORT);
  await srv.start();
  const relay = startRelay(RELAY, PORT);
  const tokA = await newSession('A');
  const agg = { s1LastLost: 0, s2Kills: 0, s2MustSurvive: 0, s6Unsaved: 0, s6LostWhileUnsaved: 0 };
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      const t0 = Date.now();
      const opened = [];
      try { await within(round(r, fails, m, opened), 150000, 'round'); } catch (e) { fails.push('exception: ' + e.message); }
      for (const o of opened) { try { await o.ctx.close(); } catch { /* 已被終止 */ } killBrowser(o.dir); rmProfile(o.dir); }
      relay.goOnline(); await setDbFault(false);
      m.ms = Date.now() - t0;
      rec.add(r, r, fails, m);
    }
  } finally { await relay.close(); await srv.stop(); }
  return rec.save({ meta: agg });

  async function round(r, fails, m, opened) {
    const launch = async dir => { const ctx = await launchPersistent(pw, dir); opened.push({ ctx, dir }); return ctx; };
    const pageIn = async ctx => ctx.pages()[0] || ctx.newPage();
    const errs = P => { if (P.__errors && P.__errors.length) fails.push('page error: ' + P.__errors.join(' / ')); };

    // ---- S1：修改後立刻關閉分頁（伺服器收不到：轉送離線） ----
    {
      const docId = randomUUID(), dir = newProfileDir();
      const ctx = await launch(dir);
      let P = await openPage(ctx, base, { docId, token: tokA, user: 'A', ws: relayWs }, await pageIn(ctx));
      await waitSynced(P);
      relay.goOffline();
      const must = new Set();
      const all = [];
      const k = 3 + (r % 4);
      const log = [];
      for (let i = 0; i < k; i++) {
        const t = `A${r}k${i}`; all.push(t);
        await typeAtEnd(P, ` ${t}`, { mode: 'insert' });
        const { v, pv } = await versions(P);
        log.push([t, v]);
        markPersisted(log, pv, must);
        if (i < k - 1) await sleep(r % 3 === 0 ? 0 : 30);
      }
      await P.close();                 // 最後一筆輸入後立刻關閉，不等寫入
      relay.goOnline();
      P = await openPage(ctx, base, { docId, token: tokA, user: 'A', ws: relayWs }, await ctx.newPage());
      await waitSynced(P);
      const ed = tokensIn(await text(P)), indb = await dbTokens(docId);
      if (missing(must, ed).length) fails.push('S1-已存本機但重開後遺失: ' + missing(must, ed).join(','));
      if (missing(ed, indb).length) fails.push('S1-重開後未同步進資料庫: ' + missing(ed, indb).join(','));
      if (!ed.has(all[all.length - 1])) agg.s1LastLost++;
      m.s1 = { typed: all.length, must: must.size, survived: ed.size };
      errs(P);
      await ctx.close();
    }

    // ---- S2：持續輸入中強制終止整個瀏覽器（SIGKILL），以同一設定檔重開 ----
    {
      const docId = randomUUID(), dir = newProfileDir();
      let ctx = await launch(dir);
      let P = await openPage(ctx, base, { docId, token: tokA, user: 'A', ws: relayWs }, await pageIn(ctx));
      await waitSynced(P);
      if (r % 2 === 0) relay.goOffline();   // 偶數輪：離線中被終止；奇數輪：連線中被終止
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
          log.push([t, v]);
          markPersisted(log, pv, must);
          await sleep(5);
        }
      } catch { /* 瀏覽器被終止後，頁面操作會失敗 */ }
      await killer;
      await sleep(200);
      relay.goOnline();
      ctx = await launch(dir);
      P = await openPage(ctx, base, { docId, token: tokA, user: 'A', ws: relayWs }, await pageIn(ctx));
      await waitSynced(P);
      const ed = tokensIn(await text(P)), indb = await dbTokens(docId);
      if (missing(must, ed).length) fails.push('S2-已存本機但強制終止後遺失: ' + missing(must, ed).slice(0, 5).join(','));
      if (missing(ed, indb).length) fails.push('S2-重開後未同步進資料庫: ' + missing(ed, indb).slice(0, 5).join(','));
      agg.s2MustSurvive += must.size;
      m.s2 = { killAt, typed: all.length, must: must.size, survived: ed.size, offline: r % 2 === 0 };
      errs(P);
      await ctx.close();
    }

    // ---- S3：離線修改後正常關閉瀏覽器，重開時上線 ----
    {
      const docId = randomUUID(), dir = newProfileDir();
      let ctx = await launch(dir);
      let P = await openPage(ctx, base, { docId, token: tokA, user: 'A', ws: relayWs }, await pageIn(ctx));
      await waitSynced(P);
      relay.goOffline();
      await P.waitForFunction(() => !window.__m0.client.ready, null, { timeout: 5000 });
      const toks = [0, 1, 2].map(i => `A${r}o${i}`);
      for (const t of toks) await typeAtEnd(P, ` ${t}`);
      await P.waitForFunction(() => window.__m0.persisted(), null, { timeout: 5000 });
      const st = await status(P);
      if (!['saving', 'failed'].includes(st)) fails.push('S3-離線時狀態應為 saving/failed，實際 ' + st);
      await ctx.close();
      relay.goOnline();
      ctx = await launch(dir);
      P = await openPage(ctx, base, { docId, token: tokA, user: 'A', ws: relayWs }, await pageIn(ctx));
      await waitSynced(P);
      const ed = tokensIn(await text(P)), indb = await dbTokens(docId);
      if (missing(toks, ed).length || missing(toks, indb).length) fails.push(`S3-離線內容遺失 editor=${missing(toks, ed)} db=${missing(toks, indb)}`);
      errs(P);
      await ctx.close();
    }

    // ---- S4：有未同步修改時登入被撤銷；同一帳號重新登入後補送 ----
    const dir45 = newProfileDir();
    const doc4 = randomUUID();
    const toks4 = [0, 1].map(i => `A${r}c${i}`);
    {
      const tok = await newSession('A');
      const ctx = await launch(dir45);
      let P = await openPage(ctx, base, { docId: doc4, token: tok, user: 'A' }, await pageIn(ctx));
      await waitSynced(P);
      await setDbFault(true);                       // 伺服器寫不進資料庫 → 修改停在待確認
      for (const t of toks4) await typeAtEnd(P, ` ${t}`, { mode: 'insert' });
      await P.waitForFunction(() => window.__m0.persisted() && window.__m0.client.storage.pending.length > 0, null, { timeout: 5000 });
      await revoke(tok);
      await P.waitForFunction(() => window.__m0.status() === 'revoked', null, { timeout: 10000 });
      const editable = await P.evaluate(() => window.__m0.editor().isEditable);
      if (editable) fails.push('S4-撤銷後編輯器仍可編輯');
      await setDbFault(false);
      await sleep(300);
      const tok2 = await newSession('A');
      P = await openPage(ctx, base, { docId: doc4, token: tok2, user: 'A' }, P);
      await waitSynced(P);
      const ed = tokensIn(await text(P)), indb = await dbTokens(doc4);
      if (missing(toks4, ed).length || missing(toks4, indb).length) fails.push(`S4-重新登入後未補送 editor=${missing(toks4, ed)} db=${missing(toks4, indb)}`);
      errs(P);
      await ctx.close();
    }

    // ---- S5：同一裝置換成另一個帳號 ----
    {
      const docA = randomUUID();
      const ctx = await launch(dir45);
      let P = await openPage(ctx, base, { docId: docA, token: tokA, user: 'A', ws: relayWs }, await pageIn(ctx));
      await waitSynced(P);
      relay.goOffline();
      const toksA = [0, 1].map(i => `A${r}u${i}`);
      for (const t of toksA) await typeAtEnd(P, ` ${t}`, { mode: 'insert' });
      await P.waitForFunction(() => window.__m0.persisted(), null, { timeout: 5000 });
      await P.close();
      relay.goOnline();
      const tokC = await newSession('C');
      const docC = randomUUID();
      P = await openPage(ctx, base, { docId: docC, token: tokC, user: 'C' }, await ctx.newPage());
      const st = await status(P);
      if (st !== 'blocked') fails.push('S5-另一帳號未被封鎖，狀態 ' + st);
      if (await P.evaluate(() => !!window.__m0.editor())) fails.push('S5-被封鎖時仍建立了編輯器');
      const drafts = await P.evaluate(() => window.__m0.foreignDrafts());
      const dl = tokensIn(JSON.stringify(drafts.map(d => d.json)));
      if (missing(toksA, dl).length) fails.push('S5-下載的草稿缺少: ' + missing(toksA, dl).join(','));
      // 同一份文件以 C 開啟也必須被封鎖，且 A 的草稿不可用 C 的身分送出
      P = await openPage(ctx, base, { docId: docA, token: tokC, user: 'C' }, P);
      if (await status(P) !== 'blocked') fails.push('S5-以另一帳號開啟同一文件未被封鎖');
      await sleep(300);
      const leaked = [...await dbTokens(docA)].filter(t => toksA.includes(t));
      if (leaked.length) fails.push('S5-另一帳號的草稿被送到伺服器: ' + leaked.join(','));
      await P.evaluate(() => window.__m0.discardForeign());
      P = await openPage(ctx, base, { docId: docC, token: tokC, user: 'C' }, P);
      await waitSynced(P);
      const left = await P.evaluate(() => window.__m0.foreignDrafts());
      if (left.length) fails.push('S5-捨棄後仍有其他帳號草稿');
      errs(P);
      await ctx.close();
    }

    // ---- S6：本機寫入延遲 1.5 秒；狀態必須如實顯示「尚未存到本機」 ----
    {
      const docId = randomUUID(), dir = newProfileDir();
      const ctx = await launch(dir);
      let P = await openPage(ctx, base, { docId, token: tokA, user: 'A', ws: relayWs }, await pageIn(ctx));
      await waitSynced(P);
      relay.goOffline();
      await P.evaluate(() => { window.__m0.store.delayMs = 1500; });
      const t = `A${r}k90`;
      await typeAtEnd(P, ` ${t}`, { mode: 'insert' });
      const st = await status(P);
      if (st === 'unsaved') agg.s6Unsaved++;
      else fails.push('S6-本機寫入尚未完成，狀態卻顯示 ' + st);
      await P.close();
      relay.goOnline();
      P = await openPage(ctx, base, { docId, token: tokA, user: 'A', ws: relayWs }, await ctx.newPage());
      await waitSynced(P);
      const survived = tokensIn(await text(P)).has(t);
      if (!survived && st !== 'unsaved') fails.push(`S6-狀態顯示「${st}」但關閉後內容遺失（狀態不誠實）`);
      if (!survived) agg.s6LostWhileUnsaved++;
      m.s6 = { statusAtClose: st, survived };
      errs(P);
      await ctx.close();
    }
  }
}
