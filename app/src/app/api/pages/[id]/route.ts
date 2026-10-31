// 改名、改圖示、移動（PATCH）；移入垃圾桶（DELETE）
import { requireUser, jsonError, readJson, audit } from '@/lib/guard';
import { updatePage, trashPage, PageError } from '@/lib/pages';
type Ctx = { params: Promise<{ id: string }> };
export async function PATCH(req: Request, { params }: Ctx) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  const body = (await readJson(req)) ?? {};
  try {
    const page = await updatePage(id, body as Parameters<typeof updatePage>[1]);
    return Response.json({ page });
  } catch (e) {
    if (e instanceof PageError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
export async function DELETE(req: Request, { params }: Ctx) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  try {
    const r = await trashPage(id);
    await audit(a.user.id, 'page.trash', id, req);
    return Response.json(r);
  } catch (e) {
    if (e instanceof PageError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
