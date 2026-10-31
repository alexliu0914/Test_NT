// 首頁：導向第一個頁面；沒有任何頁面時顯示空白工作區
import { redirect } from 'next/navigation';
import { requirePageUser } from '@/lib/server-guard';
import { listTree } from '@/lib/pages';
import WorkspaceShell from '@/components/WorkspaceShell';
import EmptyWorkspace from '@/components/EmptyWorkspace';

export const dynamic = 'force-dynamic';

export default async function Home() {
  await requirePageUser();
  const pages = await listTree();
  const first = pages.find(p => p.parentId === null);
  if (first) redirect(`/p/${first.id}`);
  return <WorkspaceShell><EmptyWorkspace /></WorkspaceShell>;
}
