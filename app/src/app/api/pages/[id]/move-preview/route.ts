// 跨空間移動前的預覽（P0-02）：誰會新增、失去存取權，子樹頁數，確認碼
// ?space=<空間 id>（移到該空間最上層）或 ?parent=<頁面 id>（移到該頁之下）
import { requireUser, apiError } from '@/lib/guard';
import { movePreview } from '@/lib/pages';
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  try {
    const preview = await movePreview(a.user.id, id, { spaceId: q.get('space') ?? undefined, parentId: q.get('parent') ?? undefined });
    return Response.json({ preview }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) { return apiError(e); }
}
