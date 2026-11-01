// 改名、改圖示、移動（PATCH；跨空間時必須帶 move-preview 的確認碼）；移入垃圾桶（DELETE）
import { requireUser, readJson, audit, apiError } from '@/lib/guard';
import { updatePage, trashPage } from '@/lib/pages';
type Ctx = { params: Promise<{ id: string }> };
export async function PATCH(req: Request, { params }: Ctx) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  const body = (await readJson(req)) ?? {};
  try {
    const page = await updatePage(a.user.id, id, body as Parameters<typeof updatePage>[2]);
    return Response.json({ page });
  } catch (e) { return apiError(e); }
}
export async function DELETE(req: Request, { params }: Ctx) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const { id } = await params;
  try {
    const r = await trashPage(a.user.id, id);
    await audit(a.user.id, 'page.trash', id, req);
    return Response.json(r);
  } catch (e) { return apiError(e); }
}
