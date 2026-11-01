// 移除成員（只有建立者；不能移除建立者）
import { requireUser, audit, apiError } from '@/lib/guard';
import { removeMember } from '@/lib/spaces';
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id, userId } = await params;
  try {
    const r = await removeMember(a.user.id, id, userId);
    await audit(a.user.id, 'space.member_remove', `${id}:${userId}`, req);
    return Response.json(r);
  } catch (e) { return apiError(e); }
}
