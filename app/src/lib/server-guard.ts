// 伺服器端頁面的登入導向：未登入 → /login；尚未啟用兩步驟驗證 → /setup-2fa
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentSession, type Authed } from './guard';

export async function requirePageUser(opts: { allowNo2fa?: boolean } = {}): Promise<Authed> {
  const a = await currentSession(await headers());
  if (!a) redirect('/login');
  if (!a.user.twoFactorEnabled && !opts.allowNo2fa) redirect('/setup-2fa');
  return a;
}
