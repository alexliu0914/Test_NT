// 垃圾桶：只列出使用者所屬空間的批次
import { requireUser } from '@/lib/guard';
import { listTrash, TRASH_DAYS } from '@/lib/pages';
export async function GET(req: Request) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  return Response.json({ items: await listTrash(a.user.id), retentionDays: TRASH_DAYS }, { headers: { 'cache-control': 'no-store' } });
}
