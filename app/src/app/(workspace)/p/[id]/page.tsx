import { notFound } from 'next/navigation';
import { requirePageUser } from '@/lib/server-guard';
import { UUID_RE } from '@/lib/pages';
import PageView from '@/components/PageView';

export const dynamic = 'force-dynamic';

export default async function PagePage({ params }: { params: Promise<{ id: string }> }) {
  const a = await requirePageUser();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  return <PageView pageId={id.toLowerCase()} user={{ id: a.user.id, name: a.user.name }} />;
}
