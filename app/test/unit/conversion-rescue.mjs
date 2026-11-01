// F-M2-09 補救邏輯的單元測試（不需要資料庫與瀏覽器）：node test/unit/conversion-rescue.mjs
import * as Y from 'yjs';
import { createRescueDoc, applyWithRescue, mayNeedRescue, RESCUE_MAP } from '../../shared/conversion-rescue.js';
const SYNC = { key: 'y-sync$' };
const FR = 'document-store';
function seed() {
  const a = new Y.Doc();
  a.transact(() => { const g = new Y.XmlElement('blockGroup'), c = new Y.XmlElement('blockContainer'), p = new Y.XmlElement('paragraph'), t = new Y.XmlText(); t.insert(0, '乙原'); p.insert(0, [t]); c.setAttribute('id', 'x'); c.insert(0, [p]); g.insert(0, [c]); a.getXmlFragment(FR).insert(0, [g]); });
  return Y.encodeStateAsUpdate(a);
}
const cont = d => d.getXmlFragment(FR).get(0).get(0);
const textOf = d => cont(d).toString();
function world() {
  const s0 = seed();
  const S = createRescueDoc(); Y.applyUpdate(S, s0, 'load');
  const A = new Y.Doc(), B = new Y.Doc(); Y.applyUpdate(A, s0); Y.applyUpdate(B, s0);
  const capture = d => { const out = []; d.on('update', (u, o) => { if (o !== 'remote') out.push(u); }); return out; };
  return { S, A, B, qa: capture(A), qb: capture(B), log: [] };
}
// 伺服器處理一筆更新：回傳要廣播的 [原更新, 補救更新?]
function server(w, u) {
  const need = mayNeedRescue(w.S, u);
  if (!need) { Y.applyUpdate(w.S, u, 'remote'); return [u]; }
  const r = applyWithRescue(w.S, u);
  return r ? [u, r] : [u];
}
const deliver = (d, us) => { for (const u of us) Y.applyUpdate(d, u, 'remote'); };
const convert = (d, name) => d.transact(() => { const c = cont(d); const old = c.get(0); const txt = old.get(0) ? old.get(0).toString() : ''; c.delete(0, 1); const h = new Y.XmlElement(name), t = new Y.XmlText(); if (txt) t.insert(0, txt); h.insert(0, [t]); c.insert(0, [h]); }, SYNC);
const typeB = (w, at, str) => { const t = cont(w.B).get(0).get(0); t.insert(at === 'end' ? t.length : at, str); };
let fails = 0;
const check = (label, w, expect) => {
  const a = textOf(w.A), b = textOf(w.B), s = textOf(w.S);
  const ok = a === b && b === s && a.includes(expect);
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + label, ok ? a : { a, b, s });
};
// 1. A 改標題先到伺服器，B 之後才送出
{ const w = world(); convert(w.A, 'heading'); typeB(w, 'end', 'XYZ');
  const ra = server(w, w.qa.shift()); deliver(w.B, ra.slice(1)); // B 先不收 A 的原更新（模擬尚未收到），只收補救（此時沒有）
  const rb = server(w, w.qb.shift()); deliver(w.A, rb); deliver(w.B, ra.slice(0, 1)); deliver(w.B, rb.slice(1)); deliver(w.A, ra.slice(1));
  check('A 先、B 後（字在結尾）', w, '乙原XYZ'); }
// 2. B 先到伺服器、A 後到（同一批）
{ const w = world(); convert(w.A, 'heading'); typeB(w, 1, 'M');
  const rb = server(w, w.qb.shift()); const ra = server(w, w.qa.shift());
  deliver(w.A, rb); deliver(w.A, ra.slice(1)); deliver(w.B, ra);
  check('B 先、A 後（字在中間）', w, '乙M原'); }
// 3. 伺服器在兩者之間重新啟動（從壓縮後的狀態載入）
{ const w = world(); convert(w.A, 'bulletListItem'); typeB(w, 'end', 'R');
  const ra = server(w, w.qa.shift());
  const S2 = createRescueDoc(); Y.applyUpdate(S2, Y.encodeStateAsUpdate(w.S), 'load'); w.S = S2;
  const rb = server(w, w.qb.shift());
  deliver(w.A, rb); deliver(w.B, ra); deliver(w.B, rb.slice(1));
  check('伺服器重新啟動後', w, '乙原R'); }
