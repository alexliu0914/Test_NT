// 頁面樹：GET 取得使用者看得到的空間與頁面（不含內容）、POST 建立
import { requireUser, readJson, audit, apiError } from '@/lib/guard';
import { listTree, listSpaces, createPage } from '@/lib/pages';
export async function GET(req: Request) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const [spaces, pages] = await Promise.all([listSpaces(a.user.id), listTree(a.user.id)]);
  return Response.json({ spaces, pages }, { headers: { 'cache-control': 'no-store' } });
}
export async function POST(req: Request) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const body = (await readJson(req)) ?? {};
  try {
    const page = await createPage(a.user.id, body as Parameters<typeof createPage>[1]);
    await audit(a.user.id, 'page.create', page.id, req);
    return Response.json({ page }, { status: 201 });
  } catch (e) { return apiError(e); }
}
