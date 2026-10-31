// MIG-01：每個遷移都能回滾，回滾後重新套用的結構與原本完全相同；全部回滾後沒有殘留
import { spawnSync } from 'node:child_process';
import { APP_DIR, DB_URL, resetDb } from '../lib/harness.mjs';
import { Recorder } from '../lib/recorder.mjs';

export async function mig01(n) {
  const rec = new Recorder('MIG-01', '資料庫遷移回滾驗證');
  for (let i = 0; i < n; i++) {
    const r = spawnSync(process.execPath, [APP_DIR + 'scripts/migrate.mjs', 'check'], { env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8' });
    const fails = r.status === 0 ? [] : ['migrate check failed: ' + (r.stderr || r.stdout).slice(-300)];
    let m = {};
    try { m = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* 失敗時沒有 JSON */ }
    rec.add(i, i, fails, m);
  }
  await resetDb();
  return rec.save();
}
