// M2-a 編輯器案例（M2 計畫 v0.4 §4）：EDIT-01、EDIT-02、BR-05、SEC-04
// 全部在真正的 Chromium、正式登入（含 TOTP）與正式協作伺服器上執行；每項檢查兩個用戶端與資料庫。
import { isDeepStrictEqual } from 'node:util';

import { newPage, sleep, db } from '../lib/harness.mjs';
import { loadFromDb } from '../lib/m0-compat.mjs';
import { Recorder, within } from '../lib/recorder.mjs';
import { bootEnv } from '../lib/env.mjs';
import { blocksOfState } from '../../shared/export.js';
import { isSafeHref } from '../../shared/link-policy.js';
import { SLASH_TITLES, PAGE_LINK_TITLE } from '../../shared/editor-dictionary.js';
import { loadPlaywright, launch, newProfileDir, rmProfile, useAgentCookies, openDoc, waitSynced, blocks, installRelay } from '../lib/browser.mjs';

const canon = x => JSON.parse(JSON.stringify(x));
const flat = bs => { const out = []; const go = l => { for (const b of l) { out.push(b); go(b.children || []); } }; go(bs); return out; };
const inlineText = c => (Array.isArray(c) ? c.map(x => x.text ?? inlineText(x.content)).join('') : '');
const blockText = b => (b.content && b.content.type === 'tableContent'
  ? b.content.rows.map(r => r.cells.map(c => inlineText(Array.isArray(c) ? c : c.content)).join('|')).join('/')
  : inlineText(b.content));
const allText = bs => flat(bs).map(blockText).join('\n');

async function twoBrowsers(env) {
  const [UA, UB] = env.users;
  const pw = await loadPlaywright();
  const dA = newProfileDir(), dB = newProfileDir();
  const cA = await launch(pw, dA), cB = await launch(pw, dB);
  await useAgentCookies(cA, UA.agent); await useAgentCookies(cB, UB.agent);
  const A = cA.pages()[0] || await cA.newPage();
  const B = cB.pages()[0] || await cB.newPage();
  return { UA, UB, A, B, close: async () => { await cA.close().catch(() => {}); await cB.close().catch(() => {}); rmProfile(dA); rmProfile(dB); } };
}

async function openBoth(env, A, B, docId) {
  await Promise.all([openDoc(A, env.base, docId), openDoc(B, env.base, docId)]);
  await Promise.all([waitSynced(A), waitSynced(B)]);
  await Promise.all([A, B].map(P => P.waitForFunction(() => window.__app.pageRegistryLoaded(), null, { timeout: 15000 })));
}

// 等兩邊與資料庫的區塊完全相同（最多 ms）
async function converge(A, B, docId, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    await Promise.all([waitSynced(A, 15000).catch(() => {}), waitSynced(B, 15000).catch(() => {})]);
    const [ba, bb, bd] = [canon(await blocks(A)), canon(await blocks(B)), canon(blocksOfState((await loadFromDb(docId)).update))];
    if (isDeepStrictEqual(ba, bb) && isDeepStrictEqual(ba, bd)) return { ok: true, blocks: bd, ms: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { ok: false, ba, bb, bd };
    await sleep(200);
  }
}
const diverged = (c, label) => `${label}：10 秒內兩邊與資料庫不一致 A=${allText(c.ba).slice(0, 160)} B=${allText(c.bb).slice(0, 160)} DB=${allText(c.bd).slice(0, 160)}`;

async function reloadBoth(env, A, B, docId) {
  await Promise.all([A.reload(), B.reload()]);
  await Promise.all([A, B].map(P => P.waitForFunction(() => window.__app && window.__app.status() !== 'loading', null, { timeout: 20000 })));
  await Promise.all([waitSynced(A), waitSynced(B)]);
  await Promise.all([A, B].map(P => P.waitForFunction(() => window.__app.pageRegistryLoaded(), null, { timeout: 15000 })));
}

const pageErrors = (fails, pairs) => {
  for (const [n, P] of pairs) if (P.__errors && P.__errors.length) { fails.push(n + ' 頁面錯誤：' + P.__errors.join(' / ').slice(0, 300)); P.__errors = []; }
};

// 游標放到文件最後一個新的空段落（用編輯器 API 建立，讓每個步驟互不影響）
async function freshParagraph(P) {
  await P.evaluate(() => {
    const e = window.__app.editor;
    const last = e.document[e.document.length - 1];
    const [b] = e.insertBlocks([{ type: 'paragraph' }], last, 'after');
    e.setTextCursorPosition(b, 'end');
    e.focus();
  });
}

