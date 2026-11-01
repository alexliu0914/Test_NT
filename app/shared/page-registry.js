// 瀏覽器端的頁面標題表：側邊欄載入頁面樹（只含未刪除的頁面）後更新，頁面連結區塊從這裡取目前的標題。
// 不在表中的頁面（在垃圾桶、已永久刪除、不存在）一律顯示中性的「無法開啟」，不顯示先前的標題（M2 W1）。
const pages = new Map();
const subs = new Set();
let navigate = null;
let loaded = false;

export const pageRegistry = {
  set(list) {
    pages.clear();
    for (const p of list) pages.set(p.id, { title: p.title, icon: p.icon });
    loaded = true;
    for (const fn of subs) { try { fn(); } catch { /* 單一區塊的錯誤不影響其他區塊 */ } }
  },
  get(id) { return pages.get(id) || null; },
  loaded() { return loaded; },
  list() { return [...pages.entries()].map(([id, v]) => ({ id, ...v })); },
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  setNavigate(fn) { navigate = fn; },
  navigate(path) { if (navigate) navigate(path); else if (typeof location !== 'undefined') location.assign(path); },
};
