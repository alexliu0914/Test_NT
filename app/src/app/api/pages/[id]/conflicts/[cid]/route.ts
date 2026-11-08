// 衝突副本預覽（M2-c W4-B）：唯讀、經安全轉換的區塊 JSON；頁面不可見或副本不屬於此頁時 404
import { requireUser, apiError } from '@/lib/guard';
import { previewConflict } from '@/lib/versions';
export async function GET(req: Request, { params }: { params: Promise<{ id: string; cid: string }> }) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id, cid } = await params;
  try { return Response.json(await previewConflict(a.user.id, id, cid), { headers: { 'cache-control': 'no-store' } }); } catch (e) { return apiError(e); }
}
