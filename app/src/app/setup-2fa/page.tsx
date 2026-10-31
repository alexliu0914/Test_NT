import { requirePageUser } from '@/lib/server-guard';
import { redirect } from 'next/navigation';
import SetupTwoFactor from '@/components/SetupTwoFactor';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const a = await requirePageUser({ allowNo2fa: true });
  if (a.user.twoFactorEnabled) redirect('/');
  return <SetupTwoFactor email={a.user.email} />;
}
