// 取得 5 分鐘協作憑證（頁面必須存在、不在垃圾桶，且使用者是所屬空間的成員；否則一律 404）
import { requireUser, jsonError } from '@/lib/guard';
import { pageVisible } from '@/lib/pages';
import { signCollabToken, COLLAB_TOKEN_TTL_MS } from '@shared/collab-token.mjs';
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  if (!(await pageVisible(a.user.id, id))) return jsonError(404, 'not_found', '頁面不存在');
  const token = signCollabToken({ sid: a.sessionId, uid: a.user.id, pid: id.toLowerCase(), name: a.user.name });
  return Response.json({ token, url: process.env.COLLAB_PUBLIC_URL, expiresInMs: COLLAB_TOKEN_TTL_MS },
    { headers: { 'cache-control': 'no-store' } });
}
