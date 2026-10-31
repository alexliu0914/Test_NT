// 建立邀請連結（管理者）
import { requireUser, jsonError, audit, readJson } from '@/lib/guard';
import { createInvite, AccountError, INVITE_HOURS } from '@/lib/accounts';
export async function POST(req: Request) {
  const a = await requireUser(req, { admin: true });
  if (a instanceof Response) return a;
  const body = await readJson<{ email?: string }>(req);
  try {
    const { token, invite } = await createInvite(a.user.id, body?.email);
    await audit(a.user.id, 'invite.create', invite.email, req);
    const base = process.env.BETTER_AUTH_URL || new URL(req.url).origin;
    return Response.json({ url: `${base}/invite/${token}`, email: invite.email, expiresAt: invite.expires_at, hours: INVITE_HOURS }, { status: 201 });
  } catch (e) {
    if (e instanceof AccountError) return jsonError(e.status, e.code, e.message);
    throw e;
  }
}
