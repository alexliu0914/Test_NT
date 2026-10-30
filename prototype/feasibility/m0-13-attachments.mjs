// M0-13 最小可行性：同一檔案被多頁引用時的刪除與清理
import { fileURLToPath } from 'node:url';
import { makePool, assertTestDatabase } from '../test/testdb.js';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { Attachments, SCHEMA } from '../src/attachments.js';

const pool = makePool(8);
await assertTestDatabase(pool);
await pool.query(SCHEMA);
const DIR = fileURLToPath(new URL('./objstore', import.meta.url));
const OUT = fileURLToPath(new URL('../results-feas/', import.meta.url));
rmSync(DIR, { recursive: true, force: true });
const att = new Attachments(pool, DIR);
const DAY = 86400000;
const checks = [];
const check = (name, cond) => checks.push({ name, pass: !!cond });

const bytes = Buffer.from('fake audio ' + randomUUID());
const sha = createHash('sha256').update(bytes).digest('hex');
let now = Date.UTC(2026, 10, 1);

// 兩頁同時上傳同一檔案：只產生一份實體檔案
const [f1, f2] = await Promise.all([att.upload('p1', sha, bytes, now), att.upload('p2', sha, bytes, now)]);
const blobCount = Number((await pool.query('select count(*) from att_blobs where sha256=$1', [sha])).rows[0].count);
check('並發上傳同一檔案只產生一個 blob', blobCount === 1 && f1.blobId === f2.blobId);
check('其中一次上傳直接重用', f1.reused !== f2.reused);

// 刪除 p1 並快轉 31 天清理：p2 仍可播放
await att.deletePage('p1', now);
now += 31 * DAY; await att.purge(now);
check('刪除 p1 滿 30 天後，p2 仍可播放', await att.playable(f2.fileId));
check('p1 的引用已移除', (await pool.query('select 1 from att_files where id=$1', [f1.fileId])).rowCount === 0);
now += 30 * DAY; await att.purge(now);
check('仍有引用時實體檔案不會被刪', await att.playable(f2.fileId));

// 刪除 p2：引用 30 天後移除，再等 7 天才刪實體檔案；期間重新上傳會取消刪除
await att.deletePage('p2', now);
now += 31 * DAY; let removed = await att.purge(now);
check('最後一個引用移除當下不刪實體檔案', removed.length === 0);
now += 3 * DAY; removed = await att.purge(now);
check('無引用第 3 天仍保留', removed.length === 0);
const f3 = await att.upload('p3', sha, bytes, now);
check('寬限期內再次上傳相同檔案直接重用', f3.reused && await att.playable(f3.fileId));
now += 10 * DAY; removed = await att.purge(now);
check('重新被引用後不會被刪', removed.length === 0 && await att.playable(f3.fileId));

// 刪除 p3 後完整走完清理
await att.deletePage('p3', now);
now += 31 * DAY; await att.purge(now);
now += 8 * DAY; removed = await att.purge(now);
check('沒有任何引用滿 7 天後刪除實體檔案', removed.includes(sha));
check('資料庫與物件儲存都沒有孤兒檔案', (await pool.query('select count(*) from att_blobs')).rows[0].count === '0');

// 垃圾桶內還原頁面：引用恢復
const b2 = Buffer.from('another ' + randomUUID());
const sha2 = createHash('sha256').update(b2).digest('hex');
const g = await att.upload('p4', sha2, b2, now);
await att.deletePage('p4', now);
now += 10 * DAY; await att.purge(now);
await att.restorePage('p4');
check('30 天內從垃圾桶還原後仍可播放', await att.playable(g.fileId));

const passed = checks.filter(c => c.pass).length;
const result = { id: 'M0-13', title: '共用附件的引用與清理（本機目錄代替 R2，時間快轉）', total: checks.length, passed, failed: checks.length - passed, checks };
mkdirSync(OUT, { recursive: true });
writeFileSync(OUT + 'M0-13.json', JSON.stringify(result, null, 1));
console.log(`M0-13: ${passed}/${checks.length}`, checks.filter(c => !c.pass).map(c => c.name));
await pool.end();
process.exitCode = result.failed === 0 && result.total > 0 ? 0 : 1;
