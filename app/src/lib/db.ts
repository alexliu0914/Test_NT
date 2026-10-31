// 資料庫連線：Next.js 伺服器端共用一個連線池（開發模式熱重載時沿用同一個）
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const g = globalThis as unknown as { __pool?: pg.Pool };

export const pool: pg.Pool = g.__pool ?? new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  application_name: 'web',
});
if (process.env.NODE_ENV !== 'production') g.__pool = pool;
pool.on('error', () => { /* 閒置連線被中斷：連線池會自行補上 */ });

export const db = drizzle(pool, { schema });
