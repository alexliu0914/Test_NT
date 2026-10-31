// 文件模型：根節點是 Y.XmlFragment('blocks')，每個區塊是 <p> 元素內含一個 Y.XmlText。
// 測試內容以「標記」(token) 組成，例如 " [A12]"：每個標記全域唯一、整段插入、
// 只插在標記之間的邊界上，因此任何並行操作都不會把標記切斷，可用來精確追蹤內容去向。
import * as Y from 'yjs';

export const ROOT = 'blocks';
const TOKEN_RE = /\[[A-Za-z]+\d+\]/g;

export function fragment(doc) {
  return doc.getXmlFragment(ROOT);
}

function blockText(el) {
  const t = el.get(0);
  return t instanceof Y.XmlText ? t.toString() : '';
}

export function plainBlocks(doc) {
  return fragment(doc).toArray().map(el => blockText(el));
}

export function docJSON(doc) {
  return JSON.stringify(plainBlocks(doc));
}

export function tokensOf(doc) {
  const out = new Set();
  for (const s of plainBlocks(doc)) for (const m of s.matchAll(TOKEN_RE)) out.add(m[0]);
  return out;
}

export function tokensOfPlain(plain) {
  const out = new Set();
  for (const s of plain) for (const m of s.matchAll(TOKEN_RE)) out.add(m[0]);
  return out;
}

function makeBlock(text) {
  const el = new Y.XmlElement('p');
  const t = new Y.XmlText();
  t.insert(0, text);
  el.insert(0, [t]);
  return el;
}

// 在文件中插入一個標記；rnd 為 0..1 的亂數函式。必須在 transact 內呼叫。
export function insertToken(doc, token, rnd, newBlock = false) {
  const frag = fragment(doc);
  const n = frag.length;
  if (newBlock || n === 0 || rnd() < 0.15) {
    frag.insert(Math.floor(rnd() * (n + 1)), [makeBlock(' ' + token)]);
    return;
  }
  const el = frag.get(Math.floor(rnd() * n));
  const t = el.get(0);
  const s = t.toString();
  const bounds = [0];
  for (const m of s.matchAll(TOKEN_RE)) bounds.push(m.index + m[0].length);
  const pos = bounds[Math.floor(rnd() * bounds.length)];
  t.insert(pos, ' ' + token);
}

// 刪除一個既有標記（含前導空白）；回傳被刪除的標記或 null。必須在 transact 內呼叫。
export function deleteRandomToken(doc, rnd) {
  const frag = fragment(doc);
  const cands = [];
  frag.toArray().forEach((el, bi) => {
    const s = blockText(el);
    for (const m of s.matchAll(TOKEN_RE)) {
      const start = m.index > 0 && s[m.index - 1] === ' ' ? m.index - 1 : m.index;
      cands.push({ bi, start, len: m.index + m[0].length - start, token: m[0] });
    }
  });
  if (cands.length === 0) return null;
  const c = cands[Math.floor(rnd() * cands.length)];
  frag.get(c.bi).get(0).delete(c.start, c.len);
  return c.token;
}

// 刪除整個區塊；回傳區塊內的標記陣列。必須在 transact 內呼叫。
export function deleteRandomBlock(doc, rnd) {
  const frag = fragment(doc);
  if (frag.length === 0) return [];
  const i = Math.floor(rnd() * frag.length);
  const toks = [...blockText(frag.get(i)).matchAll(TOKEN_RE)].map(m => m[0]);
  frag.delete(i, 1);
  return toks;
}

// 版本還原用：把整份內容換成指定的區塊陣列（一次刪除＋插入，屬於一般 CRDT 操作）。
export function replaceAll(doc, plain) {
  const frag = fragment(doc);
  if (frag.length > 0) frag.delete(0, frag.length);
  frag.insert(0, plain.map(makeBlock));
}

// 深層複製 Yjs XML 節點（保留元素名稱、屬性、文字與格式），用於把版本內容放回線上文件
function cloneNode(n) {
  if (n instanceof Y.XmlText) {
    const t = new Y.XmlText();
    t.applyDelta(n.toDelta());
    return t;
  }
  const e = new Y.XmlElement(n.nodeName);
  for (const [k, v] of Object.entries(n.getAttributes())) e.setAttribute(k, v);
  e.insert(0, n.toArray().map(cloneNode));
  return e;
}

// 版本還原：把 doc 中每個根片段的內容換成 source 對應片段的內容（一次刪除＋插入，屬於一般 CRDT 操作）
export const ROOT_FRAGMENTS = [ROOT, 'document-store'];
export function replaceFragmentsFrom(doc, source) {
  for (const name of ROOT_FRAGMENTS) {
    const target = doc.getXmlFragment(name);
    const src = source.getXmlFragment(name);
    if (target.length === 0 && src.length === 0) continue;
    if (target.length > 0) target.delete(0, target.length);
    target.insert(0, src.toArray().map(cloneNode));
  }
}

export function docFromUpdate(update) {
  const d = new Y.Doc();
  if (update && update.length) Y.applyUpdate(d, update);
  return d;
}

// a 是否完整包含 b 的所有內容與刪除（把 b 套用到 a 不會產生任何變化）。
export function containsState(aUpdate, bUpdate) {
  const a = docFromUpdate(aUpdate);
  const before = Y.snapshot(a);
  const beforeJson = docJSON(a);
  Y.applyUpdate(a, bUpdate);
  return Y.equalSnapshots(before, Y.snapshot(a)) && beforeJson === docJSON(a);
}
