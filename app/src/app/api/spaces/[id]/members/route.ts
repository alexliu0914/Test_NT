// 加入成員（只有建立者）：{ userId }
import { requireUser, readJson, audit, apiError } from '@/lib/guard';
import { addMember } from '@/lib/spaces';
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  const body = (await readJson<{ userId?: unknown }>(req)) ?? {};
  try {
    const r = await addMember(a.user.id, id, body.userId);
    await audit(a.user.id, 'space.member_add', `${id}:${String(body.userId)}`, req);
    return Response.json(r, { status: r.added ? 201 : 200 });
  } catch (e) { return apiError(e); }
}
