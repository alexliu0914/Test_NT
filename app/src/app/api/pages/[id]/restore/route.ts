// 從垃圾桶還原（整個刪除批次一起回來；只能還原自己所屬空間的頁面）
import { requireUser, audit, apiError } from '@/lib/guard';
import { restorePage } from '@/lib/pages';
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  try {
    const r = await restorePage(a.user.id, id);
    await audit(a.user.id, 'page.restore', id, req);
    return Response.json(r);
  } catch (e) { return apiError(e); }
}
