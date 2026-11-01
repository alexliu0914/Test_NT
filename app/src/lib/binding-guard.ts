// F-M2-09：協作繫結（y-prosemirror）在套用遠端修改、復原或重做時發生例外，就重新完整繪製編輯器。
//
// 原本例外會讓這次修改沒有畫到編輯器上（資料已在 Yjs 文件裡，畫面還是舊的）；下一次任何編輯或游標移動時，
// 繫結會把舊畫面與文件比對後寫回，等於把剛收到的修改刪掉。實際遇到的情況：伺服器把別人的字補進本機游標所在的
// 區塊後，本機按重做（Ctrl+Shift+Z），還原游標位置時算出超出文件範圍的位置（RangeError），重做沒有生效。
// 重新完整繪製只會讓游標移到最近的有效位置，不會改動文件內容。
import type { BlockNoteEditor } from '@blocknote/core';

type Binding = {
  __guarded?: boolean;
  type: { observeDeep(f: unknown): void; unobserveDeep(f: unknown): void };
  _observeFunction: (events: unknown, tr: unknown) => void;
  _typeChanged: (events: unknown, tr: unknown) => void;
  _forceRerender: () => void;
};

export function guardBinding(editor: BlockNoteEditor<any, any, any>, onError?: (e: unknown) => void): boolean {
  const st = editor.prosemirrorState;
  const pl = st.plugins.find(p => (p as unknown as { key: string }).key === 'y-sync$');
  const b = pl && (pl.getState(st) as { binding?: Binding } | undefined)?.binding;
  if (!b || typeof b._typeChanged !== 'function' || typeof b._forceRerender !== 'function') return false;
  if (b.__guarded) return true;
  b.__guarded = true;
  const orig = b._typeChanged.bind(b);
  b.type.unobserveDeep(b._observeFunction);
  b._observeFunction = (events, tr) => {
    try { orig(events, tr); } catch (e) {
      if (onError) onError(e);
      try { b._forceRerender(); } catch { /* 編輯器已卸載 */ }
    }
  };
  b.type.observeDeep(b._observeFunction);
  return true;
}
