// F-M2-09：一人改區塊類型時，另一人同時在該區塊打的字不能消失（協作伺服器使用）。
//
// 問題：協作繫結（y-prosemirror）改區塊類型（段落 → 標題、清單……）時，會刪除原本的內容節點，建立新的內容節點並複製文字。
// 另一個人在收到這個修改之前打的字，會插入到已被刪除的舊節點（或在舊節點被刪除時一起被刪除）：
// 兩端與資料庫都看不到、也不保存，狀態仍顯示「已儲存」。
//
// 修正：由協作伺服器在提交時補救，不依賴改類型的人是否還在線上。
// 1. 套用一筆更新時，偵測「同一個區塊裡明確刪除了內容節點、並在同一筆更新中建立新的內容節點」（改類型）。
//    在文件中記下舊節點 → 新節點的對應，以及改類型的人刪除時看得到的字（用來換算位置）。記錄放在同一份文件的
//    `conversion-rescue` 對應表裡，跟著文件一起提交、壓縮與載入，伺服器重新啟動後仍有效。
// 2. 舊節點裡有「改類型的人不知道」的字（同一批先到而一起被刪除的、或之後才到的），依它在舊節點中的位置
//    補進新節點（新節點之後又被改類型時，跟著對應找到目前的節點）。補過的字記入對應表，同一個字不會補第二次。
// 3. 對應表中的舊節點在伺服器端不做垃圾回收（gcFilter），之後才到的字仍能讀到內容與位置。
// 補救本身是一筆伺服器的更新，與觸發它的更新在同一個資料庫交易中提交，提交後才廣播（M1 先提交後廣播的契約不變）。
import * as Y from 'yjs';

export const RESCUE_MAP = 'conversion-rescue';
export const RESCUE_ORIGIN = 'conversion-rescue';
const CONTAINER = 'blockContainer';
const GROUP = 'blockGroup';

const key = id => `${id.client}:${id.clock}`;
const isContentEl = t => t instanceof Y.XmlElement && t.nodeName !== GROUP && t.nodeName !== CONTAINER;
function firstTextOf(el) {
  for (let it = el._start; it; it = it.right) if (it.content instanceof Y.ContentType && it.content.type instanceof Y.XmlText) return it.content.type;
  return null;
}
const within = (ranges, client, clock, len) => {
  let n = 0;
  for (const [c, k, l] of ranges || []) if (c === client) n += Math.max(0, Math.min(clock + len, k + l) - Math.max(clock, k));
  return n;
};

