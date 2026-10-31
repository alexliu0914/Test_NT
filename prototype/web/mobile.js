// M0-15 手機測試頁：真正的 BlockNote＋y-prosemirror 綁定（與正式版相同的協作路徑）＋IndexedDB 本機保存
// 沒有協作伺服器（手機連不到測試環境），所以只驗證手機上的編輯、輸入法、音檔與本機保存。
// 檢查結果寫入 Artifact 的 db（供 Claude 讀回）；db 無法使用時只存在這台手機。
import * as Y from 'yjs';
import { BlockNoteEditor } from '@blocknote/core';
import { withCollaboration, yDocToBlocks } from '@blocknote/core/yjs';
import '@blocknote/core/style.css';
import { Awareness } from 'y-protocols/awareness';
import { makeSchema, FRAGMENT } from '../src/blocknote-schema.js';

const $ = id => document.getElementById(id);
const AUDIO_URL = (() => {
  try {
    const b64 = document.getElementById('m015-audio').textContent.trim();
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([u8], { type: 'audio/mpeg' }));
  } catch { return ''; }
})();
const schema = makeSchema(() => AUDIO_URL);

// ---- 每台手機一個測試編號（存在 localStorage；不可用時每次重新產生） ----
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 無法使用 */ } },
};
let runId = ls.get('m015.run');
if (!runId) { runId = 'run-' + new Date().toISOString().slice(0, 10) + '-' + Math.random().toString(36).slice(2, 8); ls.set('m015.run', runId); }
const reloads = Number(ls.get('m015.loads') || 0) + 1;
ls.set('m015.loads', String(reloads));

// 自動紀錄跨頁面重新載入累計（第四輪審核：只記最後一次開啟會讓組字與寫入次數看起來是 0）
const auto = {
  imeCompositions: 0, compositionInputs: 0, plainInputs: 0, domModelMismatch: 0, lastMismatch: '',
  idbWrites: 0, idbErrors: 0, idbAvailable: true, restoredBlocks: 0, restoredLoads: 0, pageLoads: reloads,
};
try {
  const prev = JSON.parse(ls.get('m015.auto') || 'null');
  if (prev) for (const k of ['imeCompositions', 'compositionInputs', 'plainInputs', 'domModelMismatch', 'idbWrites', 'idbErrors', 'restoredLoads']) auto[k] = Number(prev[k]) || 0;
  if (prev && prev.lastMismatch) auto.lastMismatch = prev.lastMismatch;
} catch { /* 忽略 */ }
const saveAuto = () => ls.set('m015.auto', JSON.stringify(auto));

// ---- IndexedDB：保存 Y.Doc 的更新；交易完成（durability strict）才算「已存本機」 ----
const DBN = 'm015', ST = 'doc', KEY = 'main';
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DBN, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
let idb = null;
try { idb = await idbOpen(); } catch { auto.idbAvailable = false; }
const idbGet = () => new Promise((res, rej) => {
  const q = idb.transaction(ST, 'readonly').objectStore(ST).get(KEY);
  q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error);
});
const idbPut = v => new Promise((res, rej) => {
  const tx = idb.transaction(ST, 'readwrite', { durability: 'strict' });
  tx.objectStore(ST).put(v, KEY);
  tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
});

const ydoc = new Y.Doc();
let updates = [];
if (idb) {
  try {
    const saved = await idbGet();
    if (saved && saved.updates) { updates = saved.updates; for (const u of updates) Y.applyUpdate(ydoc, u, 'load'); }
  } catch { auto.idbErrors++; }
}
let version = 0, persisted = 0, saving = false, again = false;
async function flush() {
  if (!idb) return;
  if (saving) { again = true; return; }
  saving = true;
  try {
    do {
      again = false;
      const v = version;
      if (updates.length > 50) updates = [Y.mergeUpdates(updates)];
      await idbPut({ updates: [...updates], at: Date.now() });
      persisted = Math.max(persisted, v);
      auto.idbWrites++;
      saveAuto();
    } while (again);
  } catch { auto.idbErrors++; } finally { saving = false; renderStatus(); }
}
ydoc.on('update', (u, origin) => {
  if (origin === 'load') return;
  updates.push(u);
  version++;
  renderStatus();
  flush();
});

function saveState() {
  if (!idb) return 'nostore';
  if (auto.idbErrors && persisted < version && !saving) return 'error';
  return persisted >= version ? 'saved' : 'unsaved';
}
const STATUS_TEXT = { saved: '已存本機', unsaved: '寫入中…', error: '本機儲存失敗', nostore: '這個環境無法使用 IndexedDB' };
function renderStatus() {
  const s = saveState();
  const el = $('save');
  el.textContent = STATUS_TEXT[s];
  el.dataset.state = s;
}

// ---- 編輯器 ----
const converter = BlockNoteEditor.create({ schema });
const editor = BlockNoteEditor.create(withCollaboration({
  schema,
  collaboration: { fragment: ydoc.getXmlFragment(FRAGMENT), user: { name: '手機', color: '#2f6f8f' }, provider: { awareness: new Awareness(ydoc) } },
}));
// 掛載方式由入口決定：mobile-core.js 用核心的 editor.mount；mobile-mantine.js 用正式 UI（斜線選單、格式工具列、拖曳把手）
await globalThis.__m015Mount(editor, $('editor'));