async function pasteInto(P, { html = '', plain = '' }) {
  await P.evaluate(([html, plain]) => {
    const el = document.querySelector('.bn-editor');
    const dt = new DataTransfer();
    if (html) dt.setData('text/html', html);
    if (plain) dt.setData('text/plain', plain);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [html, plain]);
}

// ---------------------------------------------------------------- EDIT-01
// 每種 FR-04 區塊建立、編輯、刪除後重新整理，兩邊與資料庫一致；頁面連結指向垃圾桶／已永久刪除的頁面時不顯示標題；
// 尚未支援的區塊（圖片）不被默默刪除，也不使用區塊裡的網址
export async function edit01(N) {
  const rec = new Recorder('EDIT-01', '每種區塊建立、編輯、刪除、重新整理後兩邊與資料庫一致；頁面連結不洩漏已刪除頁面的標題；不支援的區塊不被刪除');
  const env = await bootEnv({ users: 2 });
  const S = await twoBrowsers(env);
  const { UA, A, B } = S;
  const lat = [];
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try {
        await within((async () => {
          const docId = await newPage(UA.agent, `區塊${r}`);
          const live = await newPage(UA.agent, `連結目標${r}`);
          const trashed = await newPage(UA.agent, `機密垃圾${r}`);
          const purged = await newPage(UA.agent, `機密已刪${r}`);
          const del = await UA.agent.del(`/api/pages/${trashed}`);
          if (del.status !== 200) fails.push('無法把頁面移到垃圾桶 ' + del.status);
          await db.query('delete from pages where id=$1', [purged]);   // 模擬已永久刪除
          await openBoth(env, A, B, docId);
          // 建立：每種區塊（含巢狀、粗體、連結、勾選、程式語言、表格）
          await A.evaluate(({ live, trashed, purged, r }) => {
            const e = window.__app.editor, T = s => s + r;
            e.replaceBlocks([e.document[0]], [
              { type: 'heading', props: { level: 1 }, content: T('標題一') },
              { type: 'heading', props: { level: 2 }, content: T('標題二') },
              { type: 'heading', props: { level: 3 }, content: T('標題三') },
              { type: 'paragraph', content: [{ type: 'text', text: T('內文'), styles: { bold: true } }, { type: 'link', href: 'https://example.com/' + r, content: T('外部連結') }] },
              { type: 'bulletListItem', content: T('項目'), children: [{ type: 'bulletListItem', content: T('子項目') }] },
              { type: 'numberedListItem', content: T('編號') },
              { type: 'checkListItem', props: { checked: true }, content: T('待辦') },
              { type: 'quote', content: T('引言') },
              { type: 'divider' },
              { type: 'codeBlock', props: { language: 'javascript' }, content: T('const x = ') },
              { type: 'table', content: { type: 'tableContent', rows: [{ cells: [T('甲'), T('乙')] }, { cells: [T('丙'), T('丁')] }] } },
              { type: 'pageLink', props: { pageId: live } },
              { type: 'pageLink', props: { pageId: trashed } },
              { type: 'pageLink', props: { pageId: purged } },
              { type: 'image', props: { url: 'javascript:window.__xss=1', name: '舊圖片', caption: T('保留說明') } },
            ]);
          }, { live, trashed, purged, r });
          let c = await converge(A, B, docId);
          if (!c.ok) { fails.push(diverged(c, '建立後')); return; }
          lat.push(c.ms);
          const want = ['heading', 'paragraph', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote', 'divider', 'codeBlock', 'table', 'pageLink', 'image'];
          const types = new Set(flat(c.blocks).map(b => b.type));
          for (const t of want) if (!types.has(t)) fails.push('資料庫缺少區塊類型 ' + t);
          const img = flat(c.blocks).find(b => b.type === 'image');
          if (!img || img.props.url !== 'javascript:window.__xss=1' || img.props.caption !== '保留說明' + r) fails.push('不支援的圖片區塊內容沒有完整保留');
          const nested = c.blocks.find(b => b.type === 'bulletListItem');
          if (!nested || !nested.children || nested.children[0]?.content?.[0]?.text !== '子項目' + r) fails.push('巢狀清單沒有保留');
          const checkDom = async (tag, P) => {
            const d = await P.evaluate(({ live, trashed, purged }) => {
              const ed = document.querySelector('.bn-editor');
              const q = s => [...ed.querySelectorAll(s)];
              return {
                liveText: q(`a.app-page-link[data-page-id="${live}"]`).map(a => a.textContent + '|' + a.getAttribute('href')),
                unavailable: q('a.app-page-link[data-unavailable]').length,
                text: ed.innerText,
                unsupported: q('.app-unsupported[data-unsupported="image"]').length,
                imgs: q('img').map(i => i.getAttribute('src')),
                jsHrefs: q('[href]').map(x => x.getAttribute('href')).filter(h => /script:/i.test(h)),
                xss: window.__xss,
              };
            }, { live, trashed, purged });
            if (d.liveText.length !== 1 || !d.liveText[0].includes('連結目標' + r) || !d.liveText[0].endsWith('|/p/' + live)) fails.push(`${tag} 頁面連結沒有顯示目前標題：${d.liveText}`);
            if (d.unavailable !== 2) fails.push(`${tag} 指向垃圾桶／已刪除頁面的連結應顯示為無法開啟（${d.unavailable}）`);
            if (d.text.includes('機密垃圾' + r) || d.text.includes('機密已刪' + r)) fails.push(`${tag} 顯示了已刪除頁面的標題`);
            if (d.unsupported !== 1 || d.imgs.length) fails.push(`${tag} 圖片區塊應顯示為尚未支援、不載入網址（${d.unsupported}、${d.imgs}）`);
            if (d.jsHrefs.length || d.xss) fails.push(`${tag} 出現可執行的網址`);
          };
          await checkDom('A', A); await checkDom('B', B);
          // 重新整理後不變
          const before = c.blocks;
          await reloadBoth(env, A, B, docId);
          c = await converge(A, B, docId);
          if (!c.ok) { fails.push(diverged(c, '重新整理後')); return; }
          if (!isDeepStrictEqual(c.blocks, before)) fails.push('重新整理後內容改變');
          await checkDom('A 重新整理後', A); await checkDom('B 重新整理後', B);
          // 編輯：A 改標題、取消勾選、標題 2 改為 3；B 同時改程式碼與表格
          await Promise.all([
            A.evaluate(r => {
              const e = window.__app.editor, d = e.document;
              e.updateBlock(d[0], { content: '改過的標題' + r });
              e.updateBlock(d.find(b => b.type === 'checkListItem'), { props: { checked: false } });
              e.updateBlock(d[1], { props: { level: 3 } });
            }, r),
            B.evaluate(r => {
              const e = window.__app.editor, d = e.document;
              e.updateBlock(d.find(b => b.type === 'codeBlock'), { content: 'let y = ' + r });
              e.updateBlock(d.find(b => b.type === 'table'), { content: { type: 'tableContent', rows: [{ cells: ['改甲' + r, '乙' + r] }, { cells: ['丙' + r, '改丁' + r] }] } });
            }, r),
          ]);
          c = await converge(A, B, docId);
          if (!c.ok) { fails.push(diverged(c, '編輯後')); return; }
          const t = allText(c.blocks);
          for (const s of ['改過的標題' + r, 'let y = ' + r, '改甲' + r, '改丁' + r]) if (!t.includes(s)) fails.push('編輯沒有保留：' + s);
          if (c.blocks[1].props.level !== 3) fails.push('標題層級的修改沒有保留');
          if (flat(c.blocks).find(b => b.type === 'checkListItem').props.checked !== false) fails.push('待辦的勾選修改沒有保留');
          // 刪除：分隔線、引言、編號清單
          await A.evaluate(() => {
            const e = window.__app.editor;
            e.removeBlocks(e.document.filter(b => ['divider', 'quote', 'numberedListItem'].includes(b.type)));
          });
          c = await converge(A, B, docId);
          if (!c.ok) { fails.push(diverged(c, '刪除後')); return; }
          const left = new Set(flat(c.blocks).map(b => b.type));
          for (const tp of ['divider', 'quote', 'numberedListItem']) if (left.has(tp)) fails.push('刪除沒有生效：' + tp);
          const afterDelete = c.blocks;
          await reloadBoth(env, A, B, docId);
          c = await converge(A, B, docId);
          if (!c.ok) fails.push(diverged(c, '刪除後重新整理'));
          else if (!isDeepStrictEqual(c.blocks, afterDelete)) fails.push('刪除後重新整理內容改變');
          m.blocks = flat(c.blocks || []).length;
        })(), 120000, 'round');
      } catch (e) { fails.push('exception: ' + e.message); }
      pageErrors(fails, [['A', A], ['B', B]]);
      rec.add(r, r, fails, m);
    }
  } finally { await S.close(); }
  lat.sort((a, b) => a - b);
  return rec.save({ converge: { p50: lat[Math.floor(lat.length / 2)], max: lat.at(-1) } });
}

