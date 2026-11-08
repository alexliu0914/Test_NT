// 版本清單（M2-c W4-C）：版本、還原紀錄、衝突副本的中繼資料；頁面不可見時 404。只讀，沒有寫入方法
import { requireUser, apiError } from '@/lib/guard';
import { listVersions } from '@/lib/versions';
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  try { return Response.json(await listVersions(a.user.id, id), { headers: { 'cache-control': 'no-store' } }); } catch (e) { return apiError(e); }
}
