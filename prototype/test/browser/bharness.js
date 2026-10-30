// 瀏覽器測試共用工具：啟動 Chromium、開啟 BlockNote 測試頁、讀取狀態、可延遲／中斷的 WebSocket 轉送
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

export async function loadPlaywright() {
  const mod = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const pw = await import(mod);
  return pw.chromium ? pw : pw.default;
}

export const newProfileDir = () => mkdtempSync(join(tmpdir(), 'm0-profile-'));
export const rmProfile = dir => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

// 以持久化設定檔啟動（IndexedDB 存在磁碟上，關閉或強制終止後可重開驗證）
export async function launchPersistent(pw, dir) {
  return pw.chromium.launchPersistentContext(dir, { headless: true, args: ['--no-sandbox'] });
}

export function pageUrl(base, { docId, token, user, ws }) {
  const q = new URLSearchParams({ doc: docId, token, user });
  if (ws) q.set('ws', ws);
  return `${base}/web/index.html?${q}`;
}

export async function openPage(ctx, base, opts, page = null) {
  page ||= ctx.pages()[0] || await ctx.newPage();
  if (!page.__hooked) {
    page.__hooked = true;
    page.on('pageerror', e => { page.__errors ||= []; page.__errors.push(String(e)); });
  }
  await page.goto(pageUrl(base, opts));
  await waitReady(page);
  return page;
}

export async function waitReady(page, timeout = 15000) {
  await page.waitForFunction(() => document.body.dataset.ready === '1' && window.__m0, null, { timeout });
}

export const status = page => page.evaluate(() => window.__m0.status());
export const text = page => page.evaluate(() => window.__m0.text());
export const blocks = page => page.evaluate(() => window.__m0.blocks());
export const persisted = page => page.evaluate(() => window.__m0.persisted());

export async function waitStatus(page, wanted, timeout = 15000) {
  await page.waitForFunction(w => w.includes(window.__m0.status()), Array.isArray(wanted) ? wanted : [wanted], { timeout, polling: 20 });
}

// 已連線、伺服器已確認全部修改、沒有待處理的衝突副本或還原
export async function waitSynced(page, timeout = 20000) {
  await page.waitForFunction(() => {
    const c = window.__m0.client, s = c.storage;
    return c.ready && s.pending.length === 0 && s.unackedCopies.length === 0 && s.pendingRestores.length === 0
      && !s.offlineCopy && !c.awaitingOfflineCopy && window.__m0.status() === 'saved';
  }, null, { timeout, polling: 20 });
}

// 在編輯器最後一個區塊尾端輸入
// mode='keys'：逐鍵輸入（真正的鍵盤事件）；mode='insert'：整段一次插入（一個交易，避免詞元被還原切成兩半）
// where='first'：第一個區塊的行尾（兩人同時輸入時各自用不同區塊，避免同一位置交錯成無法辨識的字串）
export async function typeAtEnd(page, s, { newBlock = false, mode = 'keys', where = 'last' } = {}) {
  // 用 focus 而非 click：連續在同一點 click 會被瀏覽器當成雙擊／三擊而選取整段，接著輸入就會取代掉選取的文字
  await page.locator('.bn-editor').focus();
  if (where === 'first') { await page.keyboard.press('Control+Home'); await page.keyboard.press('End'); }
  else await page.keyboard.press('Control+End');
  if (newBlock) await page.keyboard.press('Enter');
  if (mode === 'insert') await page.keyboard.insertText(s);
  else await page.keyboard.type(s, { delay: 0 });
}

// 測試詞元：<使用者><輪次><種類><序號>，例如 A3k12。種類：k 一般、d 伺服器停機時、c 與還原同時、o 離線、u Undo 測試
export const TOKEN_RE = /[AB]\d+[kdcou]\d+/g;
export const tokensIn = s => new Set(String(s).match(TOKEN_RE) || []);

// ---- 瀏覽器到伺服器之間的 WebSocket 轉送：可加延遲、可整段中斷（模擬離線） ----
export function startRelay(listenPort, targetPort) {
  const wss = new WebSocketServer({ port: listenPort });
  const st = { delayMs: 0, offline: false, conns: new Set() };
  wss.on('connection', down => {
    if (st.offline) { down.terminate(); return; }
    const up = new WebSocket('ws://127.0.0.1:' + targetPort);
    const pair = { down, up };
    st.conns.add(pair);
    const queue = [];
    up.on('open', () => { for (const q of queue) up.send(q); queue.length = 0; });
    down.on('message', d => { const s = d.toString(); if (up.readyState === 1) up.send(s); else queue.push(s); });
    up.on('message', d => {
      const s = d.toString();
      const fwd = () => { if (down.readyState === 1) down.send(s); };
      if (st.delayMs > 0) setTimeout(fwd, st.delayMs); else fwd();
    });
    const end = () => { st.conns.delete(pair); try { down.terminate(); } catch { /* */ } try { up.terminate(); } catch { /* */ } };
    down.on('close', end);
    up.on('close', (code) => {
      st.conns.delete(pair);
      // 撤銷（4001）要原樣傳回瀏覽器
      if (st.delayMs > 0) setTimeout(() => { try { down.close(code >= 4000 ? code : 1001); } catch { /* */ } }, st.delayMs);
      else try { down.close(code >= 4000 ? code : 1001); } catch { /* */ }
    });
    down.on('error', () => {}); up.on('error', () => {});
  });
  return {
    st,
    setDelay(ms) { st.delayMs = ms; },
    goOffline() { st.offline = true; for (const p of [...st.conns]) { try { p.down.terminate(); } catch { /* */ } try { p.up.terminate(); } catch { /* */ } } st.conns.clear(); },
    goOnline() { st.offline = false; },
    close: () => new Promise(r => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
  };
}
