import { requirePageUser } from '@/lib/server-guard';
import WorkspaceShell from '@/components/WorkspaceShell';
export const dynamic = 'force-dynamic';
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePageUser();
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
