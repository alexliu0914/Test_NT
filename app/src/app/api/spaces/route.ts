// 空間：GET 列出自己所屬的空間與成員；POST 建立共享空間（建立者自動成為成員）
import { requireUser, readJson, audit, apiError } from '@/lib/guard';
import { listSpaces } from '@/lib/pages';
import { createSpace } from '@/lib/spaces';
export async function GET(req: Request) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  return Response.json({ spaces: await listSpaces(a.user.id) }, { headers: { 'cache-control': 'no-store' } });
}
export async function POST(req: Request) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const body = (await readJson<{ name?: unknown }>(req)) ?? {};
  try {
    const space = await createSpace(a.user.id, body.name);
    await audit(a.user.id, 'space.create', space.id, req);
    return Response.json({ space }, { status: 201 });
  } catch (e) { return apiError(e); }
}
