import { inviteInfo } from '@/lib/accounts';
import AcceptInvite from '@/components/AcceptInvite';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = token.length >= 20 && token.length <= 100 ? await inviteInfo(token) : null;
  return <AcceptInvite token={token} email={info?.email ?? null} />;
}
