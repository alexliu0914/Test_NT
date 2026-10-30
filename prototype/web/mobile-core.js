// M0-15 手機測試頁（只有核心編輯器，沒有選單 UI）：本機開發與自動化測試用
globalThis.__m015Mount = async (editor, el) => { editor.mount(el); globalThis.__m015UI = 'core'; };
await import('./mobile.js');
