// 頁面樹：GET 取得（不含內容）、POST 建立
import { requireUser, jsonError, readJson, audit } from '@/lib/guard';
import { listTree, createPage, PageError } from '@/lib/pages';
export async function GET(req: Request) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  return Response.json({ pages: await listTree() }, { headers: { 'cache-control': 'no-store' } });
}
export async function POST(req: Request) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const body = (await readJson(req)) ?? {};
  try {
    const page = await createPage(a.user.id, body as Parameters<typeof createPage>[1]);
    await audit(a.user.id, 'page.create', page.id, req);
    return Response.json({ page }, { status: 201 });
  } catch (e) {
    if (e instanceof PageError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
