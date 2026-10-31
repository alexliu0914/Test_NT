// 以邀請連結設定密碼並建立帳號（不需登入；同源檢查仍適用）
import { jsonError, readJson, sameOrigin, audit } from '@/lib/guard';
import { acceptInvite, AccountError } from '@/lib/accounts';
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return jsonError(403, 'bad_origin', '請求來源不正確');
  const { token } = await params;
  const body = await readJson<{ name?: string; password?: string }>(req);
  try {
    const { user, email } = await acceptInvite(token, body?.name, body?.password);
    await audit(user.id, 'invite.accept', email, req);
    return Response.json({ email }, { status: 201 });
  } catch (e) {
    if (e instanceof AccountError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
