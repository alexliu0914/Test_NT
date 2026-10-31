// 從垃圾桶還原（整個刪除批次一起回來）
import { requireUser, jsonError, audit } from '@/lib/guard';
import { restorePage, PageError } from '@/lib/pages';
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  try {
    const r = await restorePage(id);
    await audit(a.user.id, 'page.restore', id, req);
    return Response.json(r);
  } catch (e) {
    if (e instanceof PageError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
