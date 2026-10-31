import { notFound } from 'next/navigation';
import { requirePageUser } from '@/lib/server-guard';
import { UUID_RE } from '@/lib/pages';
import Workspace from '@/components/Workspace';

export const dynamic = 'force-dynamic';

export default async function PagePage({ params }: { params: Promise<{ id: string }> }) {
  const a = await requirePageUser();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  return <Workspace user={a.user} pageId={id.toLowerCase()} />;
}
