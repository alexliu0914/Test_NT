// 共享空間改名（PATCH）、刪除（DELETE；頁面移到建立者個人空間的垃圾桶）：只有建立者
import { requireUser, readJson, audit, apiError } from '@/lib/guard';
import { renameSpace, deleteSpace } from '@/lib/spaces';
type Ctx = { params: Promise<{ id: string }> };
export async function PATCH(req: Request, { params }: Ctx) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  const body = (await readJson<{ name?: unknown }>(req)) ?? {};
  try {
    return Response.json({ space: await renameSpace(a.user.id, id, body.name) });
  } catch (e) { return apiError(e); }
}
export async function DELETE(req: Request, { params }: Ctx) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  try {
    const r = await deleteSpace(a.user.id, id);
    await audit(a.user.id, 'space.delete', id, req);
    return Response.json(r);
  } catch (e) { return apiError(e); }
}