// ---------------------------------------------------------------- EDIT-02
// 斜線指令（繁中、只列 FR-04 的區塊與頁面連結）、Markdown 快捷輸入、拖曳區塊；兩人與重新整理後一致
const SLASH_QUERY = { heading: '標題1', heading_2: '標題2', heading_3: '標題3', paragraph: '內文', bullet_list: '項目清單', numbered_list: '編號清單',
  check_list: '待辦清單', quote: '引言', divider: '分隔線', code_block: '程式碼', table: '表格' };
const SLASH_EXPECT = {
  heading: b => b.type === 'heading' && b.props.level === 1, heading_2: b => b.type === 'heading' && b.props.level === 2,
  heading_3: b => b.type === 'heading' && b.props.level === 3, paragraph: b => b.type === 'paragraph',
  bullet_list: b => b.type === 'bulletListItem', numbered_list: b => b.type === 'numberedListItem', check_list: b => b.type === 'checkListItem',
  quote: b => b.type === 'quote', divider: b => b.type === 'divider', code_block: b => b.type === 'codeBlock', table: b => b.type === 'table',
};
const MD_SHORTCUTS = [
  ['# ', b => b.type === 'heading' && b.props.level === 1], ['## ', b => b.type === 'heading' && b.props.level === 2],
  ['### ', b => b.type === 'heading' && b.props.level === 3], ['- ', b => b.type === 'bulletListItem'],
  ['1. ', b => b.type === 'numberedListItem'], ['[] ', b => b.type === 'checkListItem'], ['> ', b => b.type === 'quote'],
  ['``` ', b => b.type === 'codeBlock'],
];

