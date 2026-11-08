// 手動清除超過保留期限的版本（M2-c 附錄 B2）：node scripts/purge-versions.mjs [天數，預設 90]
// 協作伺服器也會定時執行同一個清理。
import pg from 'pg';
import { purgeVersions, RETENTION_DAYS } from '../shared/version-retention.js';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL 未設定'); process.exit(1); }
const days = Number(process.argv[2] || RETENTION_DAYS);
if (!Number.isFinite(days) || days < 1) { console.error('天數必須是 1 以上的數字'); process.exit(1); }
const pool = new pg.Pool({ connectionString: url, max: 1, application_name: 'purge-versions' });
try { console.log(JSON.stringify(await purgeVersions(pool, days))); }
finally { await pool.end(); }
