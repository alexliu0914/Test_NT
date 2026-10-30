// 測試資料庫防呆：測試會刪除並重建資料表，只允許連到「明確標記為測試用」的資料庫。
// 條件：資料庫名稱以 _test 結尾，且資料庫內存在標記資料表 __m0_test_database（由 test/setup-test-db.sh 建立）。
import pg from 'pg';

export const DB_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/m0_test';

export function dbName(url = DB_URL) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

export async function assertTestDatabase(pool) {
  const name = dbName();
  if (!/_test$/.test(name)) {
    throw new Error(`拒絕執行：資料庫「${name}」名稱不是以 _test 結尾。測試會刪除資料表，只能連到測試資料庫。`);
  }
  const r = await pool.query(`select to_regclass('public.__m0_test_database') as t`);
  if (!r.rows[0].t) {
    throw new Error(`拒絕執行：資料庫「${name}」沒有測試標記資料表 __m0_test_database。請用 test/setup-test-db.sh 建立測試資料庫。`);
  }
  const ctype = (await pool.query('select datctype from pg_database where datname = current_database()')).rows[0].datctype;
  if (!/utf-?8/i.test(ctype)) {
    throw new Error(`資料庫 LC_CTYPE 為 ${ctype}；必須是 C.UTF-8 或 en_US.UTF-8，否則中文搜尋索引無效。`);
  }
}

export function makePool(max = 6) {
  return new pg.Pool({ connectionString: DB_URL, max });
}