export async function edit02(N) {
  const rec = new Recorder('EDIT-02', '斜線指令（繁中）、Markdown 快捷輸入、拖曳區塊轉換為正確的區塊；兩人與重新整理後一致');
  const env = await bootEnv({ users: 2 });
  const S = await twoBrowsers(env);
  const { UA, A, B } = S;
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try {
        await within((async () => {
          const docId = await newPage(UA.agent, `操作${r}`);
          const target = await newPage(UA.agent, `目標頁${r}`);
          await openBoth(env, A, B, docId);
          // 斜線選單的項目：繁中名稱，只有允許的區塊與頁面連結
          await freshParagraph(A);
          await A.keyboard.type('/');
          await A.locator('.bn-suggestion-menu').waitFor({ timeout: 5000 });
          const shown = new Set((await A.locator('.bn-suggestion-menu-item').allInnerTexts())
            .map(s => s.split('\n').map(t => t.trim()).filter(t => t && !/^\p{Extended_Pictographic}+$/u.test(t))[0]));
          const expected = new Set([...Object.values(SLASH_TITLES), PAGE_LINK_TITLE]);
          if (!isDeepStrictEqual(shown, expected)) fails.push(`斜線選單項目不符：${[...shown].join('、')}`);
          await A.keyboard.press('Escape');
          await A.keyboard.press('Backspace');
          // 斜線指令建立每種區塊
          const made = [];
          for (const [key, q] of Object.entries(SLASH_QUERY)) {
            await freshParagraph(A);
            await A.keyboard.type('/' + q, { delay: 10 });
            await A.locator('.bn-suggestion-menu').waitFor({ timeout: 5000 });
            await A.keyboard.press('Enter');
            await sleep(60);
            const tok = key === 'divider' ? null : `斜${key}${r}`;
            if (tok) await A.keyboard.type(tok, { delay: 5 });
            made.push([key, tok]);
          }
          // 斜線指令插入頁面連結
          await freshParagraph(A);
          await A.keyboard.type('/' + PAGE_LINK_TITLE, { delay: 10 });
          await A.locator('.bn-suggestion-menu').waitFor({ timeout: 5000 });
          await A.keyboard.press('Enter');
          await A.locator(`[data-testid="page-link-picker"] [data-page-id="${target}"], .mantine-Modal-body [data-page-id="${target}"]`).first().click({ timeout: 5000 });
          // Markdown 快捷輸入
          for (const [md] of MD_SHORTCUTS) {
            await freshParagraph(A);
            await A.keyboard.type(md + `快${MD_SHORTCUTS.findIndex(x => x[0] === md)}x${r}`, { delay: 5 });
          }
          let c = await converge(A, B, docId);
          if (!c.ok) { fails.push(diverged(c, '建立後')); return; }
          const all = flat(c.blocks);
          for (const [key, tok] of made) {
            const ok = tok ? all.some(b => SLASH_EXPECT[key](b) && blockText(b).includes(tok)) : all.some(SLASH_EXPECT[key]);
            if (!ok) fails.push(`斜線指令「${SLASH_QUERY[key]}」沒有建立正確的區塊`);
          }
          if (!all.some(b => b.type === 'pageLink' && b.props.pageId === target)) fails.push('斜線指令沒有插入頁面連結');
          MD_SHORTCUTS.forEach(([md, ok], i) => {
            const b = all.find(x => blockText(x).includes(`快${i}x${r}`));
            if (!b || !ok(b)) fails.push(`快捷輸入「${md.trim()}」沒有轉換（得到 ${b ? b.type : '無'}）`);
          });
          // 拖曳：把最後一個區塊拖到第一個區塊上方
          await A.evaluate(r => {
            const e = window.__app.editor;
            e.insertBlocks([{ type: 'paragraph', content: '拖曳甲' + r }, { type: 'paragraph', content: '拖曳乙' + r }], e.document[e.document.length - 1], 'after');
          }, r);
          await waitSynced(A);
          const ids = await A.evaluate(() => { const d = window.__app.editor.document; return { first: d[0].id, last: d[d.length - 1].id }; });
          const src = A.locator(`.bn-block-outer[data-id="${ids.last}"] .bn-block-content`).first();
          await src.scrollIntoViewIfNeeded();
          await src.hover();
          const handle = A.locator('.bn-side-menu [draggable="true"]').first();
          await handle.waitFor({ timeout: 5000 });
          // 以滑鼠拖曳側邊選單的把手（HTML5 拖放），放到第一個區塊上：應移到第一或第二個位置（依 BlockNote 的放置規則）
          const dst = A.locator(`.bn-block-outer[data-id="${ids.first}"] .bn-block-content`).first();
          const hb = await handle.boundingBox();
          await A.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
          await A.mouse.down();
          await A.mouse.move(hb.x + 10, hb.y - 5, { steps: 5 });
          await dst.scrollIntoViewIfNeeded().catch(() => {});
          const box = await dst.boundingBox();
          await A.mouse.move(box.x + 40, box.y + box.height * 0.75, { steps: 25 });
          await A.mouse.up();
          c = await converge(A, B, docId);
          if (!c.ok) { fails.push(diverged(c, '拖曳後')); return; }
          { const at = c.blocks.findIndex(b => b.id === ids.last);
            if (at < 0 || at > 1) fails.push(`拖曳後區塊沒有移到第一個區塊旁（位置 ${at}／${c.blocks.length}）`); }
          const before = c.blocks;
          await reloadBoth(env, A, B, docId);
          c = await converge(A, B, docId);
          if (!c.ok) fails.push(diverged(c, '重新整理後'));
          else if (!isDeepStrictEqual(c.blocks, before)) fails.push('重新整理後內容改變');
          m.blocks = flat(before).length;
        })(), 150000, 'round');
      } catch (e) { fails.push('exception: ' + e.message); }
      pageErrors(fails, [['A', A], ['B', B]]);
      rec.add(r, r, fails, m);
    }
  } finally { await S.close(); }
  return rec.save();
}

