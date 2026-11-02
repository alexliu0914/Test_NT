// F-M2-10：復原（Undo）／重做（Redo）「只改了區塊類型」的那一步時，只把類型改回去，不撤銷其他人之後的文字修改。
//
// 問題：協作繫結改區塊類型時，是刪除原本的內容節點、建立新的內容節點並複製文字。Yjs 的復原會刪除新節點
// （連同別人之後在裡面打的字），再恢復舊節點當時的內容：別人的字從兩端與資料庫消失，重做後才回來；
// 復原後如果繼續編輯（重做紀錄被清除），那些字就只剩版本紀錄裡有。
//
// 做法（只處理能明確辨識的情況，其他復原／重做完全照原本）：
// 1. 辨識：本機的編輯交易套用前，比對前後每個區塊的類型與文字。類型改變、而且文字不變（純改類型），或只少了開頭的
//    幾個字（Markdown 快捷輸入，例如「- 」「# 」）時，記下區塊 ID、原本的類型與屬性、被拿掉的開頭文字。
//    這一步的前後都停止合併復原紀錄（stopCapturing），所以改類型一定是單獨的一筆復原紀錄，不會和打字混在一起。
// 2. 復原：最上面的復原紀錄是記下的改類型時，不用 Yjs 的復原，改成把區塊類型改回原本的類型（保留目前的文字，
//    包含別人之後打的字），並把拿掉的開頭文字放回去；這個操作不寫入復原紀錄，原本那筆紀錄移到本模組的重做清單。
// 3. 重做：本模組的重做清單在最上面時，把類型改回復原前的類型（拿掉同樣的開頭文字），紀錄放回復原清單。
//    有新的編輯寫入復原紀錄時，Yjs 會清除重做紀錄，本模組的重做清單也一起清除。
//    沒有可重做的時候按 Ctrl+Shift+Z 不再變成復原（原本鍵盤對應在重做失敗時會退回 Ctrl+Z）。
import type { BlockNoteEditor } from '@blocknote/core';

type Change = { id: string; from: { type: string; props: Record<string, unknown> }; prefix: string; to?: { type: string; props: Record<string, unknown> } };
type StackItem = { meta: Map<string, unknown> };
type UndoManager = {
  undoStack: StackItem[]; redoStack: StackItem[]; undoing: boolean; redoing: boolean;
  stopCapturing(): void;
  on(ev: string, f: (e: { stackItem: StackItem; type: string }) => void): void;
  off(ev: string, f: (e: { stackItem: StackItem; type: string }) => void): void;
};
const META = 'f-m2-10-type-change';

// 區塊 ID → [內容節點類型, 文字]
type PMNode = { descendants(f: (n: PMNode) => boolean): void; type: { name: string }; attrs: Record<string, unknown>; firstChild: PMNode | null; textContent: string };
function blockTypes(doc: PMNode) {
  const out = new Map<string, [string, string]>();
  doc.descendants(n => {
    if (n.type.name === 'blockContainer') {
      const c = n.firstChild;
      if (c) out.set(n.attrs.id as string, [c.type.name, c.textContent]);
    }
    return true;
  });
  return out;
}

