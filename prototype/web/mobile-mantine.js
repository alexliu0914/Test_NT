// M0-15 手機測試頁（正式 UI：@blocknote/mantine 的斜線選單、格式工具列、區塊拖曳把手）
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/mantine/style.css';

const dark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
globalThis.__m015Mount = (editor, el) => new Promise(resolve => {
  const root = createRoot(el);
  const render = () => root.render(createElement(BlockNoteView, { editor, theme: dark() ? 'dark' : 'light' }));
  render();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  globalThis.__m015UI = 'mantine';
  // 等編輯器真的掛上（協作綁定在 ProseMirror 視圖建立時才生效），再繼續初始化
  const t0 = Date.now();
  (function wait() { if (el.querySelector('.ProseMirror') || Date.now() - t0 > 5000) resolve(); else setTimeout(wait, 20); })();
});
await import('./mobile.js');