// ---------------------------------------------------------------- BR-05
// 兩人在同一位置同時建立表格、巢狀清單、貼上多個區塊（含尚未同步就開始、離線後合併、同時改同一區塊的類型）：
// 兩邊與資料庫一致、兩人輸入的內容都在且沒有重複、只有一個頂層骨架。
// 「同時改同一個區塊的類型」會讓 y-prosemirror 刪掉整個區塊（F-M2-01），模式 2、4、5 專門重現這個情況。
const topLevel = P => P.evaluate(() => window.__app.client.ydoc.getXmlFragment('document-store').length);

async function makeStructure(P, kind, tok, { enterFirst = true } = {}) {
  await P.locator('.bn-editor').focus();
  await P.keyboard.press('Control+End');
  if (enterFirst) await P.keyboard.press('Enter');
  if (kind === 'table') {
    await P.keyboard.type('/表格', { delay: 10 });
    await P.locator('.bn-suggestion-menu').waitFor({ timeout: 5000 });
    await P.keyboard.press('Enter');
    await sleep(60);
    await P.keyboard.type(tok + '格', { delay: 10 });
  } else if (kind === 'nested') {
    await P.keyboard.type('- ' + tok + '上', { delay: 10 });
    await P.keyboard.press('Enter');
    await P.keyboard.press('Tab');
    await P.keyboard.type(tok + '下', { delay: 10 });
  } else if (kind === 'heading') {
    await P.keyboard.type('# ' + tok + '題', { delay: 10 });
  } else if (kind === 'bullet') {
    await P.keyboard.type('- ' + tok + '項', { delay: 10 });
  } else {
    await pasteInto(P, { html: `<h2>${tok}題</h2><ul><li>${tok}一<ul><li>${tok}二</li></ul></li></ul><p>${tok}尾</p>` });
  }
}
const STRUCT_TOKENS = { table: ['格'], nested: ['上', '下'], paste: ['題', '一', '二', '尾'], heading: ['題'], bullet: ['項'] };
const count = (s, sub) => s.split(sub).length - 1;

// [A 的結構, B 的結構, 開始方式]
//  sync：已同步後兩人各自在最後按 Enter 開新行（同一位置）再建立
//  same：已同步後兩人直接在同一個空白行建立（同一個區塊被兩人同時改類型）
//  unsynced：編輯器一出現就開始（不等協作連線）；用 Markdown 快捷輸入建立（斜線選單會被第一次同步的重新繪製關閉，T-M2-02）
//  offline：A 離線時把第一行改成標題，B 同時把同一行改成清單，A 再連線（必定是同一個區塊）
//  convert：同一個有文字的區塊，A 用快捷鍵改成標題、B 同時改成項目清單
const MODES = [
  ['table', 'table', 'sync'], ['nested', 'nested', 'sync'], ['paste', 'paste', 'same'], ['nested', 'heading', 'unsynced'],
  ['heading', 'bullet', 'offline'], ['heading', 'bullet', 'convert'], ['paste', 'table', 'sync'],
];