const fragEmpty = ydoc.getXmlFragment(FRAGMENT).length === 0;
if (fragEmpty) {
  editor.replaceBlocks(editor.document, [
    { type: 'heading', props: { level: 2 }, content: '手機輸入測試' },
    { type: 'paragraph', content: '這段文字可以隨意修改。請在下面的空白段落用中文輸入法打字。' },
    { type: 'paragraph', content: '' },
    { type: 'checkListItem', content: '勾選這個項目試試看' },
    { type: 'appAudio', props: { fileId: 'm015-tone', speed: 1 } },
    { type: 'paragraph', content: '音檔共 60 秒：每秒一聲嗶，每 10 秒是較高的音。' },
  ]);
} else {
  auto.restoredBlocks = editor.document.length;
  auto.restoredLoads++;
  saveAuto();
}

// ---- 自動檢查：輸入法結束後，畫面上的文字必須等於編輯器模型（Y.Doc）裡的文字 ----
function modelText() {
  const out = [];
  const walk = bs => { for (const b of bs) { if (Array.isArray(b.content)) out.push(b.content.map(c => c.text || '').join('')); if (b.children) walk(b.children); } };
  walk(yDocToBlocks(converter, ydoc, FRAGMENT));
  return out.join('\n');
}
function domText() {
  return [...$('editor').querySelectorAll('.bn-inline-content')].map(n => n.textContent).join('\n');
}
function checkConsistency() {
  const a = domText().replace(/​/g, ''), b = modelText();
  if (a !== b) { auto.domModelMismatch++; auto.lastMismatch = JSON.stringify({ dom: a.slice(-80), model: b.slice(-80) }); saveAuto(); }
  renderAuto();
}
$('editor').addEventListener('compositionend', () => { auto.imeCompositions++; saveAuto(); setTimeout(checkConsistency, 400); });
// 有些輸入法（例如部分 Android 輸入法）不送 composition 事件，直接以 insertText 提交：兩種路徑都記錄
$('editor').addEventListener('input', e => {
  if (e.inputType === 'insertCompositionText') auto.compositionInputs++;
  else if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') auto.plainInputs++;
  saveAuto();
});
$('editor').addEventListener('input', () => { clearTimeout(checkConsistency.t); checkConsistency.t = setTimeout(checkConsistency, 1500); });

// ---- 檢查項目 ----
const ITEMS = [
  ['ime', '中文輸入法', '在空白段落打一句含選字、標點與數字的句子，例如「明天下午3點在會議室，討論第2季預算。」', '字沒有重複、遺漏或跑到別的位置。'],
  ['mid', '句中插入與刪除', '把游標移到句子中間，插入幾個字再用退格刪掉，包含中英混排（例如「iPhone 測試」）。', '插入與刪除的位置正確。'],
  ['select', '選取與格式', '長按選取一個詞，拖動選取把手擴大範圍，從跳出的工具列套用粗體。', '選取範圍正確，粗體套用在選取的文字上。'],
  ['slash', '斜線選單', '在新的一行輸入「/」，從選單選「標題 2」或「項目清單」。', '選單出現、可捲動、選取後段落類型改變。'],
  ['drag', '區塊排序', '用段落左側的把手拖動一個段落，換到別的位置。', '可以拖動，順序正確。找不到把手也請記錄。'],
  ['audio', '音檔播放', '播放音檔，拖動進度條跳到約 30 秒，再把速度改成 1.5×。', '跳轉後從約 30 秒開始，1.5× 時嗶聲明顯變快且沒有中斷。'],
  ['kbd', '鍵盤遮擋', '捲到文件最後一段並開始輸入。', '游標所在的那一行沒有被鍵盤擋住。'],
  ['bg', '切換 App', '打幾個字後立刻切到別的 App，幾秒後再回來。', '剛打的字還在，可以繼續輸入。'],
  ['reload', '重新整理後還在', '打一句新的句子，等左上角顯示「已存本機」，然後重新整理頁面（或關閉後重新開啟）。', '重新開啟後那一句還在。'],
];
const RESULTS = { pass: '通過', issue: '有問題', skip: '略過' };
let state = { items: {}, device: '', ime: '', startedAt: new Date().toISOString() };
try { const s = JSON.parse(ls.get('m015.state') || 'null'); if (s && s.items) state = s; } catch { /* 忽略 */ }

