// 瀏覽器測試工具（M1）：Chromium 持久化設定檔、以已登入的 cookie 開啟正式網頁、攔截協作 WebSocket 以加延遲或模擬離線
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { COLLAB_PORT } from './env.mjs';

export async function loadPlaywright() {
  const mod = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const pw = await import(mod);
  return pw.chromium ? pw : pw.default;
}

export const newProfileDir = () => mkdtempSync(join(tmpdir(), 'm1-profile-'));
export const rmProfile = dir => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

export async function launch(pw, dir) {
  return pw.chromium.launchPersistentContext(dir, { headless: true, args: ['--no-sandbox'], viewport: { width: 1280, height: 860 } });
}

export function killBrowser(profileDir) {
  let pids = [];
  try { pids = execSync(`pgrep -f -- "--user-data-dir=${profileDir}"`, { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* none */ }
  for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
  return pids.length;
}

export async function useAgentCookies(ctx, agent) {
  await ctx.clearCookies();
  await ctx.addCookies(agent.playwrightCookies());
}

// 攔截這個頁面的協作連線（Playwright routeWebSocket）：可加回覆延遲、可整段中斷（模擬離線）
export async function installRelay(page) {
  // filter（M2-b COL-07）：伺服器送來的訊息經 filter(訊息字串) 回傳 'drop' 時不轉送
  // stalled（M2-b COL-03）：雙向都不轉送、也不關閉連線，模擬網路中斷但 TCP 沒有關閉
  // held（F-M2-09）：伺服器送來的訊息先排隊，release() 時依原順序送出（頁面送出的訊息照常轉送）
  const st = { delayMs: 0, offline: false, conns: new Set(), filter: null, stalled: false, held: null };
  await page.routeWebSocket(u => new URL(u).port === String(COLLAB_PORT), ws => {
    if (st.offline) { ws.close({ code: 1001, reason: 'offline' }); return; }
    const server = ws.connectToServer();
    const pair = { ws, server };
    st.conns.add(pair);
    ws.onMessage(m => { if (!st.stalled) server.send(m); });
    server.onMessage(m => { if (st.stalled) return; if (st.filter && st.filter(String(m)) === 'drop') return; if (st.held) { st.held.push([ws, m]); return; } if (st.delayMs > 0) setTimeout(() => ws.send(m), st.delayMs); else ws.send(m); });
    server.onClose((code, reason) => { st.conns.delete(pair); const fwd = () => ws.close({ code: code >= 4000 ? code : 1001, reason }); if (st.delayMs) setTimeout(fwd, st.delayMs); else fwd(); });
    ws.onClose(() => { st.conns.delete(pair); server.close(); });
  });
  return {
    st,
    setDelay(ms) { st.delayMs = ms; },
    goOffline() { st.offline = true; for (const p of [...st.conns]) { try { p.ws.close({ code: 1001, reason: 'offline' }); } catch { /* */ } try { p.server.close(); } catch { /* */ } } st.conns.clear(); },
    goOnline() { st.offline = false; },
    setFilter(fn) { st.filter = fn; },
    stall(on = true) { st.stalled = on; },
    hold() { st.held ||= []; },
    release() { const q = st.held || []; st.held = null; for (const [w, m] of q) { try { w.send(m); } catch { /* 連線已關閉 */ } } return q.length; },
    // 直接送一則訊息給頁面（模擬伺服器送來的訊息，例如不對應的確認）
    inject(msg) { for (const p of st.conns) p.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); },
    // 中斷目前的協作連線（不進入離線模式，用戶端會自動重新連線）
    dropConnections() { for (const p of [...st.conns]) { try { p.ws.close({ code: 1001, reason: 'drop' }); } catch { /* */ } try { p.server.close(); } catch { /* */ } } st.conns.clear(); },
  };
}

export async function openDoc(page, base, pageId) {
  if (!page.__hooked) {
    page.__hooked = true;
    page.on('pageerror', e => { page.__errors ||= []; page.__errors.push(String(e)); });
  }
  await page.goto(`${base}/p/${pageId}`);
  await waitReady(page);
  return page;
}

export async function waitReady(page, timeout = 20000) {
  await page.waitForFunction(() => window.__app && (window.__app.status() !== 'loading'), null, { timeout });
}

export const status = page => page.evaluate(() => window.__app.status());
export const text = page => page.evaluate(() => window.__app.text());
export const blocks = page => page.evaluate(() => window.__app.blocks());

export async function waitSynced(page, timeout = 20000) {
  await page.waitForFunction(() => {
    const a = window.__app; if (!a) return false;
    const c = a.client, s = c.storage;
    return c.ready && s.pending.length === 0 && s.unackedCopies.length === 0 && s.pendingRestores.length === 0
      && !s.offlineCopy && !c.awaitingOfflineCopy && a.status() === 'saved';
  }, null, { timeout, polling: 20 });
}

// 在編輯器輸入（同 M0-B：用 focus 而不是 click，避免連續 click 被當成三擊選取整段）
export async function typeAtEnd(page, s, { newBlock = false, mode = 'keys', where = 'last' } = {}) {
  await page.locator('.bn-editor').focus();
  if (where === 'first') { await page.keyboard.press('Control+Home'); await page.keyboard.press('End'); }
  else await page.keyboard.press('Control+End');
  if (newBlock) await page.keyboard.press('Enter');
  if (mode === 'insert') await page.keyboard.insertText(s);
  else await page.keyboard.type(s, { delay: 0 });
}

export const TOKEN_RE = /[AB]\d+[kdcou]\d+/g;
export const tokensIn = s => new Set(String(s).match(TOKEN_RE) || []);
