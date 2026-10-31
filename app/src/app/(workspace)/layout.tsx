// 工作區外框：首頁與 /p/* 共用同一個側邊欄，在兩者之間切換時不會重新掛載（F-M1-03）
import { requirePageUser } from '@/lib/server-guard';
import WorkspaceShell from '@/components/WorkspaceShell';
export const dynamic = 'force-dynamic';
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePageUser();
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
