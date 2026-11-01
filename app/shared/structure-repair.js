// 同一個區塊被兩人同時改類型時的結構修復（F-M2-01）
//
// 問題：BlockNote 的區塊（blockContainer）只能有一個內容節點（段落、標題、表格……）。改區塊類型時，
// y-prosemirror 在同一個 blockContainer 裡刪掉舊的內容節點、插入新的。兩人同時改同一個區塊（例如一人輸入「# 」、
// 另一人輸入「- 」，或兩人同時在新頁面的第一行貼上或插入表格），合併後這個區塊會有兩個內容節點，
// 不符合結構；y-prosemirror 遇到不符合結構的節點時會把整個區塊從 Yjs 文件刪除，兩人的內容與子區塊都消失，
// 而且這個刪除會同步給所有人（狀態仍顯示「已儲存」）。
//
// 修復分三部分：
// 1. tolerateMultiContent：把 Yjs 轉成畫面時，有多個內容節點的區塊只顯示第一個內容節點（畫面仍符合結構），
//    Yjs 文件裡的其他內容節點保留不動，y-prosemirror 不會刪除整個區塊。
// 2. repairByAuthor：多出來的內容節點，由「建立它的那個用戶端」搬到緊接在後面的新區塊，再從原區塊移除。
//    只有作者會搬，所以兩邊同時修復也不會產生兩份；作者通常就是正在輸入的人，搬移與輸入在同一個用戶端依序發生，
//    不會有「修復之後才送到的字」落在已移除的節點裡。
//    作者的判斷：目前的 Yjs clientID，或這台裝置上尚未確認的更新裡出現過的 clientID（離線編輯後重新開啟的情況）。
// 3. 編輯器在等待作者修復時暫停編輯（畫面少了多出來的內容，這時編輯該區塊會讓 y-prosemirror 把它刪掉）；
//    超過等待時間（作者不在線上）才由這一端修復。這兩部分在 Editor.tsx。
import * as Y from 'yjs';

const CONTAINER = 'blockContainer';
const GROUP = 'blockGroup';

// 1. ProseMirror 結構：blockContainer 有多個內容節點時，只用第一個內容節點（與子區塊）建立（只處理這一種情況）
export function tolerateMultiContent(pmSchema) {
  if (pmSchema.__multiContentTolerant) return;
  const original = pmSchema.node;
  pmSchema.node = function (type, attrs, content, marks) {
    try {
      return original.call(this, type, attrs, content, marks);
    } catch (e) {
      const nodeType = typeof type === 'string' ? this.nodes[type] : type;
      const kids = Array.isArray(content) ? content : [];
      const contents = kids.filter(n => n && n.type && n.type.name !== GROUP);
      if (nodeType && nodeType.name === CONTAINER && contents.length > 1) {
        const group = kids.find(n => n && n.type && n.type.name === GROUP);
        return nodeType.createChecked(attrs, group ? [contents[0], group] : [contents[0]], marks);
      }
      throw e;
    }
  };
  pmSchema.__multiContentTolerant = true;
}

// 找出有多個內容節點的區塊
export function findMultiContent(fragment) {
  const out = [];
  const walk = parent => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === CONTAINER) {
        const kids = child.toArray();
        const contents = kids.filter(k => k instanceof Y.XmlElement && k.nodeName !== GROUP);
        if (contents.length > 1) out.push({ container: child, extras: contents.slice(1) });
        for (const k of kids) if (k instanceof Y.XmlElement && k.nodeName === GROUP) walk(k);
      } else walk(child);
    }
  };
  walk(fragment);
  return out;
}

// 深層複製 Yjs XML 節點（尚未整合進文件的 prelim 型別，插入時一起建立）
export function cloneNode(node) {
  if (node instanceof Y.XmlText) {
    const t = new Y.XmlText();
    t.applyDelta(node.toDelta());
    return t;
  }
  const el = new Y.XmlElement(node.nodeName);
  for (const [k, v] of Object.entries(node.getAttributes())) el.setAttribute(k, v);
  el.insert(0, node.toArray().map(cloneNode));
  return el;
}

// 2. 由作者把多出來的內容節點搬到新區塊。回傳搬移的數量。
export function repairByAuthor(ydoc, fragment, isMine, newId, origin = 'structure-repair') {
  const todo = findMultiContent(fragment).flatMap(({ container, extras }) => extras.filter(e => isMine(e._item.id.client)).map(e => [container, e]));
  if (!todo.length) return 0;
  ydoc.transact(() => {
    // 同一個區塊有多個要搬的節點時，依原本順序放在後面
    const after = new Map();
    for (const [container, extra] of todo) {
      const parent = container.parent;
      const ref = after.get(container) || container;
      const at = parent.toArray().indexOf(ref) + 1;
      const block = new Y.XmlElement(CONTAINER);
      block.setAttribute('id', newId());
      block.insert(0, [cloneNode(extra)]);
      parent.insert(at, [block]);
      after.set(container, block);
      container.delete(container.toArray().indexOf(extra), 1);
    }
  }, origin);
  return todo.length;
}

// 這台裝置「自己」的 clientID：目前的，以及尚未確認的更新裡出現過的
export function ownClientIds(ydoc, pendingUpdates) {
  const ids = new Set([ydoc.clientID]);
  for (const u of pendingUpdates) {
    try { for (const s of Y.decodeUpdate(u).structs) ids.add(s.id.client); } catch { /* 無法解碼就略過 */ }
  }
  return ids;
}
