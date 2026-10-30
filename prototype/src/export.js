// 完整匯出與匯回（伺服器端，使用 BlockNote server-util）
// 匯出內容：無損的區塊 JSON（附格式版本號）、Yjs 狀態、以及有損的 Markdown（供閱讀與搬移）
import * as Y from 'yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { schema, FRAGMENT } from './blocknote-schema.js';
import { b64 } from './util.js';

let editor = null;
const ed = () => (editor ||= ServerBlockNoteEditor.create({ schema }));

export function blocksOfState(state) {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, state);
  return ed().yDocToBlocks(ydoc, FRAGMENT);
}

export async function exportPage(pageId, state) {
  const blocks = blocksOfState(state);
  const markdown = await ed().blocksToMarkdownLossy(blocks);
  return { formatVersion: 1, pageId, blocks, markdown, state: b64(state) };
}

// 匯回：由區塊 JSON 重建 Yjs 文件
export function importBlocks(blocks) {
  return Y.encodeStateAsUpdate(ed().blocksToYDoc(blocks, FRAGMENT));
}