export async function br05(N) {
  const rec = new Recorder('BR-05', '兩人同一位置同時建立表格、巢狀清單、貼上多區塊（含同步前、離線、同時改同一區塊類型）：兩邊與資料庫一致、兩人內容都在且不重複、只有一個頂層骨架');
  const env = await bootEnv({ users: 2 });
  const S = await twoBrowsers(env);
  const { UA, A, B } = S;
  const relay = await installRelay(A);
  const lat = [];
  try {
    for (let r = 0; r < N; r++) {
      const fails = [];
      const [ka, kb, how] = MODES[r % MODES.length];
      const m = { a: ka, b: kb, how };
      try {
        await within((async () => {
          const docId = await newPage(UA.agent, `同時結構${r}`);
          const ta = `甲${r}`, tb = `乙${r}`, shared = `共同${r}`;
          if (how === 'unsynced') {
            await Promise.all([A, B].map(P => P.goto(`${env.base}/p/${docId}`)));
            await Promise.all([A, B].map(P => P.locator('.bn-editor[contenteditable="true"]').waitFor({ timeout: 20000 })));
          } else await openBoth(env, A, B, docId);
          if (how === 'offline') {
            relay.goOffline();
            await A.waitForFunction(() => !window.__app.client.ready, null, { timeout: 10000 });
            await makeStructure(A, ka, ta, { enterFirst: false });
            await makeStructure(B, kb, tb, { enterFirst: false });
            await waitSynced(B);
            relay.goOnline();
          } else if (how === 'convert') {
            await A.evaluate(t => { const e = window.__app.editor; e.updateBlock(e.document[0], { content: t }); }, shared);
            await Promise.all([waitSynced(A), waitSynced(B)]);
            await Promise.all([A, B].map(async P => { await P.locator('.bn-editor').focus(); await P.keyboard.press('Control+Home'); }));
            await Promise.all([A.keyboard.press('Control+Alt+1'), B.keyboard.press('Control+Shift+8')]);
          } else {
            await Promise.all([makeStructure(A, ka, ta, { enterFirst: how !== 'same' }), makeStructure(B, kb, tb, { enterFirst: how !== 'same' })]);
          }
          const c = await converge(A, B, docId, how === 'offline' ? 40000 : 10000);
          if (!c.ok) { fails.push(diverged(c, '同時建立後')); return; }
          lat.push(c.ms);
          const t = allText(c.blocks), fb = flat(c.blocks);
          if (how === 'convert') {
            if (!fb.some(b => b.type === 'heading' && blockText(b).includes(shared))) fails.push('A 改成的標題消失');
            if (!fb.some(b => b.type === 'bulletListItem' && blockText(b).includes(shared))) fails.push('B 改成的項目清單消失');
          } else {
            for (const [k, tok, who] of [[ka, ta, 'A'], [kb, tb, 'B']]) {
              for (const sfx of STRUCT_TOKENS[k]) {
                const n = count(t, tok + sfx);
                if (n === 0) fails.push(`${who} 的${k}內容消失：${tok + sfx}`);
                else if (n > 1) fails.push(`${who} 的${k}內容重複 ${n} 次：${tok + sfx}`);
              }
              if (k === 'table' && !fb.some(b => b.type === 'table' && blockText(b).includes(tok + '格'))) fails.push(`${tok} 的表格不存在`);
              if (k === 'nested' && !fb.some(b => b.type === 'bulletListItem' && blockText(b).includes(tok + '上') && (b.children || []).some(x => blockText(x).includes(tok + '下')))) fails.push(`${tok} 的巢狀清單結構不正確`);
              if (k === 'paste' && !fb.some(b => b.type === 'heading' && blockText(b).includes(tok + '題'))) fails.push(`${tok} 貼上的標題不存在`);
              if (k === 'heading' && !fb.some(b => b.type === 'heading' && blockText(b).includes(tok + '題'))) fails.push(`${tok} 的標題不存在`);
              if (k === 'bullet' && !fb.some(b => b.type === 'bulletListItem' && blockText(b).includes(tok + '項'))) fails.push(`${tok} 的項目清單不存在`);
            }
          }
          for (const [n, P] of [['A', A], ['B', B]]) {
            const tl = await topLevel(P); if (tl !== 1) fails.push(`${n} 的文件有 ${tl} 個頂層骨架`);
            const mc = await P.evaluate(() => window.__app.multiContent().length); if (mc) fails.push(`${n} 仍有 ${mc} 個區塊有多個內容節點`);
          }
          m.text = t.slice(0, 120);
        })(), 120000, 'round');
      } catch (e) { fails.push('exception: ' + e.message); }
      relay.goOnline();
      pageErrors(fails, [['A', A], ['B', B]]);
      rec.add(r, r, fails, m);
    }
  } finally { await S.close(); }
  lat.sort((a, b) => a - b);
  return rec.save({ converge: { p50: lat[Math.floor(lat.length / 2)], max: lat.at(-1) } });
}

