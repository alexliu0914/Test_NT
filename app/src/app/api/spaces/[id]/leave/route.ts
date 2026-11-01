// 成員自己退出共享空間（建立者不能退出）
import { requireUser, audit, apiError } from '@/lib/guard';
import { leaveSpace } from '@/lib/spaces';
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  try {
    const r = await leaveSpace(a.user.id, id);
    await audit(a.user.id, 'space.leave', id, req);
    return Response.json(r);
  } catch (e) { return apiError(e); }
}
