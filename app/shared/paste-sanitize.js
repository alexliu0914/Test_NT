// 貼上內容的清理（M2 W6、SEC-04）。只在瀏覽器執行。
// 外部貼上的 HTML 先在不會執行的文件（DOMParser）中清理，再交給 BlockNote：
// - 會執行或載入內容的元素（script、iframe、object、style……）整個移除
// - 圖片與影音在附件功能（M3）之前不能使用：改成文字提示，內容不會無提示消失
// - SVG、MathML、表單控制項只保留文字
// - 所有 on* 事件屬性與載入網址的屬性移除；連結只保留 link-policy 允許的協定，其餘只留文字
// 這只是第一道防線：BlockNote 在每次匯入與繪製連結時也會用同一個規則檢查（links.isValidLink），
// 未支援的區塊類型也不會使用區塊裡的網址（blocknote-schema.js）。
import { isSafeHref } from './link-policy.js';

const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'LINK', 'META', 'BASE',
  'NOSCRIPT', 'TEMPLATE', 'CANVAS', 'PORTAL', 'DIALOG']);
const TEXT_ONLY = new Set(['SVG', 'MATH', 'FORM', 'BUTTON', 'SELECT', 'OPTION', 'TEXTAREA', 'LABEL', 'FIELDSET', 'LEGEND', 'OUTPUT', 'DETAILS', 'SUMMARY']);
const MEDIA = { IMG: '圖片', PICTURE: '圖片', VIDEO: '影片', AUDIO: '音訊' };
const URL_ATTRS = ['src', 'srcset', 'srcdoc', 'action', 'formaction', 'background', 'poster', 'ping', 'dynsrc', 'lowsrc', 'data', 'codebase', 'xlink:href', 'cite', 'longdesc', 'usemap', 'manifest'];

export function sanitizeHTML(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  const walk = el => {
    for (const child of [...el.children]) {
      const tag = child.tagName.toUpperCase();
      if (DROP.has(tag)) { child.remove(); continue; }
      if (tag === 'INPUT' || tag === 'SOURCE' || tag === 'TRACK') { child.remove(); continue; }
      if (MEDIA[tag]) {
        const alt = (child.getAttribute('alt') || child.getAttribute('title') || '').trim();
        child.replaceWith(doc.createTextNode(`［${MEDIA[tag]}${alt ? '：' + alt : ''}］`));
        continue;
      }
      if (TEXT_ONLY.has(tag)) { child.replaceWith(doc.createTextNode(child.textContent || '')); continue; }
      for (const a of [...child.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith('on') || n === 'style' || URL_ATTRS.includes(n) || n.includes(':')) child.removeAttribute(a.name);
      }
      if (child.hasAttribute('href') && !isSafeHref(child.getAttribute('href'))) child.removeAttribute('href');
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

// 純文字看起來像 Markdown（標題、清單、引言、程式碼區塊、表格）時以 Markdown 貼上
const MD_BLOCK = /^(?: {0,3}#{1,6} \S| {0,3}[-*+] \S| {0,3}\d{1,9}[.)] \S| {0,3}> | {0,3}(?:```|~~~)| *\|.*\| *$)/m;

// F-M2-08：游標在空白區塊時，貼上的內容放進新建的區塊，再移除原本的空白區塊。
// 預設的貼上會沿用那個空白區塊（換掉內容、改區塊 ID）；另一個人的游標也在這一行時，他的這一行就變成貼上的內容，
// 他接著貼上或輸入就會落在別人的區塊裡。新建的區塊只屬於貼上的人，兩人同時貼到同一行時各自的內容都完整。
// 只處理「游標在沒有文字、沒有子區塊的區塊、沒有選取範圍」的情況；其他貼上與原本相同。
// 三個步驟各自送出（插入、貼上、移除），讓協作繫結逐步對應到新區塊；三步在 0.5 秒內，復原時一次全部復原。
export function pasteIntoOwnBlock(editor, doPaste) {
  let target = null;
  try {
    const empty = editor.transact(tr => tr.selection.empty);
    const b = editor.getTextCursorPosition().block;
    if (empty && Array.isArray(b.content) && b.content.length === 0 && !(b.children || []).length) target = b;
  } catch { target = null; }
  if (!target) return doPaste();
  const [fresh] = editor.insertBlocks([{ type: target.type, props: target.props }], target, 'after');
  editor.setTextCursorPosition(fresh, 'start');
  doPaste();
  if (editor.getBlock(target.id)) editor.removeBlocks([target.id]);
}

// BlockNote 的 pasteHandler：所有格式都先清理再貼上
export function safePasteHandler(ctx) {
  const cd = ctx.event.clipboardData;
  if (!cd) return false;
  // 沒有可貼上的內容（例如只有檔案）：不建立新區塊
  if (!['blocknote/html', 'text/markdown', 'text/html'].some(t => cd.types.includes(t)) && !cd.getData('text/plain')) return true;
  let handled = false;
  pasteIntoOwnBlock(ctx.editor, () => { handled = sanitizedPaste(ctx); });
  return handled;
}

function sanitizedPaste({ event, editor }) {
  const cd = event.clipboardData;
  if (!cd) return false;
  const types = [...cd.types];
  const plain = cd.getData('text/plain');
  // 程式碼區塊只接受純文字（與 BlockNote 預設相同）
  const inCode = editor.transact(tr => tr.selection.$from.parent.type.spec.code && tr.selection.$to.parent.type.spec.code);
  if (inCode) { if (plain) editor.pasteText(plain); return true; }
  const pasteMarkdown = md => editor.pasteHTML(sanitizeHTML(editor.blocksToFullHTML(editor.tryParseMarkdownToBlocks(md))), true);
  if (types.includes('blocknote/html')) { editor.pasteHTML(sanitizeHTML(cd.getData('blocknote/html')), true); return true; }
  if (types.includes('text/markdown')) { pasteMarkdown(cd.getData('text/markdown')); return true; }
  if (types.includes('text/html')) { editor.pasteHTML(sanitizeHTML(cd.getData('text/html'))); return true; }
  // 只有檔案（例如貼上圖片）：附件功能在 M3，忽略
  if (!plain) return true;
  if (MD_BLOCK.test(plain)) pasteMarkdown(plain); else editor.pasteText(plain);
  return true;
}
