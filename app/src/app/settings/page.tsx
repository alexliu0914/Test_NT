import { requirePageUser } from '@/lib/server-guard';
import Settings from '@/components/Settings';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const a = await requirePageUser();
  return <Settings user={a.user} />;
}
