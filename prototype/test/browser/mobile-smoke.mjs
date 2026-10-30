// M0-15 手機測試頁的自動冒煙測試（手機尺寸＋觸控模擬）：用法 node test/browser/mobile-smoke.mjs web/dist/m0-15-<variant>.html
// 檢查：頁面無錯誤、預設內容、輸入法組字後畫面與模型一致、已存本機、重新整理後內容與勾選結果仍在、沒有橫向捲動；
// mantine 版另檢查斜線選單與格式工具列會出現。失敗時退出碼 1。
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywright } from './bharness.js';

const file = process.argv[2];
const variant = /mantine/.test(file) ? 'mantine' : 'core';
const body = readFileSync(file);
const html = Buffer.concat([Buffer.from('<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>'), body, Buffer.from('</body></html>')]);
const srv = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(html); }).listen(27400);
const pw = await loadPlaywright();
const ctx = await pw.chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'm015-')), { headless: true, args: ['--no-sandbox'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p = ctx.pages()[0];
const fails = [], info = { variant };
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
const savedState = () => p.waitForFunction(() => document.getElementById('save').dataset.state === 'saved', null, { timeout: 10000 });
try {
  await p.goto('http://127.0.0.1:27400/');
  await p.waitForSelector('.ProseMirror', { timeout: 20000 });
  await savedState();
  info.ui = await p.evaluate(() => globalThis.__m015UI);
  const types = await p.evaluate(() => [...document.querySelectorAll('.bn-block-content')].map(e => e.dataset.contentType));
  info.blocks = types;
  if (!types.includes('appAudio') || !types.includes('heading')) fails.push('預設內容不完整: ' + types.join(','));
  const cdp = await ctx.newCDPSession(p);
  await p.locator('.bn-inline-content').nth(2).click();
  for (const [comp, fin] of [['ㄇㄧㄥˊ', '明'], ['ㄊㄧㄢ', '天'], ['ㄒㄧㄚˋ', '下'], ['ㄨˇ', '午']]) {
    await cdp.send('Input.imeSetComposition', { text: comp, selectionStart: comp.length, selectionEnd: comp.length });
    await cdp.send('Input.insertText', { text: fin });
  }
  await p.keyboard.insertText('3點');
  await p.waitForTimeout(1500);
  const auto = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('#auto .kv')].map(k => [k.querySelector('dt').textContent, k.querySelector('dd').textContent])));
  info.auto = auto;
  if (auto['輸入法組字次數'] !== '4') fails.push('組字次數 ' + auto['輸入法組字次數']);
  if (auto['畫面與模型不一致'] !== '0') fails.push('畫面與模型不一致');
  const t3 = await p.locator('.bn-inline-content').nth(2).textContent();
  if (t3 !== '明天下午3點') fails.push('輸入結果 ' + t3);
  if (variant === 'mantine') {
    await p.keyboard.press('Enter');
    await p.keyboard.type('/');
    const menu = await p.waitForSelector('.bn-suggestion-menu', { timeout: 5000 }).then(() => true, () => false);
    if (!menu) fails.push('斜線選單沒有出現');
    await p.keyboard.press('Escape');
    await p.keyboard.press('Backspace');
    await p.locator('.bn-inline-content').nth(2).dblclick();
    const tb = await p.waitForSelector('.bn-formatting-toolbar', { timeout: 5000 }).then(() => true, () => false);
    if (!tb) fails.push('格式工具列沒有出現');
  }
  await p.locator('.seg button[data-r="pass"]').first().click();
  await savedState();
  await p.reload();
  await p.waitForSelector('.ProseMirror', { timeout: 20000 });
  await p.waitForTimeout(500);
  if (await p.locator('.bn-inline-content').nth(2).textContent() !== '明天下午3點') fails.push('重新整理後內容不見');
  if (await p.locator('.item .pill').first().textContent() !== '通過') fails.push('重新整理後勾選結果不見');
  const [sw, iw] = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  if (sw > iw) fails.push(`橫向捲動 ${sw} > ${iw}`);
  mkdirSync('results', { recursive: true });
  await p.screenshot({ path: `results/m0-15-${variant}.png` });
} catch (e) { fails.push('exception: ' + e.message); }
if (errs.length) fails.push('頁面錯誤: ' + errs.slice(0, 3).join(' / '));
await ctx.close(); srv.close();
const res = { id: 'M0-15-SMOKE', ...info, fails, pass: fails.length === 0 };
writeFileSync(`results/m0-15-smoke-${variant}.json`, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res));
if (fails.length && process.env.GITHUB_ACTIONS) console.log('::error title=m0-15::' + fails.join(' | '));
process.exit(fails.length ? 1 : 0);
