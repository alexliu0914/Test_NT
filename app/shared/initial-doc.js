// 由 scripts/gen-initial-doc.mjs 產生，請勿手動修改（F-M1-05）
// 新頁面的文件骨架：一個空段落，Yjs clientID 固定為 1。伺服器建立頁面時寫入；
// 編輯器開啟時若文件仍是空的也先套用。所有地方的結構 ID 相同，所以重複套用不會產生第二份骨架。
export const SKELETON_CLIENT_ID = 1;
export const INITIAL_DOC_B64 = 'AQcBAAcBDmRvY3VtZW50LXN0b3JlAwpibG9ja0dyb3VwBwABAAMOYmxvY2tDb250YWluZXIHAAEBAwlwYXJhZ3JhcGgoAAECD2JhY2tncm91bmRDb2xvcgF3B2RlZmF1bHQoAAECCXRleHRDb2xvcgF3B2RlZmF1bHQoAAECDXRleHRBbGlnbm1lbnQBdwRsZWZ0KAABAQJpZAF3DWluaXRpYWwtYmxvY2sA';
export function initialDocUpdate() {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(INITIAL_DOC_B64, 'base64'));
  const s = atob(INITIAL_DOC_B64); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