// 4. 同一筆重送兩次（去重之前）：不會補第二次
{ const w = world(); convert(w.A, 'heading'); typeB(w, 'end', 'D');
  const ra = server(w, w.qa.shift()); const ub = w.qb.shift(); const rb = server(w, ub); const rb2 = server(w, ub);
  deliver(w.A, ra.slice(1)); deliver(w.A, rb); deliver(w.A, rb2.slice(1)); deliver(w.B, ra); deliver(w.B, rb.slice(1)); deliver(w.B, rb2.slice(1));
  check('重送不重複', w, '乙原D'); if ((textOf(w.A).match(/D/g) || []).length !== 1) { fails++; console.log('FAIL 重複補字'); } }
// 5. B 分兩次送出、再被改一次類型
{ const w = world(); convert(w.A, 'heading');
  const ra = server(w, w.qa.shift()); deliver(w.A, ra.slice(1));
  typeB(w, 'end', 'X'); const r1 = server(w, w.qb.shift());
  typeB(w, 'end', 'Y'); const r2 = server(w, w.qb.shift());
  deliver(w.A, r1); deliver(w.A, r2);
  convert(w.A, 'bulletListItem'); const ra2 = server(w, w.qa.shift());
  typeB(w, 0, 'S'); const r3 = server(w, w.qb.shift());
  deliver(w.A, ra2.slice(1)); deliver(w.A, r3);
  deliver(w.B, ra); deliver(w.B, r1.slice(1)); deliver(w.B, r2.slice(1)); deliver(w.B, ra2); deliver(w.B, r3.slice(1));
  check('連續改類型與分批輸入', w, 'S乙原XY'); }
// 6. 整個區塊被刪除（不是改類型）：不補
{ const w = world(); w.A.transact(() => w.A.getXmlFragment(FR).get(0).delete(0, 1), SYNC); typeB(w, 'end', 'Z');
  const ra = server(w, w.qa.shift()); const rb = server(w, w.qb.shift()); deliver(w.A, rb); deliver(w.B, ra);
  const ok = w.S.getXmlFragment(FR).toString() === '<blockgroup></blockgroup>' && w.S.getMap(RESCUE_MAP).size === 0;
  if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + '刪除區塊不補', w.S.getXmlFragment(FR).toString()); }
// 7. 原本是空白行：B 在 A 改類型前開始打字
{ const s0 = (() => { const a = new Y.Doc(); a.transact(() => { const g = new Y.XmlElement('blockGroup'), c = new Y.XmlElement('blockContainer'), p = new Y.XmlElement('paragraph'); c.insert(0, [p]); g.insert(0, [c]); a.getXmlFragment(FR).insert(0, [g]); }); return Y.encodeStateAsUpdate(a); })();
  const S = createRescueDoc(); Y.applyUpdate(S, s0, 'load'); const A = new Y.Doc(), B = new Y.Doc(); Y.applyUpdate(A, s0); Y.applyUpdate(B, s0);
  const qa = [], qb = []; A.on('update', (u, o) => { if (o !== 'remote') qa.push(u); }); B.on('update', (u, o) => { if (o !== 'remote') qb.push(u); });
  const w = { S, A, B, qa, qb };
  convert(A, 'heading');
  B.transact(() => { const t = new Y.XmlText(); t.insert(0, 'E'); cont(B).get(0).insert(0, [t]); });
  const ra = server(w, qa.shift()); const rb = server(w, qb.shift()); deliver(A, ra.slice(1)); deliver(A, rb); deliver(B, ra); deliver(B, rb.slice(1));
  check('空白行', w, 'E'); }
// 8. 已知問題（F-M2-09 待決議）：改類型後 B 在新區塊打字，A 復原改類型時，B 的字隨新區塊一起被移除（Yjs 復原的行為），
//    重做後恢復。伺服器不補這種情況（改類型的人知道這些字；在復原時補字會讓之後的重做產生兩個內容節點），瀏覽器測試 COL-01 記錄。
// 9. 選取後貼上取代（新節點有舊節點沒有的字）：被取代的字不復活
{ const w = world(); w.A.transact(() => { const c = cont(w.A); c.delete(0, 1); const h = new Y.XmlElement('heading'), t = new Y.XmlText(); t.insert(0, '新'); h.insert(0, [t]); c.insert(0, [h]); }, SYNC);
  const ra = server(w, w.qa.shift()); deliver(w.B, ra);
  const ok = textOf(w.S) === textOf(w.B) && !textOf(w.S).includes('乙原') && textOf(w.S).includes('新');
  if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + '取代的字不復活', textOf(w.S)); }
console.log(fails ? `FAILED ${fails}` : 'all ok');
process.exit(fails ? 1 : 0);
