// 版本預覽（M2-c W4-C）：唯讀、經安全轉換的區塊 JSON（shared/version-preview.js）；頁面不可見或版本不屬於此頁時 404
import { requireUser, apiError } from '@/lib/guard';
import { previewVersion } from '@/lib/versions';
export async function GET(req: Request, { params }: { params: Promise<{ id: string; vid: string }> }) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id, vid } = await params;
  try { return Response.json(await previewVersion(a.user.id, id, vid), { headers: { 'cache-control': 'no-store' } }); } catch (e) { return apiError(e); }
}
