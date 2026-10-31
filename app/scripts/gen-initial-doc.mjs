// 產生 shared/initial-doc.js：新頁面的文件骨架（一個空段落），以固定的 Yjs clientID 編碼成常數。
// 為什麼（F-M1-05）：新頁面的協作文件原本是空的，第一次輸入時才由 y-prosemirror 建立骨架；
// 兩人同時開始輸入時各自建立一個骨架，合併後有兩個頂層 blockGroup，編輯器只能顯示其中一個，
// 下一次輸入就把另一個人的內容覆蓋掉。改為所有地方都套用同一個常數：結構 ID 完全相同，套用幾次都只有一份。
// 用法：node scripts/gen-initial-doc.mjs（升級 BlockNote 或 Yjs 後重新產生並執行 BR-04）
import { writeFileSync } from 'node:fs';
import * as Y from 'yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { makeSchema, FRAGMENT } from '../shared/blocknote-schema.js';

export const SKELETON_CLIENT_ID = 1;

const doc = new Y.Doc();
doc.clientID = SKELETON_CLIENT_ID;
const editor = ServerBlockNoteEditor.create({ schema: makeSchema(() => '') });
editor.blocksToYXmlFragment([{ id: 'initial-block', type: 'paragraph', props: {}, content: [], children: [] }], doc.getXmlFragment(FRAGMENT));
const update = Y.encodeStateAsUpdate(doc);
const b64 = Buffer.from(update).toString('base64');

// 自我檢查：解碼後是一個頂層 blockGroup、只用固定的 clientID、轉回區塊是一個空段落
const check = new Y.Doc();
Y.applyUpdate(check, update);
const frag = check.getXmlFragment(FRAGMENT);
const clients = [...Y.decodeStateVector(Y.encodeStateVector(check)).keys()];
const blocks = editor.yXmlFragmentToBlocks(frag);
if (frag.length !== 1 || clients.length !== 1 || clients[0] !== SKELETON_CLIENT_ID || blocks.length !== 1 || blocks[0].type !== 'paragraph') {
  throw new Error('骨架檢查失敗 ' + JSON.stringify({ len: frag.length, clients, blocks }));
}

writeFileSync(new URL('../shared/initial-doc.js', import.meta.url), `// 由 scripts/gen-initial-doc.mjs 產生，請勿手動修改（F-M1-05）
// 新頁面的文件骨架：一個空段落，Yjs clientID 固定為 ${SKELETON_CLIENT_ID}。伺服器建立頁面時寫入；
// 編輯器開啟時若文件仍是空的也先套用。所有地方的結構 ID 相同，所以重複套用不會產生第二份骨架。
export const SKELETON_CLIENT_ID = ${SKELETON_CLIENT_ID};
export const INITIAL_DOC_B64 = '${b64}';
export function initialDocUpdate() {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(INITIAL_DOC_B64, 'base64'));
  const s = atob(INITIAL_DOC_B64); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
`);
console.log('initial doc', update.length, 'bytes');
