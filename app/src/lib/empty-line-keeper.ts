// F-M2-08：游標所在的空白行被另一個人的貼上換掉時，在原位置補一個空白行給自己。
//
// 對方貼到同一個空白行時（shared/paste-sanitize.js 的 pasteIntoOwnBlock），會在那一行後面插入自己的新區塊，
// 再刪除那個空白行。這一端的游標原本在那個空白行，空白行被刪除後，協作繫結會把游標放到相鄰的區塊
// （通常是對方剛貼上的內容），接著貼上或輸入就會改到對方的區塊。
//
// 只在以下條件全部成立時補建，其他情況完全不介入：
// - 套用的是伺服器送來的更新（來源 'remote'），不是自己的操作
// - 編輯器有焦點、可以編輯、不在輸入法組字中，游標是沒有選取範圍的插入點
// - 游標所在的區塊沒有文字、沒有子區塊，而且在這次更新中被刪除
// - 它原本的位置現在是對方緊接在它後面插入的區塊（「被換掉」，不是單純被刪除）
// 補建的空白行不進入復原紀錄；每次被換掉只補一次，不會連鎖補建。
import type { BlockNoteEditor } from '@blocknote/core';
import type * as Y from 'yjs';

type Anchor = { el: Y.XmlElement; parent: Y.XmlElement | Y.XmlFragment; prev: Y.XmlElement | null; type: string; props: Record<string, unknown> };

function bindingMapping(editor: BlockNoteEditor<any, any, any>): Map<unknown, unknown> | null {
  const st = editor.prosemirrorState;
  const pl = st.plugins.find(p => (p as unknown as { key: string }).key === 'y-sync$');
  const b = pl && (pl.getState(st) as { binding?: { mapping: Map<unknown, unknown> } } | undefined)?.binding;
  return b ? b.mapping : null;
}

function captureAnchor(editor: BlockNoteEditor<any, any, any>): Anchor | null {
  const view = editor.prosemirrorView;
  if (!view || !view.editable || !view.hasFocus() || view.composing) return null;
  const sel = view.state.selection;
  if (!sel.empty || !(sel as unknown as { $cursor?: unknown }).$cursor) return null;
  const $h = sel.$head;
  let node = null;
  for (let d = $h.depth; d > 0; d--) if ($h.node(d).type.name === 'blockContainer') { node = $h.node(d); break; }
  if (!node || node.childCount !== 1 || node.textContent !== '') return null;
  const mapping = bindingMapping(editor);
  if (!mapping) return null;
  let el: Y.XmlElement | null = null;
  for (const [y, pn] of mapping) if (pn === node) { el = y as Y.XmlElement; break; }
  if (!el || !el.parent) return null;
  const parent = el.parent as Y.XmlElement;
  const arr = parent.toArray();
  const i = arr.indexOf(el);
  const block = editor.getBlock(node.attrs.id as string);
  return { el, parent, prev: (i > 0 ? arr[i - 1] : null) as Y.XmlElement | null, type: block?.type || 'paragraph', props: (block?.props || {}) as Record<string, unknown> };
}

function restoreLine(editor: BlockNoteEditor<any, any, any>, a: Anchor) {
  if (!(a.el as unknown as { _item: { deleted: boolean } })._item.deleted) return;
  const view = editor.prosemirrorView;
  if (!view || !view.editable || !view.hasFocus() || view.composing) return;
  if (a.prev && (a.prev as unknown as { _item: { deleted: boolean } })._item.deleted) return;
  const arr = a.parent.toArray();
  const at = a.prev ? arr.indexOf(a.prev) + 1 : 0;
  const next = arr[at] as Y.XmlElement | undefined;
  // 「被換掉」：現在在原位置的區塊，是對方緊接在這個空白行後面插入的（Yjs 的左側來源就是這個空白行）。
  // 單純被刪除（例如對方刪掉這一行）時沒有這樣的區塊，不補建。
  type It = { id: { client: number; clock: number }; origin: { client: number; clock: number } | null };
  const mine = (a.el as unknown as { _item: It })._item.id;
  const origin = next && (next as unknown as { _item?: It })._item?.origin;
  if (!next || typeof next.getAttribute !== 'function' || !origin || origin.client !== mine.client || origin.clock !== mine.clock) return;
  const nextId = next.getAttribute('id') as string | undefined;
  const ref = nextId && editor.getBlock(nextId);
  if (!ref) return;
  editor.transact(tr => {
    tr.setMeta('addToHistory', false);
    const [line] = editor.insertBlocks([{ type: a.type, props: a.props } as never], ref, 'before');
    editor.setTextCursorPosition(line, 'start');
  });
}

// 回傳解除函式
export function keepEmptyLine(editor: BlockNoteEditor<any, any, any>, ydoc: Y.Doc): () => void {
  let anchor: Anchor | null = null;
  const before = (tr: Y.Transaction) => { anchor = tr.origin === 'remote' ? captureAnchor(editor) : null; };
  const after = (tr: Y.Transaction) => {
    if (tr.origin !== 'remote' || !anchor) return;
    const a = anchor; anchor = null;
    // 等協作繫結把這次更新畫到編輯器之後再處理（同一個工作內，使用者的下一個按鍵之前）
    queueMicrotask(() => { try { restoreLine(editor, a); } catch { /* 編輯器已卸載等情況：不處理 */ } });
  };
  ydoc.on('beforeTransaction', before);
  ydoc.on('afterTransaction', after);
  return () => { ydoc.off('beforeTransaction', before); ydoc.off('afterTransaction', after); };
}
