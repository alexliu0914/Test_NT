// 永久刪除垃圾桶中超過 30 天的頁面（PAGE-04）。正式環境由排程每天執行一次。
import { pool } from '../src/lib/db';
import { purgeTrash, TRASH_DAYS } from '../src/lib/pages';
try { console.log(JSON.stringify(await purgeTrash(Number(process.argv[2] || TRASH_DAYS)))); }
catch (e) { console.error((e as Error).message); process.exitCode = 1; }
finally { await pool.end(); }
