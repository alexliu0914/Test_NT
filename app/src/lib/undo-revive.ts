// F-M2-12：開發模式（React StrictMode）下復原（Undo）／重做（Redo）完全沒有作用。
//
// 原因：StrictMode 在開發模式會把元件先掛上、卸下、再掛上一次。卸下時 y-prosemirror 復原外掛的 view destroy()
// 呼叫 undoManager.destroy()：UndoManager 停止監聽文件（afterTransaction）、把自己移出 trackedOrigins。
// 重新掛上時外掛沿用同一個 UndoManager（存在編輯器狀態裡），不會重新開始監聽，之後的編輯都不會進入復原紀錄。
// 正式模式沒有重複掛載，不受影響。
//
// 做法：編輯器掛載完成後，確保編輯器使用的 UndoManager 正在監聽文件。Yjs 的監聽清單是集合（Set），
// 重複加入不會重複監聽，所以正式模式（本來就在監聽）呼叫也不會改變行為。
// UndoManager 自己的事件（stack-item-added 等）在重新掛上時由外掛的 view() 重新註冊，不需要處理。
import type { BlockNoteEditor } from '@blocknote/core';

type UndoManagerLike = {
  doc: { on(ev: string, f: unknown): void };
  trackedOrigins: Set<unknown>;
  afterTransactionHandler: unknown;
  destroy: unknown;
};

export function reviveUndoManager(editor: BlockNoteEditor<any, any, any>): boolean {
  const st = editor.prosemirrorState;
  const upl = st.plugins.find(p => (p as unknown as { key: string }).key === 'y-undo$');
  const um = upl && (upl.getState(st) as { undoManager?: UndoManagerLike } | undefined)?.undoManager;
  if (!um || typeof um.afterTransactionHandler !== 'function') return false;
  um.trackedOrigins.add(um);
  um.doc.on('afterTransaction', um.afterTransactionHandler);
  um.doc.on('destroy', um.destroy);
  return true;
}
