// M0-14 最小可行性：1,000 頁繁體中文（合成資料）以 pg_trgm 搜尋 2、3、4 字與中英混合查詢的延遲
// 注意：這裡沒有真實筆記，用詞彙表合成內容；真實資料實測留到 M1。
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makePool, assertTestDatabase } from '../test/testdb.js';
const OUT = fileURLToPath(new URL('../results-feas/', import.meta.url));

const pool = makePool(4);
await assertTestDatabase(pool);
let a = 14014;
const rnd = () => { // mulberry32
  a = (a + 0x6d2b79f5) >>> 0; let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = a => a[Math.floor(rnd() * a.length)];

const vocab = ('今天 明天 會議 記錄 專案 規格 需求 設計 測試 部署 伺服器 資料庫 備份 還原 版本 使用者 帳號 密碼 權限 '
  + '網路 路由器 防火牆 連線 速度 延遲 頻寬 無線 有線 設備 電腦 手機 平板 螢幕 鍵盤 滑鼠 印表機 '
  + '旅行 行程 機票 飯店 預算 費用 發票 報帳 採購 合約 客戶 廠商 報價 會計 稅務 '
  + '學習 課程 筆記 閱讀 書籍 文章 摘要 重點 問題 解答 想法 計畫 目標 進度 待辦 完成 延後 取消 '
  + '音樂 音檔 錄音 訪談 播客 影片 照片 相簿 剪輯 字幕 翻譯 中文 英文 日文 '
  + '健康 運動 飲食 睡眠 早餐 午餐 晚餐 咖啡 天氣 颱風 下雨 晴天 台北 台中 高雄 東京 新加坡').split(' ');
const keywords = { '韌體': 0.08, '交換器': 0.06, '網路設定': 0.05, 'VPN 設定': 0.04, 'Docker 部署': 0.04, '光纖數據機': 0.005 };
const punct = ['，', '。', '、', '；', '：', '\n'];

// 關鍵字以「頁」為單位出現：每頁以機率 p 含有該關鍵字 1～3 次（約 0.5%～8% 的頁面）
function page() {
  const len = 400 + Math.floor(rnd() * 2600);
  const parts = [];
  let n = 0;
  while (n < len) {
    const w = pick(vocab) + (rnd() < 0.3 ? pick(punct) : '');
    parts.push(w); n += w.length;
  }
  // 只插在詞與詞之間，避免把先前插入的關鍵字切斷
  for (const [k, p] of Object.entries(keywords)) {
    if (rnd() >= p) continue;
    for (let c = 1 + Math.floor(rnd() * 3); c > 0; c--) parts.splice(Math.floor(rnd() * (parts.length + 1)), 0, k);
  }
  return parts.join('');
}

await pool.query('create extension if not exists pg_trgm');
await pool.query('drop table if exists m0_search');
await pool.query('create table m0_search (page_id int primary key, title text, plain_text text)');
const t0 = Date.now();
for (let i = 0; i < 1000; i += 50) {
  const vals = []; const params = [];
  for (let j = i; j < i + 50; j++) { params.push(j, `${pick(vocab)}${pick(vocab)} ${j}`, page()); vals.push(`($${params.length - 2},$${params.length - 1},$${params.length})`); }
  await pool.query(`insert into m0_search values ${vals.join(',')}`, params);
}
await pool.query('create index on m0_search using gin (plain_text gin_trgm_ops)');
await pool.query('create index on m0_search using gin (title gin_trgm_ops)');
await pool.query('analyze m0_search');
const stats = (await pool.query('select count(*)::int n, avg(length(plain_text))::int avg_len, sum(length(plain_text))::bigint chars from m0_search')).rows[0];

const queries = ['韌體', '交換器', '網路設定', 'VPN 設定', 'Docker 部署', '光纖數據機', '颱風'];
const RUNS = 40;
const out = [];
for (const q of queries) {
  // 取回全部符合的頁面（不加 LIMIT），反映最差情況
  const sql = `select page_id from m0_search where plain_text ilike $1 or title ilike $1`;
  const like = '%' + q + '%';
  const plan = (await pool.query('explain ' + sql, [like])).rows.map(r => r['QUERY PLAN']).join(' | ');
  const usesIndex = /Bitmap Index Scan/.test(plan);
  const times = [];
  let hits = 0;
  for (let r = 0; r < RUNS; r++) {
    const s = process.hrtime.bigint();
    const res = await pool.query(sql, [like]);
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
    hits = res.rowCount;
  }
  const total = (await pool.query('select count(*)::int c from m0_search where plain_text ilike $1 or title ilike $1', [like])).rows[0].c;
  times.sort((a, b) => a - b);
  out.push({ query: q, chars: [...q.replace(/ /g, '')].length, matchingPages: total, returned: hits, usesTrigramIndex: usesIndex,
    p50ms: +times[Math.floor(RUNS / 2)].toFixed(2), p95ms: +times[Math.floor(RUNS * 0.95)].toFixed(2), maxms: +times[RUNS - 1].toFixed(2) });
}
const worstP95 = Math.max(...out.map(o => o.p95ms));
const result = { id: 'M0-14', title: '1,000 頁繁中合成資料的 pg_trgm 搜尋延遲', corpus: stats, buildMs: Date.now() - t0, runsPerQuery: RUNS, queries: out, worstP95ms: worstP95, pass: worstP95 <= 1000,
  note: '資料為詞彙表合成，非真實筆記；資料庫 LC_CTYPE 為 C.UTF-8。LC_CTYPE=C 時 pg_trgm 對中文不產生任何 trigram（另行驗證）。' };
mkdirSync(OUT, { recursive: true });
writeFileSync(OUT + 'M0-14.json', JSON.stringify(result, null, 1));
console.table(out);
console.log('corpus', stats, 'worst p95', worstP95);
await pool.query('drop table m0_search');
await pool.end();
process.exitCode = result.pass ? 0 : 1;
