// 撤銷某個裝置的登入：刪除 session（資料庫觸發器通知協作伺服器立即中斷該裝置的連線）
import { pool } from '@/lib/db';
import { requireUser, jsonError, audit } from '@/lib/guard';
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  const r = await pool.query('delete from "session" where id=$1 and user_id=$2 returning id', [id, a.user.id]);
  if (!r.rows[0]) return jsonError(404, 'not_found', '找不到這個登入裝置');
  await audit(a.user.id, 'session.revoke', id, req);
  return Response.json({ revoked: id, current: id === a.sessionId });
}
