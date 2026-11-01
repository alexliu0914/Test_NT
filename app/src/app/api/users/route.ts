// 帳號清單（邀請共享空間成員用）：所有帳號的名字與信箱，不含其他資料
import { requireUser } from '@/lib/guard';
import { listUsers } from '@/lib/spaces';
export async function GET(req: Request) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  return Response.json({ users: await listUsers() }, { headers: { 'cache-control': 'no-store' } });
}