function renderItems() {
  const list = $('items');
  list.textContent = '';
  for (const [id, title, how, expect] of ITEMS) {
    const it = state.items[id] || {};
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.result = it.r || '';
    li.innerHTML = `<div class="item-head"><h3></h3><span class="pill"></span></div><p class="how"></p><p class="expect"><span>預期</span> </p>
      <div class="seg" role="group"></div><label class="note-l" for="note-${id}">備註</label><textarea id="note-${id}" rows="2" placeholder="哪裡不對、出現在什麼情況"></textarea>`;
    li.querySelector('h3').textContent = title;
    li.querySelector('.pill').textContent = it.r ? RESULTS[it.r] : '未測';
    li.querySelector('.how').textContent = how;
    li.querySelector('.expect').append(expect);
    const seg = li.querySelector('.seg');
    seg.setAttribute('aria-label', title + ' 結果');
    for (const [r, label] of Object.entries(RESULTS)) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.dataset.r = r;
      b.setAttribute('aria-pressed', String(it.r === r));
      b.addEventListener('click', () => { setItem(id, { r: it.r === r ? '' : r }); });
      seg.appendChild(b);
    }
    const ta = li.querySelector('textarea');
    ta.value = it.note || '';
    ta.addEventListener('input', () => setItem(id, { note: ta.value }, false));
    list.appendChild(li);
  }
  renderProgress();
}
function setItem(id, patch, rerender = true) {
  state.items[id] = { ...(state.items[id] || {}), ...patch, at: new Date().toISOString() };
  ls.set('m015.state', JSON.stringify(state));
  if (rerender) renderItems(); else renderProgress();
  queueSync();
}
function renderProgress() {
  const done = ITEMS.filter(([id]) => (state.items[id] || {}).r).length;
  const issues = ITEMS.filter(([id]) => (state.items[id] || {}).r === 'issue').length;
  $('progress').textContent = `${done} / ${ITEMS.length} 項已測${issues ? `，${issues} 項有問題` : ''}`;
}

function guessDevice() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iOS ' + ((ua.match(/OS (\d+[_\d]*)/) || [])[1] || '').replace(/_/g, '.')
    : /Android/.test(ua) ? 'Android ' + ((ua.match(/Android ([\d.]+)/) || [])[1] || '') : '';
  const br = /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return [os, br].filter(Boolean).join(' · ');
}
if (!state.device) state.device = guessDevice();   // 沒手動修改也會送出推測值
$('device').value = state.device;
$('ime').value = state.ime || '';
$('device').addEventListener('input', () => { state.device = $('device').value; ls.set('m015.state', JSON.stringify(state)); queueSync(); });
$('ime').addEventListener('input', () => { state.ime = $('ime').value; ls.set('m015.state', JSON.stringify(state)); queueSync(); });

function renderAuto() {
  const rows = [
    ['輸入法組字完成（累計）', auto.imeCompositions],
    ['組字輸入／直接輸入（累計）', `${auto.compositionInputs} / ${auto.plainInputs}`],
    ['畫面與模型不一致', auto.domModelMismatch, auto.domModelMismatch ? 'bad' : 'ok'],
    ['本機寫入次數（累計）', auto.idbWrites],
    ['本機寫入失敗', auto.idbErrors, auto.idbErrors ? 'bad' : 'ok'],
    ['重新開啟時還原的段落', `${auto.restoredBlocks}（共 ${auto.restoredLoads} 次）`],
    ['這台手機開啟次數', auto.pageLoads],
  ];
  const dl = $('auto');
  dl.textContent = '';
  for (const [k, v, cls] of rows) {
    const d = document.createElement('div');
    d.className = 'kv' + (cls ? ' ' + cls : '');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    d.append(dt, dd); dl.appendChild(d);
  }
}

// ---- 結果同步到 Artifact 的 db ----
let db = null, syncTimer = null;
function payload(includeDoc) {
  const p = {
    runId, device: state.device, ime: state.ime, ua: navigator.userAgent,
    viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`, startedAt: state.startedAt,
    updatedAt: new Date().toISOString(), items: state.items, auto: { ...auto },
  };
  if (includeDoc) p.doc = JSON.stringify(yDocToBlocks(converter, ydoc, FRAGMENT)).slice(0, 60000);
  return p;
}
function queueSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(false), 1200); }
async function sync(includeDoc) {
  const el = $('sync');
  if (!db) { el.textContent = '結果只存在這台手機（無法連到結果儲存）。完成後請截圖傳給我。'; el.dataset.state = 'local'; return false; }
  try {
    await db.doc('runs/' + runId).set(payload(includeDoc));
    el.textContent = (includeDoc ? '已送出完整結果 ' : '已自動同步 ') + new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    el.dataset.state = 'ok';
    return true;
  } catch (e) {
    el.textContent = '同步失敗：' + (e && (e.code || e.message) || e) + '。結果仍保留在這台手機，稍後再按一次送出。';
    el.dataset.state = 'bad';
    return false;
  }
}
$('send').addEventListener('click', async () => { checkConsistency(); await sync(true); });

renderStatus();
renderItems();
renderAuto();
$('runid').textContent = runId;
setInterval(renderStatus, 500);

(async () => {
  try { db = window.claude ? await window.claude.use('db') : null; } catch { db = null; }
  if (db) {
    try {
      const snap = await db.doc('runs/' + runId).get();
      const remote = snap && snap.exists ? snap.data() : null;
      if (remote && remote.items && !Object.keys(state.items).length) { state.items = structuredClone(remote.items); state.device ||= remote.device || ''; state.ime ||= remote.ime || ''; renderItems(); }
    } catch { /* 首次 */ }
  }
  sync(false);
})();
