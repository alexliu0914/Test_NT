// 案例登錄表：編號 → 延遲載入的測試函式（每個函式接收輪數 n，回傳 Recorder 結果）
const from = (mod, name) => async () => (await import(mod))[name];
export const registry = {
  'MIG-01': from('./migrations.mjs', 'mig01'),
  'AUTH-01': from('./auth.mjs', 'auth01'), 'AUTH-02': from('./auth.mjs', 'auth02'), 'AUTH-03': from('./auth.mjs', 'auth03'),
  'AUTH-04': from('./auth.mjs', 'auth04'), 'AUTH-05': from('./auth.mjs', 'auth05'), 'AUTH-06': from('./auth.mjs', 'auth06'),
  'AUTH-07': from('./auth.mjs', 'auth07'),
  'SEC-01': from('./auth.mjs', 'sec01'), 'SEC-02': from('./auth.mjs', 'sec02'), 'SEC-03': from('./auth.mjs', 'sec03'),
  'SEC-05': from('./auth.mjs', 'sec05'), 'SEC-06': from('./auth.mjs', 'sec06'),
  'PAGE-01': from('./pages.mjs', 'page01'), 'PAGE-02': from('./pages.mjs', 'page02'), 'PAGE-03': from('./pages.mjs', 'page03'),
  'PAGE-04': from('./pages.mjs', 'page04'), 'PAGE-05': from('./pages.mjs', 'page05'),
  'BR-01': from('./browser.mjs', 'br01'), 'BR-02': from('./browser-idb.mjs', 'br02'), 'BR-03': from('./browser-ui.mjs', 'br03'), 'BR-04': from('./browser-concurrent.mjs', 'br04'),
  ...Object.fromEntries(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '17'].map(k => [`M0-${k}`, from('./m0.mjs', `m0_${k}`)])),
};