// 最長共同子序列：回傳 a 的每個字對到 b 的哪個位置（對不上為 -1）。區塊文字過長時退回「全部視為帶過去」
export function lcsMatch(a, b) {
  const n = a.length, m = b.length;
  const out = new Array(n).fill(-1);
  if (!n || !m) return out;
  if (n * m > 4_000_000) { for (let i = 0; i < Math.min(n, m); i++) out[i] = i; return out; }
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { out[i] = j; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

// 伺服器端的文件：建立時就設定好垃圾回收的例外（載入狀態時也要保留對應表中的舊節點）
export function createRescueDoc() {
  const ydoc = new Y.Doc();
  const map = ydoc.getMap(RESCUE_MAP);
  // __keep：這一筆更新中剛偵測到、對應表還沒寫入的舊節點（同一筆更新結束時就會回收）
  ydoc.__keep = new Set();
  ydoc.gcFilter = item => !(item.content instanceof Y.ContentType) || (!map.has(key(item.id)) && !ydoc.__keep.has(key(item.id)));
  return ydoc;
}

// 複製一份伺服器端文件（提交前在複本上計算；提交成功後才取代原本的文件）
export function cloneRescueDoc(ydoc) {
  const d = createRescueDoc();
  Y.applyUpdate(d, Y.encodeStateAsUpdate(ydoc), 'load');
  return d;
}

// 這筆更新是否可能需要處理（改類型，或寫入已記錄的舊節點）；不需要時伺服器照原本流程，不複製文件
export function mayNeedRescue(ydoc, update) {
  let dec;
  try { dec = Y.decodeUpdate(update); } catch { return false; }
  const map = ydoc.getMap(RESCUE_MAP);
  const hasDeletes = dec.ds.clients.size > 0;
  for (const s of dec.structs) {
    if (!(s instanceof Y.Item)) continue;
    if (hasDeletes && s.content instanceof Y.ContentType) return true;
    if (!map.size) continue;
    let parent = null;
    if (s.parent && typeof s.parent === 'object' && 'client' in s.parent) parent = s.parent;
    else {
      const ref = s.origin || s.rightOrigin;
      if (ref) { try { const it = Y.getItem(ydoc.store, ref); const p = it && it.parent; parent = p && p._item ? p._item.id : null; } catch { parent = null; } }
    }
    if (parent && map.has(key(parent))) return true;
  }
  return false;
}

// 套用一筆（將要提交的）更新到 ydoc；回傳補救更新（Uint8Array）或 null
export function applyWithRescue(ydoc, update, origin = 'remote') {
  const map = ydoc.getMap(RESCUE_MAP);
  const keep = ydoc.__keep || new Set();
  const explicit = Y.decodeUpdate(update).ds;
  const entries = new Map(); // 要寫入對應表的項目
  const jobs = [];
  // afterTransaction 在垃圾回收之前呼叫：這時還讀得到被刪除項目的內容與位置
  const scan = t => {
    if (t.origin !== origin) return;
    const fresh = item => item.id.clock >= (t.beforeState.get(item.id.client) || 0) && item.id.clock < (t.afterState.get(item.id.client) || 0);
    const pending = new Map(); // 舊文字節點的編號 → { text, ids: Set }
    const addPending = (text, id) => { const k = key(text._item.id); if (!pending.has(k)) pending.set(k, { text, ids: new Set() }); pending.get(k).ids.add(key(id)); };
    // 1. 改類型
    Y.iterateDeletedStructs(t, t.deleteSet, item => {
      if (!(item instanceof Y.Item) || !(item.content instanceof Y.ContentType)) return;
      const el = item.content.type, parent = item.parent;
      if (!isContentEl(el) || !(parent instanceof Y.XmlElement) || parent.nodeName !== CONTAINER || (parent._item && parent._item.deleted)) return;
      if (!Y.isDeleted(explicit, item.id) || map.has(key(item.id))) return;
      const next = parent.toArray().find(c => isContentEl(c) && fresh(c._item));
      if (!next) return;
      const text = firstTextOf(el);
      const alive = [];
      const entry = { to: key(next._item.id), alive, done: [] };
      entries.set(key(item.id), entry); keep.add(key(item.id));
      if (!text) return;
      entries.set(key(text._item.id), entry); keep.add(key(text._item.id));
      // 舊節點在這筆更新之前看得到的字，與新節點的文字逐字比對（最長共同子序列）：
      // 對得上的是改類型時一起帶過去的字；對不上、而且不是改類型的人自己打的字，就是會遺失的字，補進新節點。
      // 補的是「同一批先到而一起被刪除的字」（改類型的人不知道）；之後才到的字在下面第 2 步處理。
      const chars = [];
      for (let it = text._start; it; it = it.right) {
        if (!(it.content instanceof Y.ContentString) || !Y.isDeleted(t.deleteSet, it.id)) continue;
        const known = Y.isDeleted(explicit, it.id);
        for (let i = 0; i < it.length; i++) chars.push({ client: it.id.client, clock: it.id.clock + i, ch: it.content.str[i], known });
      }
      const nt = next.toArray().find(c => c instanceof Y.XmlText);
      const ns = nt ? nt.toDelta().map(d => (typeof d.insert === 'string' ? d.insert : '')).join('') : '';
      const match = lcsMatch(chars.map(c => c.ch).join(''), ns);
      const author = next._item.id.client;
      const pieces = [], newDone = [];
      let lastN = -1, added = 0, run = null;
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (match[i] >= 0) { alive.push([c.client, c.clock, 1]); lastN = match[i]; run = null; continue; }
        // 改類型的人知道的字（在他的刪除紀錄裡）：是他有意的操作（例如清單快捷鍵的「- 」、選取後貼上取代、復原），不補
        if (c.client === author || c.known) { run = null; continue; }
        newDone.push([c.client, c.clock, 1]);
        if (run && run.end === i) { run.str += c.ch; run.end = i + 1; }
        else { run = { at: lastN + 1 + added, str: c.ch, end: i + 1 }; pieces.push(run); }
        added += 1;
      }
      if (pieces.length) jobs.push({ k: key(text._item.id), entry, pieces: pieces.map(p => ({ at: p.at, str: p.str })), newDone });
    });
    // 2. 寫入已記錄的舊節點（之後才到的字）
    t.afterState.forEach((after, client) => {
      const from = t.beforeState.get(client) || 0;
      if (after <= from) return;
      for (const s of ydoc.store.clients.get(client) || []) {
        if (!(s instanceof Y.Item) || s.id.clock + s.length <= from || s.id.clock >= after) continue;
        const p = s.parent;
        if (!p || !p._item) continue;
        const pk = key(p._item.id);
        if (!map.has(pk) && !entries.has(pk)) continue;
        if (p instanceof Y.XmlText) {
          if (s.content instanceof Y.ContentString && !Y.isDeleted(explicit, s.id)) addPending(p, s.id);
        } else if (s.content instanceof Y.ContentType && s.content.type instanceof Y.XmlText) {
          // 舊節點原本沒有文字（空白行）：別人在裡面建立了文字節點
          const tt = s.content.type, base = entries.get(pk) || map.get(pk);
          entries.set(key(tt._item.id), { to: base.to, alive: [], done: [] }); keep.add(key(tt._item.id));
          for (let it = tt._start; it; it = it.right) if (it.content instanceof Y.ContentString && !Y.isDeleted(explicit, it.id)) addPending(tt, it.id);
        }
      }
    });
    // 3. 換算位置、取出內容（之後的交易中這些項目可能已被回收）
    for (const [k, { text, ids }] of pending) {
      const entry = entries.get(k) || map.get(k);
      if (!entry) continue;
      const done = entry.done || [];
      let pos = 0;
      const pieces = [], newDone = [];
      for (let it = text._start; it; it = it.right) {
        const known = within(entry.alive, it.id.client, it.id.clock, it.length) + within(done, it.id.client, it.id.clock, it.length);
        if (ids.has(key(it.id)) && it.content instanceof Y.ContentString && !known) {
          pieces.push({ at: pos, str: it.content.str });
          newDone.push([it.id.client, it.id.clock, it.length]);
          pos += it.length;
        } else pos += known;
      }
      if (pieces.length) jobs.push({ k, entry, pieces, newDone });
    }
  };
  ydoc.on('afterTransaction', scan);
  try { Y.applyUpdate(ydoc, update, origin); } finally { ydoc.off('afterTransaction', scan); }
  if (!entries.size && !jobs.length) return null;

  // 寫入對應表與補救內容（一筆伺服器更新）
  const chunks = [];
  const onUpdate = (u, o) => { if (o === RESCUE_ORIGIN) chunks.push(u); };
  ydoc.on('update', onUpdate);
  try {
    ydoc.transact(() => {
      for (const [k, e] of entries) map.set(k, e);
      for (const { k, entry, pieces, newDone } of jobs) {
        const target = liveTarget(ydoc, map, entry.to);
        if (target) {
          let t = target.toArray().find(c => c instanceof Y.XmlText);
          if (!t) { t = new Y.XmlText(); target.insert(0, [t]); }
          for (const p of pieces) t.insert(Math.min(p.at, t.length), p.str);
        }
        const cur = map.get(k) || entry;
        map.set(k, { ...cur, done: [...(cur.done || []), ...newDone] });
      }
    }, RESCUE_ORIGIN);
  } finally { ydoc.off('update', onUpdate); keep.clear(); }
  return chunks.length ? Y.mergeUpdates(chunks) : null;
}

// 對應到的新節點之後又被改類型（或刪除）時，沿著對應表找到目前還在的節點
function liveTarget(ydoc, map, to) {
  for (let i = 0; to && i < 20; i++) {
    const [client, clock] = to.split(':').map(Number);
    let item;
    try { item = Y.getItem(ydoc.store, Y.createID(client, clock)); } catch { return null; }
    const el = item && item.content && item.content.type;
    if (!el) return null;
    if (!item.deleted) return el;
    const next = map.get(to);
    to = next && next.to;
  }
  return null;
}