// ---------------------------------------------------------------- SEC-04
// 貼上與協作接收含 script、事件屬性、javascript:／data:／vbscript: 連結（含大小寫與空白變體）、SVG、MathML 的內容：
// 貼上、同步到另一端、重新整理、頁面連結區塊都不執行任何程式、不留下可觸發的危險連結，內容不無提示消失。
// （版本預覽路徑在 M2-c 加入本案例與 VER-02。）
const XSS = 'window.__xss=(window.__xss||0)+1';
function payloads(r, livePage) {
  return [
    { html: `<p>腳本${r}<script>${XSS}</script></p>`, keep: [`腳本${r}`] },
    { html: `<p>圖${r}<img src="x" onerror="${XSS}"></p>`, keep: [`圖${r}`, '［圖片］'] },
    { html: `<p><a href="javascript:${XSS}">甲連${r}</a></p>`, keep: [`甲連${r}`] },
    { html: `<p><a href=" JaVa&#x09;ScRiPt:${XSS}">乙連${r}</a></p>`, keep: [`乙連${r}`] },
    { html: `<p><a href="data:text/html,&lt;script&gt;parent.__xss=1&lt;/script&gt;">丙連${r}</a></p>`, keep: [`丙連${r}`] },
    { html: `<p><a href="vbscript:msgbox(1)">丁連${r}</a></p>`, keep: [`丁連${r}`] },
    { html: `<svg onload="${XSS}"><text>向量${r}</text></svg>`, keep: [`向量${r}`] },
    { html: `<math><a xlink:href="javascript:${XSS}">數學${r}</a></math>`, keep: [`數學${r}`] },
    { html: `<iframe srcdoc="&lt;script&gt;parent.__xss=1&lt;/script&gt;"></iframe><p>框${r}</p>`, keep: [`框${r}`] },
    { html: `<div onmouseover="${XSS}">滑過${r}</div>`, keep: [`滑過${r}`], hover: `滑過${r}` },
    { html: `<details open ontoggle="${XSS}"><summary>摘${r}</summary>細${r}</details>`, keep: [`摘${r}`] },
    { html: `<p><a href="https://example.com/ok${r}">安全${r}</a></p>`, keep: [`安全${r}`], safeHref: `https://example.com/ok${r}` },
    { html: `<p><a href="/p/${livePage}">站內${r}</a></p>`, keep: [`站內${r}`], safeHref: `/p/${livePage}` },
    { plain: `[標記${r}](javascript:${XSS}) 與 [好${r}](https://example.com/md${r})\n\n- 清單${r}`, keep: [`標記${r}`, `好${r}`, `清單${r}`], safeHref: `https://example.com/md${r}` },
  ];
}

async function domCheck(P, tag, fails, expect) {
  const d = await P.evaluate(() => {
    const ed = document.querySelector('.bn-editor');
    const els = [...ed.querySelectorAll('*')];
    return {
      xss: window.__xss || 0,
      onAttrs: els.flatMap(e => [...e.attributes].filter(a => /^on/i.test(a.name)).map(a => e.tagName + '.' + a.name)),
      // ProseMirror 在行尾的游標標記（M2-b 起顯示對方游標）旁自動加入 <img class="ProseMirror-separator" alt="">：
      // 沒有 src、不載入也不執行任何東西；只排除這個屬性完全相符的元素（T-M2-07），其他 IMG 仍判失敗
      bad: els.filter(e => ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'svg', 'SVG', 'math', 'MATH', 'IMG', 'VIDEO', 'AUDIO'].includes(e.tagName))
        .filter(e => !(e.tagName === 'IMG' && e.className === 'ProseMirror-separator' && e.getAttribute('alt') === ''
          && [...e.attributes].every(a => ['class', 'alt', 'mark-placeholder'].includes(a.name))))
        .map(e => e.tagName),
      hrefs: els.filter(e => e.hasAttribute('href')).map(e => e.getAttribute('href')),
      xlink: els.filter(e => e.hasAttribute('xlink:href')).length,
      text: ed.innerText,
    };
  });
  if (d.xss) fails.push(`${tag} 執行了程式（${d.xss}）`);
  if (d.onAttrs.length) fails.push(`${tag} 出現事件屬性：${d.onAttrs.slice(0, 3).join('、')}`);
  if (d.bad.length) fails.push(`${tag} 出現可執行或載入的元素：${d.bad.slice(0, 3).join('、')}`);
  if (d.xlink) fails.push(`${tag} 出現 xlink:href`);
  for (const h of d.hrefs) if (h !== '' && !isSafeHref(h)) fails.push(`${tag} 出現危險連結：${h.slice(0, 60)}`);
  for (const s of expect.keep) if (!d.text.includes(s)) fails.push(`${tag} 內容無提示消失：${s}`);
  for (const h of expect.safe) if (!d.hrefs.includes(h)) fails.push(`${tag} 安全連結被移除：${h}`);
}

