// 用法：node test/run.js M0-01=100 M0-02=100 ...
// 任一案例有失敗輪次、中止、未知案例名稱、輪數不足或結果檔缺失，退出碼都是 1（供 CI 阻擋合併）。
// 每次執行都寫出 results/summary.json：提交 SHA、環境版本、完整指令、各案例結果與退出碼。
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as cases from './cases.js';
import { resetSchema, db, Recorder, ROOT_DIR } from './harness.js';
import { DB_URL, dbName } from './testdb.js';

// 驗證 Runner 本身的自我測試案例
const selftests = {
  'SELFTEST-PASS': async n => { const r = new Recorder('SELFTEST-PASS', '刻意通過'); for (let i = 0; i < n; i++) r.add(i, i, []); return r.save(); },
  'SELFTEST-FAIL': async n => { const r = new Recorder('SELFTEST-FAIL', '刻意失敗'); for (let i = 0; i < n; i++) r.add(i, i, i === 0 ? ['intentional failure'] : []); return r.save(); },
  'SELFTEST-THROW': async () => { throw new Error('intentional exception'); },
  'SELFTEST-NORESULT': async n => ({ id: 'SELFTEST-NORESULT', total: n, failed: 0 }), // 回報成功但沒有寫結果檔
  'SELFTEST-HANG': () => new Promise(() => {}),        // 永遠不完成、也沒有其他待辦工作（Node 預設會以 13 直接結束）
  // 少跑一輪，但回傳值與結果檔彼此一致（第四輪審核指出的漏洞）
  'SELFTEST-SHORT': async n => { const r = new Recorder('SELFTEST-SHORT', '刻意少跑一輪'); for (let i = 0; i < n - 1; i++) r.add(i, i, []); return r.save(); },
  // 結果檔的 total 與逐輪紀錄數量不一致
  'SELFTEST-MISCOUNT': async n => {
    const r = new Recorder('SELFTEST-MISCOUNT', 'total 與逐輪紀錄不一致');
    for (let i = 0; i < n; i++) r.add(i, i, []);
    const saved = r.save();
    saved.iterations = saved.iterations.slice(1);
    writeFileSync(ROOT_DIR + 'results/SELFTEST-MISCOUNT.json', JSON.stringify(saved));
    return saved;
  },
  // 每個指定輪數實際跑 2 輪的案例（同 M0-09／M0-10 的情境倍數）：必須通過
  'SELFTEST-PER2': Object.assign(async n => { const r = new Recorder('SELFTEST-PER2', '每輪兩個情境'); for (let i = 0; i < 2 * n; i++) r.add(i, i, []); return r.save(); }, { roundsPer: 2 }),
};

function sh(cmd) { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } }

const started = new Date().toISOString();
// 保險：程序意外結束（例如未完成的等待使 Node 以 13 結束）時，仍寫出失敗的 summary
let summaryWritten = false;
process.on('exit', code => {
  if (summaryWritten) return;
  try {
    summary.finishedAt = new Date().toISOString();
    summary.exitCode = code || 1;
    summary.unexpectedExit = true;
    mkdirSync(ROOT_DIR + 'results', { recursive: true });
    writeFileSync(ROOT_DIR + 'results/summary.json', JSON.stringify(summary, null, 1));
    annotate(`unexpected exit ${code}; cases so far: ` + summary.cases.map(c => `${c.id}=${c.status}`).join(' '));
  } catch { /* ignore */ }
  if (!code) process.exitCode = 1;
});
// 在 GitHub Actions 中以註解輸出失敗摘要（可經 API 讀取，不必下載完整記錄）
function annotate(msg) { if (process.env.GITHUB_ACTIONS) console.log('::error title=m0::' + String(msg).replace(/\r?\n/g, ' ').slice(0, 900)); }
const args = process.argv.slice(2);
const summary = {
  startedAt: started,
  command: 'node test/run.js ' + args.join(' '),
  commit: sh(`git -C "${ROOT_DIR}" rev-parse HEAD`),
  dirty: sh(`git -C "${ROOT_DIR}" status --porcelain`) ? true : false,
  env: { node: process.version, platform: `${process.platform} ${process.arch}`, database: dbName(DB_URL) },
  cases: [],
};
let failed = false;

