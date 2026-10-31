// 驗證 Runner 會把失敗正確回報為非零退出碼，以及拒絕連到非測試資料庫。
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DB_URL } from './lib/harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = (args, env = {}) => spawnSync(process.execPath, ['test/run.js', ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });

const prodLike = new URL(DB_URL); prodLike.pathname = '/postgres';
const checks = [
  { name: '全部通過 → 退出碼 0', args: ['SELFTEST-PASS=3'], expect: 0 },
  { name: '有一輪失敗 → 退出碼 1', args: ['SELFTEST-FAIL=3'], expect: 1 },
  { name: '通過與失敗混合 → 退出碼 1', args: ['SELFTEST-PASS=2', 'SELFTEST-FAIL=2'], expect: 1 },
  { name: '案例拋出例外 → 退出碼 1', args: ['SELFTEST-THROW=1'], expect: 1 },
  { name: '回報成功但沒有結果檔 → 退出碼 1', args: ['SELFTEST-NORESULT=1'], expect: 1 },
  { name: '案例卡住不結束 → 逾時記為 aborted、退出碼 1', args: ['SELFTEST-HANG=1'], env: { CASE_TIMEOUT_MS: '1500' }, expect: 1, summaryStatus: 'aborted' },
  { name: '少跑一輪（回傳與結果檔一致）→ incomplete、退出碼 1', args: ['SELFTEST-SHORT=5'], expect: 1, summaryStatus: 'incomplete' },
  { name: 'total 與逐輪紀錄不一致 → incomplete、退出碼 1', args: ['SELFTEST-MISCOUNT=5'], expect: 1, summaryStatus: 'incomplete' },
  { name: '有情境倍數的案例跑足輪數 → 退出碼 0', args: ['SELFTEST-PER2=3'], expect: 0, summaryStatus: 'pass' },
  { name: '未知案例名稱 → 退出碼 1', args: ['M0-99=1'], expect: 1 },
  { name: '輪數無效 → 退出碼 1', args: ['SELFTEST-PASS=0'], expect: 1 },
  { name: '連到非測試資料庫 → 拒絕執行、退出碼 1', args: ['SELFTEST-PASS=1'], env: { TEST_DATABASE_URL: prodLike.toString(), DATABASE_URL: prodLike.toString() }, expect: 1, mustSay: '拒絕執行' },
];

const out = [];
for (const c of checks) {
  const r = run(c.args, c.env);
  let ok = r.status === c.expect && (!c.mustSay || (r.stdout + r.stderr).includes(c.mustSay));
  if (c.summaryStatus) {
    try { ok = ok && JSON.parse(readFileSync(ROOT + 'results/summary.json', 'utf8')).cases[0].status === c.summaryStatus; } catch { ok = false; }
  }
  out.push({ name: c.name, args: c.args, expected: c.expect, actual: r.status, pass: ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} (exit ${r.status})`);
}
const passed = out.filter(x => x.pass).length;
mkdirSync(ROOT + 'results', { recursive: true });
writeFileSync(ROOT + 'results/runner-selftest.json', JSON.stringify({ id: 'RUNNER-SELFTEST', total: out.length, passed, failed: out.length - passed, checks: out }, null, 1));
console.log(`runner self-test: ${passed}/${out.length}`);
process.exit(passed === out.length ? 0 : 1);
