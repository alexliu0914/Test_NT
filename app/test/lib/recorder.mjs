// 結果紀錄（與 M0 相同格式）：每一輪的種子、是否通過、失敗原因、量測值；寫入 results/<id>.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { APP_DIR } from './harness.mjs';

export const RESULTS_DIR = APP_DIR + 'results/';

export class Recorder {
  constructor(id, title, meta = {}) {
    this.r = { id, title, meta, startedAt: new Date().toISOString(), iterations: [] };
    this.t0 = Date.now();
  }
  add(i, seed, fails, metrics = {}) {
    this.r.iterations.push({ i, seed, pass: fails.length === 0, fails, metrics });
    if (fails.length || i % 20 === 0) console.log(`${this.r.id} #${i} seed=${seed} ${fails.length ? 'FAIL' : 'ok'} ${fails.slice(0, 3).join(' | ')}`);
  }
  save(extra = {}) {
    const it = this.r.iterations;
    Object.assign(this.r, extra, { durationMs: Date.now() - this.t0, total: it.length, passed: it.filter(x => x.pass).length, failed: it.filter(x => !x.pass).length });
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(RESULTS_DIR + `${this.r.id}.json`, JSON.stringify(this.r, null, 1));
    console.log(`${this.r.id}: ${this.r.passed}/${this.r.total} passed (${Math.round(this.r.durationMs / 1000)}s)`);
    return this.r;
  }
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const within = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for ' + label)), ms))]);

// 執行一輪：例外或逾時都記為失敗，然後執行 cleanup 並繼續
export async function runRound(rec, i, seed, fn, cleanup = async () => {}) {
  let res;
  try { res = await fn(); } catch (e) { res = [['exception: ' + (e && e.message || e)], {}]; }
  try { await cleanup(); } catch (e) { res[0].push('cleanup: ' + e.message); }
  rec.add(i, seed, res[0], res[1] || {});
}