export async function sec04(N) {
  const rec = new Recorder('SEC-04', '貼上、同步、重新整理、頁面連結都不執行程式、不留下危險連結；安全連結保留、內容不無提示消失');
  const env = await bootEnv({ users: 2 });
  const S = await twoBrowsers(env);
  const { UA, A, B } = S;
  try {
    for (let r = 0; r < N; r++) {
      const fails = [], m = {};
      try {
        await within((async () => {
          const docId = await newPage(UA.agent, `安全${r}`);
          const live = await newPage(UA.agent, `站內目標${r}`);
          await openBoth(env, A, B, docId);
          const P = payloads(r, live);
          // 第一層：貼上清理本身（不依賴後面的防線）
          const layer = await A.evaluate(list => list.filter(x => x.html).map(x => {
            const out = window.__app.sanitizeHTML(x.html);
            const doc = new DOMParser().parseFromString(out, 'text/html');
            const els = [...doc.body.querySelectorAll('*')];
            return {
              on: els.some(e => [...e.attributes].some(a => /^on/i.test(a.name))),
              tags: els.filter(e => /^(SCRIPT|IFRAME|OBJECT|EMBED|SVG|MATH|IMG|STYLE)$/i.test(e.tagName)).length,
              hrefs: els.filter(e => e.hasAttribute('href')).map(e => e.getAttribute('href')),
            };
          }), P);
          layer.forEach((l, i) => {
            if (l.on || l.tags) fails.push(`貼上清理沒有移除危險內容（第 ${i + 1} 種）`);
            for (const h of l.hrefs) if (!isSafeHref(h)) fails.push(`貼上清理保留了危險連結（第 ${i + 1} 種）：${h.slice(0, 50)}`);
          });
          // 第二層：實際貼上
          for (const p of P) { await freshParagraph(A); await pasteInto(A, p); await sleep(30); }
          // 第三層：另一端（模擬被改過的用戶端）繞過介面直接寫入危險連結、危險網址的檔案區塊、錯誤的頁面連結
          await B.evaluate(({ XSS, r }) => {
            const e = window.__app.editor;
            e.insertBlocks([
              { type: 'paragraph', content: [{ type: 'link', href: 'javascript:' + XSS, content: '對端' + r }] },
              { type: 'file', props: { url: 'javascript:' + XSS, name: '對端檔案' + r } },
              { type: 'pageLink', props: { pageId: 'javascript:' + XSS } },
            ], e.document[e.document.length - 1], 'after');
          }, { XSS, r });
          let c = await converge(A, B, docId);
          if (!c.ok) { fails.push(diverged(c, '貼上後')); return; }
          // 證明危險內容確實進入了文件（故障真的發生），而不是被測試自己擋掉
          const raw = JSON.stringify(c.blocks);
          if (!raw.includes('javascript:window.__xss')) fails.push('對端寫入的危險連結沒有進入文件（測試無效）');
          const expect = { keep: [...P.flatMap(p => p.keep), `對端${r}`], safe: P.filter(p => p.safeHref).map(p => p.safeHref) };
          await domCheck(A, 'A', fails, expect); await domCheck(B, 'B', fails, expect);
          for (const p of P.filter(x => x.hover)) for (const Pg of [A, B]) await Pg.locator('.bn-editor').getByText(p.hover).first().hover().catch(() => {});
          for (const [n, Pg] of [['A', A], ['B', B]]) {
            const fileOk = await Pg.evaluate(() => document.querySelectorAll('.bn-editor .app-unsupported[data-unsupported="file"]').length);
            if (fileOk !== 1) fails.push(`${n} 危險網址的檔案區塊沒有以「尚未支援」顯示`);
            if (await Pg.evaluate(() => window.__xss || 0)) fails.push(`${n} 滑過後執行了程式`);
          }
          await reloadBoth(env, A, B, docId);
          c = await converge(A, B, docId);
          if (!c.ok) { fails.push(diverged(c, '重新整理後')); return; }
          await domCheck(A, 'A 重新整理後', fails, expect); await domCheck(B, 'B 重新整理後', fails, expect);
          m.blocks = flat(c.blocks).length;
        })(), 120000, 'round');
      } catch (e) { fails.push('exception: ' + e.message); }
      pageErrors(fails, [['A', A], ['B', B]]);
      rec.add(r, r, fails, m);
    }
  } finally { await S.close(); }
  return rec.save();
}

