// 健康檢查：不需登入，不回傳任何資料內容
import { pool } from '@/lib/db';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { await pool.query('select 1'); return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } }); }
  catch { return Response.json({ ok: false }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
}
