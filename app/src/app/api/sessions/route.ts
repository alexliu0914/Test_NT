// 列出自己的登入裝置（不回傳 session token）
import { pool } from '@/lib/db';
import { requireUser } from '@/lib/guard';
export async function GET(req: Request) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const r = await pool.query(
    `select id, created_at, updated_at, expires_at, ip_address, user_agent from "session"
      where user_id=$1 and expires_at > now() order by updated_at desc`, [a.user.id]);
  return Response.json({ sessions: r.rows.map(s => ({
    id: s.id, createdAt: s.created_at, lastActiveAt: s.updated_at, expiresAt: s.expires_at,
    ip: s.ip_address, userAgent: s.user_agent, current: s.id === a.sessionId,
  })) }, { headers: { 'cache-control': 'no-store' } });
}
