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

// 區塊 JSON 的格式版本（M2 W1）：匯出、匯回、下載未同步內容、搜尋與 AI 共用。
// 讀到不認得的版本時拒絕轉換，避免用錯誤的結構覆寫文件（不做破壞性回寫）。
export const FORMAT_VERSION = 1;
export class FormatVersionError extends Error {}
export function checkFormatVersion(v) {
  if (v !== FORMAT_VERSION) throw new FormatVersionError(`不支援的區塊格式版本：${v}（目前為 ${FORMAT_VERSION}）`);
}

export async function exportPage(pageId, state) {
  const blocks = blocksOfState(state);
  const markdown = await ed().blocksToMarkdownLossy(blocks);
  return { formatVersion: FORMAT_VERSION, pageId, blocks, markdown, state: b64(state) };
}

// 匯回：由區塊 JSON 重建 Yjs 文件；必須帶相同的格式版本
export function importBlocks(exported) {
  checkFormatVersion(exported && exported.formatVersion);
  if (!Array.isArray(exported.blocks)) throw new FormatVersionError('缺少區塊內容');
  return Y.encodeStateAsUpdate(ed().blocksToYDoc(exported.blocks, FRAGMENT));
}
