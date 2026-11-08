// 版本與衝突副本預覽的安全轉換（M2-c W4-C、SEC-04 的版本預覽路徑）：
// 預覽只回傳區塊 JSON（由 BlockNote 的結構轉出，不含任何 HTML），並在回傳前再套用一次連結規則：
// - 行內連結的網址不安全（javascript:、data:、vbscript: 等，含空白與控制字元的變體）時改成純文字，不留連結
// - 區塊屬性中的網址（url、href、src）不安全時清空
// - 頁面連結區塊只保留格式正確的 page_id（標題由畫面依目前的授權另外取得）
// 顯示端（版本面板）另以唯讀的 BlockNote 編輯器繪製，同樣套用 isSafeHref。
import { isSafeHref, PAGE_ID_RE } from './link-policy.js';

const URL_PROPS = new Set(['url', 'href', 'src', 'previewUrl']);

function safeInline(content) {
  if (!Array.isArray(content)) return content;
  const out = [];
  for (const item of content) {
    if (item && item.type === 'link') {
      const inner = safeInline(item.content || []);
      if (isSafeHref(item.href)) out.push({ ...item, content: inner });
      else out.push(...inner);
    } else out.push(item);
  }
  return out;
}

function safeTable(content) {
  if (!content || content.type !== 'tableContent' || !Array.isArray(content.rows)) return content;
  return { ...content, rows: content.rows.map(r => ({ ...r, cells: (r.cells || []).map(c => (Array.isArray(c) ? safeInline(c) : c && Array.isArray(c.content) ? { ...c, content: safeInline(c.content) } : c)) })) };
}

export function safeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map(b => {
    const props = { ...(b.props || {}) };
    for (const k of Object.keys(props)) if (URL_PROPS.has(k) && typeof props[k] === 'string' && props[k] && !isSafeHref(props[k])) props[k] = '';
    if (b.type === 'pageLink' && !(typeof props.pageId === 'string' && PAGE_ID_RE.test(props.pageId))) props.pageId = '';
    const content = Array.isArray(b.content) ? safeInline(b.content) : safeTable(b.content);
    return { ...b, props, content, children: safeBlocks(b.children || []) };
  });
}
