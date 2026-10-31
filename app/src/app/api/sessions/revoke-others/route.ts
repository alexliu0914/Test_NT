// 登出其他所有裝置（保留目前這個）
import { pool } from '@/lib/db';
import { requireUser, audit } from '@/lib/guard';
export async function POST(req: Request) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const r = await pool.query('delete from "session" where user_id=$1 and id<>$2 returning id', [a.user.id, a.sessionId]);
  await audit(a.user.id, 'session.revoke_others', String(r.rowCount), req);
  return Response.json({ revoked: r.rowCount });
}
