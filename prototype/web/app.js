// M0-B 瀏覽器測試頁：真正的 BlockNote 編輯器＋原型協作用戶端＋IndexedDB 草稿
// 網址參數：doc、token、user、ws（選填）
import { BlockNoteEditor } from '@blocknote/core';
import { withCollaboration, yDocToBlocks } from '@blocknote/core/yjs';
import '@blocknote/core/style.css';
import { Awareness } from 'y-protocols/awareness';
import { Client } from '../src/client.js';
import { schema, FRAGMENT } from '../src/blocknote-schema.js';
import { IdbStore } from './idb-store.js';

const q = new URLSearchParams(location.search);
const docId = q.get('doc');
const token = q.get('token');
const user = q.get('user') || 'anon';
const wsUrl = q.get('ws') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

const statusEl = document.getElementById('status');
const bannerEl = document.getElementById('banner');
const LABEL = {
  saved: '已儲存', saving: '儲存中（已存本機）', failed: '儲存失敗（已存本機）', unsaved: '尚未存到本機',
  readonly: '處理衝突中（唯讀）', blocked: '此裝置有其他帳號的草稿', error: '錯誤：無法儲存', revoked: '登入已失效（未同步內容保留在此裝置）',
};

// 不掛載的轉換用編輯器：把 Y.Doc 轉成區塊 JSON（衝突副本、下載草稿用；被封鎖、尚未建立正式編輯器時也能用）
const converter = BlockNoteEditor.create({ schema });
const describeDoc = ydoc => JSON.stringify(yDocToBlocks(converter, ydoc, FRAGMENT));

// 這台裝置上有其他帳號未同步的草稿（任何文件）：先下載或捨棄，才能開始編輯
const foreign = await IdbStore.otherUserDrafts(user);
const store = new IdbStore('doc:' + docId);
const storage = (await store.load()) || {};
let editor = null;
let editorUnbound = false;
const client = new Client({ url: wsUrl, docId, token, userId: user, name: user, storage, persist: store, describe: describeDoc });
const deviceBlocked = foreign.length > 0 || !!client.blocked;

function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = name;
  a.click();
}

// 其他帳號的草稿：可下載（區塊 JSON＋原始更新）或確認後捨棄
function foreignDrafts() {
  return foreign.map(({ key, value }) => {
    const c = new Client({ url: wsUrl, docId: key.slice(4), token: '', userId: value.userId, storage: structuredClone(value), describe: describeDoc });
    return { key, ...c.downloadUnsynced() };
  });
}
async function discardForeign() {
  await IdbStore.deleteKeys(foreign.map(f => f.key));
  if (client.blocked) await client.discardAndLogout({ confirm: true });
}

if (deviceBlocked) {
  bannerEl.textContent = '此裝置有其他帳號尚未同步的草稿，請先下載或捨棄。';
  const dl = document.createElement('button');
  dl.textContent = '下載草稿';
  dl.onclick = () => download('drafts.json', foreignDrafts());
  const del = document.createElement('button');
  del.textContent = '捨棄並繼續';
  del.onclick = async () => { if (confirm('確定捨棄其他帳號未同步的草稿？')) { await discardForeign(); location.reload(); } };
  bannerEl.append(' ', dl, ' ', del);
} else {
  // BlockNote 0.56 起，協作需經 withCollaboration() 包裝選項（核心不再直接讀 collaboration）
  editor = BlockNoteEditor.create(withCollaboration({
    schema,
    collaboration: {
      fragment: client.ydoc.getXmlFragment(FRAGMENT),
      user: { name: user, color: user === 'A' ? '#2563eb' : '#db2777' },
      provider: { awareness: new Awareness(client.ydoc) },
    },
  }));
  editor.mount(document.getElementById('editor'));
  // 防呆（F-05）：確認編輯器真的綁定到協作文件；沒有綁定時，編輯不會進入 ydoc，狀態卻會一直顯示「已儲存」
  editorUnbound = !editor.prosemirrorState.plugins.some(p => typeof p.key === 'string' && p.key.startsWith('y-sync$'));
  if (editorUnbound) { editor.isEditable = false; bannerEl.textContent = '編輯器未連接到協作文件，無法儲存。'; }
  // 還原時連同編輯器自己的 Undo 堆疊一起清空
  for (const p of editor.prosemirrorState.plugins) {
    const st = p.getState(editor.prosemirrorState);
    if (st && st.undoManager) client.registerUndoManager(st.undoManager);
  }
  client.on('conflict_copy_sent', c => { if (c.kind === 'offline') editor.isEditable = false; });
  // 離線衝突處理完成：本機版本已存為衝突副本並清除，等本機寫入完成後重新載入
  client.on('offline_conflict_resolved', async () => {
    const until = Date.now() + 5000;
    while (!client.localPersisted() && Date.now() < until) await new Promise(r => setTimeout(r, 20));
    location.reload();
  });
  // 登入被撤銷：停止編輯，未同步內容保留在本機，重新登入（同一帳號）後補送
  client.on('revoked', () => { editor.isEditable = false; bannerEl.textContent = '登入已被撤銷，尚未同步的內容保留在此裝置，請重新登入。'; });
  for (const ev of ['conflict_copy_sent', 'restored', 'offline_conflict_resolved', 'revoked', 'busy'])
    client.on(ev, m => window.__m0.events.push({ ev, kind: m && m.kind, at: Date.now() }));
  client.connect();
}

function status() {
  if (deviceBlocked) return 'blocked';
  if (editorUnbound) return 'error';
  if (client.revoked) return 'revoked';
  if (client.isReadOnly()) return 'readonly';
  return client.saveStatus();
}
setInterval(() => { const s = status(); statusEl.textContent = LABEL[s] || s; statusEl.dataset.state = s; }, 50);

// 修改還沒寫進本機就要離開頁面：請瀏覽器跳出確認
addEventListener('beforeunload', e => { if (!deviceBlocked && client.saveStatus() === 'unsaved') e.preventDefault(); });

const textOf = bs => bs.map(b => (Array.isArray(b.content) ? b.content.map(c => c.text || '').join('') : '')).join('\n');

// 測試用介面
window.__m0 = {
  client, store, status,
  blocks: () => (editor ? editor.document : null),
  text: () => (editor ? textOf(editor.document) : ''),
  persisted: () => client.localPersisted(),
  idbWrites: () => store.writes,
  editor: () => editor,
  insertAudio: fileId => editor.insertBlocks([{ type: 'appAudio', props: { fileId, speed: 1 } }], editor.document[editor.document.length - 1], 'after'),
  restore: versionId => client.restore(versionId),
  // 送出還原並等待伺服器回覆結果
  restoreAndWait: versionId => new Promise(res => {
    const id = client.restore(versionId);
    const h = m => { if (m.restoreId === id) { client.off('restore_result', h); res(m); } };
    client.on('restore_result', h);
  }),
  events: [],
  // 已登記的編輯器 Undo 管理器數量與其堆疊深度（驗證還原時確實清空）
  undoInfo: () => ({ managers: client.extraUndoManagers.size, depth: [...client.extraUndoManagers].reduce((n, um) => n + um.undoStack.length + um.redoStack.length, 0) }),
  makeVersion: versionId => client.makeVersion(versionId),
  logout: opts => client.logout(opts),
  download: () => client.downloadUnsynced(),
  foreignDrafts,
  discardForeign,
};
document.body.dataset.ready = '1';