export function installTypeUndo(editor: BlockNoteEditor<any, any, any>): () => void {
  const st = editor.prosemirrorState;
  const upl = st.plugins.find(p => (p as unknown as { key: string }).key === 'y-undo$');
  const um = upl && (upl.getState(st) as { undoManager?: UndoManager } | undefined)?.undoManager;
  if (!um) return () => {};
  let pending: Change[] | null = null;
  let custom = false;
  const redoList: { item: StackItem; changes: Change[]; redoLen: number }[] = [];

  // 1. 辨識改類型（只看本機的編輯，不看套用遠端修改的交易）
  // 包裝編輯器的 dispatch（不另外註冊外掛：重新設定外掛會重建協作復原外掛的檢視並停用原本的復原管理器）
  const view = editor.prosemirrorView as unknown as { dispatch: (tr: any) => void; state: any };
  const origDispatch = view.dispatch;
  view.dispatch = (tr: any) => {
    try { detect(tr, view.state); } catch { /* 辨識失敗時照原本的復原 */ }
    origDispatch.call(view, tr);
  };
  function detect(tr: any, state: any) {
    if (custom || !tr.docChanged || tr.getMeta('y-sync$') || tr.getMeta('addToHistory') === false) return;
    // 只有結構變動（插入節點或 ReplaceAround）時才比對，打字不需要
    const structural = tr.steps.some((s: { toJSON(): unknown }) => {
      const j = s.toJSON() as { stepType: string; slice?: { content?: { type: string }[] } };
      return j.stepType === 'replaceAround' || (j.slice && j.slice.content && j.slice.content.some(n => n.type !== 'text'));
    });
    if (!structural) return;
    const before = blockTypes(state.doc), after = blockTypes(tr.doc);
    const changes: Change[] = [];
    for (const [id, [t0, s0]] of before) {
      const a = after.get(id);
      if (!a || a[0] === t0) continue;
      const [, s1] = a;
      if (s0 !== s1 && !s0.endsWith(s1)) return; // 類型與文字一起改（不是純改類型）：照原本的復原
      const b = editor.getBlock(id);
      if (!b) return;
      changes.push({ id, from: { type: b.type as string, props: { ...(b.props as Record<string, unknown>) } }, prefix: s0.slice(0, s0.length - s1.length) });
    }
    if (changes.length) {
      um!.stopCapturing();
      pending = changes;
      queueMicrotask(() => { pending = null; });
    }
  }

  const onAdded = (e: { stackItem: StackItem; type: string }) => {
    if (custom || e.type !== 'undo' || um.undoing || um.redoing) return;
    if (pending) { e.stackItem.meta.set(META, pending); pending = null; um.stopCapturing(); }
    // 新的編輯寫入復原紀錄：Yjs 清除重做紀錄，本模組的重做清單也清除
    redoList.length = 0;
  };
  um.on('stack-item-added', onAdded);
  // 版本還原等情況清空復原紀錄（M1：還原後清空 Undo）：本模組的重做清單也清空
  const onCleared = () => { redoList.length = 0; };
  um.on('stack-cleared', onCleared as never);

  const apply = (changes: Change[], dir: 'undo' | 'redo') => {
    editor.transact(tr => {
      tr.setMeta('addToHistory', false);
      for (const c of changes) {
        const cur = editor.getBlock(c.id);
        if (!cur) continue;
        if (dir === 'undo') {
          c.to = { type: cur.type as string, props: { ...(cur.props as Record<string, unknown>) } };
          editor.updateBlock(c.id, { type: c.from.type, props: c.from.props } as never);
          if (c.prefix) { editor.setTextCursorPosition(c.id, 'start'); editor.insertInlineContent(c.prefix); }
        } else if (c.to) {
          if (c.prefix) {
            const now = editor.getBlock(c.id);
            const text = Array.isArray(now?.content) ? (now!.content as { text?: string }[]).map(x => x.text || '').join('') : '';
            if (text.startsWith(c.prefix)) {
              const content = (now!.content as { type: string; text?: string }[]).slice();
              let drop = c.prefix.length;
              while (drop > 0 && content.length) {
                const first = content[0];
                if (first.type !== 'text' || typeof first.text !== 'string') break;
                if (first.text.length <= drop) { drop -= first.text.length; content.shift(); } else { content[0] = { ...first, text: first.text.slice(drop) }; drop = 0; }
              }
              editor.updateBlock(c.id, { type: c.to.type, props: c.to.props, content } as never);
              continue;
            }
          }
          editor.updateBlock(c.id, { type: c.to.type, props: c.to.props } as never);
        }
      }
    });
  };

  const ed = editor as unknown as { undo: () => boolean; redo: () => boolean };
  const origUndo = ed.undo.bind(editor);
  const origRedo = ed.redo.bind(editor);
  // 2. 復原
  ed.undo = () => {
    const top = um.undoStack[um.undoStack.length - 1];
    const changes = top && (top.meta.get(META) as Change[] | undefined);
    if (!changes || !changes.some(c => editor.getBlock(c.id))) return origUndo();
    custom = true;
    try {
      apply(changes, 'undo');
      um.undoStack.pop();
      redoList.push({ item: top, changes, redoLen: um.redoStack.length });
    } finally { custom = false; }
    return true;
  };
  // 3. 重做
  ed.redo = () => {
    const r = redoList[redoList.length - 1];
    // 沒有可重做的時候也回傳 true：否則 Ctrl+Shift+Z 的鍵盤對應會退回 Ctrl+Z，變成「復原」（ProseMirror 鍵盤對應的 Shift 退回規則）
    if (!r || r.redoLen !== um.redoStack.length) { origRedo(); return true; }
    custom = true;
    try {
      apply(r.changes, 'redo');
      redoList.pop();
      um.undoStack.push(r.item);
    } finally { custom = false; }
    return true;
  };
  return () => {
    um.off('stack-item-added', onAdded);
    um.off('stack-cleared', onCleared as never);
    ed.undo = origUndo; ed.redo = origRedo;
    view.dispatch = origDispatch;
  };
}