try {
  await resetSchema();
  summary.env.postgres = (await db.query('show server_version')).rows[0].server_version;
  const pj = p => { try { return JSON.parse(readFileSync(ROOT_DIR + 'node_modules/' + p + '/package.json', 'utf8')).version; } catch { return null; } };
  summary.env.packages = { yjs: pj('yjs'), ws: pj('ws'), pg: pj('pg'), '@blocknote/core': pj('@blocknote/core'), esbuild: pj('esbuild') };
  // 瀏覽器測試工具：Playwright 版本與 Chromium 版本（有安裝時）
  try {
    const mod = process.env.PLAYWRIGHT_MODULE;
    const pjPath = mod ? mod.replace(/index\.m?js$/, 'package.json') : ROOT_DIR + 'node_modules/playwright/package.json';
    summary.env.packages.playwright = JSON.parse(readFileSync(pjPath, 'utf8')).version;
    if (args.some(a => a.startsWith('BR-'))) {
      const pw = await import(mod || 'playwright');
      const chromium = (pw.chromium || pw.default.chromium);
      const b = await chromium.launch({ args: ['--no-sandbox'] });
      summary.env.chromium = b.version();
      await b.close();
    }
  } catch { /* 未安裝 Playwright：只跑核心測試 */ }
} catch (e) {
  console.error('setup failed:', e.message);
  summary.setupError = e.message;
  failed = true;
}

if (!failed) {
  for (const a of args) {
    const [id, nRaw] = a.split('=');
    const n = Number(nRaw);
    const entry = { id, requested: n, status: 'pass' };
    summary.cases.push(entry);
    let fn = selftests[id] || (/^M0-\d\d$/.test(id) ? cases['m0_' + id.slice(3)] : null);
    // 瀏覽器整合測試（需要 Playwright＋Chromium）只在指定時才載入
    if (!fn && /^BR-\d\d$/.test(id)) fn = (await import('./browser/cases.mjs'))['br_' + id.slice(3)];
    if (!fn || !/^M0-\d\d$|^BR-\d\d$|^SELFTEST-/.test(id)) { entry.status = 'unknown_case'; failed = true; console.error('unknown case', id); continue; }
    if (!Number.isInteger(n) || n <= 0) { entry.status = 'bad_count'; failed = true; continue; }
    console.log(`=== ${id} x${n}`);
    // 先刪除舊結果檔，避免沿用上次執行的結果
    const stale = ROOT_DIR + `results/${id}.json`;
    if (existsSync(stale)) unlinkSync(stale);
    let r;
    // 案例上限時間：計時器同時讓事件迴圈保持運作，未完成的等待會變成明確的 aborted，而不是程序直接結束
    const limitMs = Number(process.env.CASE_TIMEOUT_MS || 3 * 3600 * 1000);
    let timer;
    const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`case timeout after ${limitMs} ms`)), limitMs); });
    try { r = await Promise.race([fn(n), limit]); } catch (e) { entry.status = 'aborted'; entry.error = e.message; failed = true; console.error(`${id} aborted:`, e.message); continue; } finally { clearTimeout(timer); }
    const file = ROOT_DIR + `results/${id}.json`;
    if (!existsSync(file)) { entry.status = 'missing_result_file'; failed = true; continue; }
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    // 實際輪數必須等於要求輪數 × 每輪情境數，且 total、passed＋failed、逐輪紀錄三者一致
    const expected = n * (fn.roundsPer || 1);
    const its = Array.isArray(saved.iterations) ? saved.iterations : [];
    Object.assign(entry, { expected, total: saved.total, passed: saved.passed, failed: saved.failed, iterations: its.length, durationMs: saved.durationMs });
    if (saved.total !== expected || saved.passed + saved.failed !== saved.total || its.length !== saved.total
        || its.filter(x => x.pass).length !== saved.passed) {
      entry.status = 'incomplete'; failed = true;
      entry.error = `expected ${expected} rounds; total=${saved.total} passed+failed=${saved.passed + saved.failed} iterations=${its.length}`;
    } else if (saved.failed > 0) { entry.status = 'fail'; failed = true; entry.firstFails = saved.iterations.filter(x => !x.pass).slice(0, 2).map(x => `#${x.i}: ${x.fails.slice(0, 3).join('; ')}`); }
    else if (saved.total === 0) { entry.status = 'no_rounds'; failed = true; }
    else if (r && r.total !== saved.total) { entry.status = 'result_mismatch'; failed = true; }
  }
}

summary.finishedAt = new Date().toISOString();
summaryWritten = true;
summary.exitCode = failed ? 1 : 0;
mkdirSync(ROOT_DIR + 'results', { recursive: true });
writeFileSync(ROOT_DIR + 'results/summary.json', JSON.stringify(summary, null, 1));
for (const c of summary.cases) if (c.status !== 'pass') annotate(`${c.id} ${c.status} ${c.passed ?? ''}/${c.total ?? ''} ${c.error || ''} ${(c.firstFails || []).join(' | ')}`);
if (summary.setupError) annotate('setup: ' + summary.setupError);
console.log(`exit ${summary.exitCode}: ` + summary.cases.map(c => `${c.id}=${c.status}${c.total !== undefined ? `(${c.passed}/${c.total})` : ''}`).join(' '));
try { await db.end(); } catch { /* ignore */ }
process.exit(summary.exitCode);
