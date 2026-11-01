// 連結安全規則（M2 W6、SEC-04）：只允許 http:、https:、mailto: 與站內頁面連結（/p/<page_id>）。
// 編輯器在每個連結進入或顯示的地方都用這個判斷（BlockNote 的 links.isValidLink：HTML 匯入、貼上、自動連結、繪製），
// 貼上時的清理（paste-sanitize.js）與頁面連結區塊也用同一個規則。其他協定一律不建立連結，只留文字。
export const PAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_HREF_RE = /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// 瀏覽器解析網址時會忽略的字元（空白、控制字元、零寬字元）先移除，避免 "java\tscript:" 之類的變體
export function normalizeHref(href) {
  return String(href ?? '').replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '');
}

export function isSafeHref(href) {
  const h = normalizeHref(href);
  if (!h) return false;
  if (/^https?:\/\/[^/\\]/i.test(h)) return true;
  if (/^mailto:./i.test(h)) return true;
  return PAGE_HREF_RE.test(h);
}

export function pageIdOfHref(href) {
  const m = PAGE_HREF_RE.exec(normalizeHref(href));
  return m ? m[1].toLowerCase() : null;
}
