// 帳號建立：公開註冊關閉，只有兩條路（計畫書 7.1）
// 1. 部署時以指令建立第一個管理者（scripts/create-admin.mjs）
// 2. 管理者建立邀請連結（72 小時、只能用一次），受邀者設定密碼
import { createHash, randomBytes } from 'node:crypto';
import { auth } from './auth';
import { pool } from './db';
import { workspaceId } from './pages';

export const INVITE_HOURS = 72;
export class AccountError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 12) throw new AccountError(400, 'weak_password', '密碼至少 12 個字元');
  if (pw.length > 128) throw new AccountError(400, 'password_too_long', '密碼最多 128 個字元');
  return pw;
}

// 以 Better Auth 內部介面建立帳號與密碼（與官方註冊端點相同的兩個步驟：建立使用者、連結 credential 帳號）
export async function createUserWithPassword(email: string, name: string, password: string, role: 'admin' | 'member') {
  const ctx = await auth.$context;
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) throw new AccountError(400, 'bad_email', 'Email 格式不正確');
  validatePassword(password);
  if (await ctx.internalAdapter.findUserByEmail(normalized)) throw new AccountError(409, 'email_taken', '這個 Email 已經有帳號');
  const hash = await ctx.password.hash(password);
  const user = await ctx.internalAdapter.createUser({ email: normalized, name: name.trim() || normalized, emailVerified: true, role }, { method: 'email-password' });
  if (!user) throw new AccountError(500, 'create_failed', '建立帳號失敗');
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: hash });
  return user;
}

export async function createInvite(createdBy: string, email: unknown) {
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) throw new AccountError(400, 'bad_email', 'Email 格式不正確');
  const token = randomBytes(32).toString('base64url');
  const ws = await workspaceId();
  const r = await pool.query(
    `insert into invites(workspace_id, email, token_hash, expires_at, created_by)
     values ($1, $2, $3, now() + make_interval(hours => $4), $5) returning id, email, expires_at`,
    [ws, email.trim().toLowerCase(), sha256(token), INVITE_HOURS, createdBy]);
  return { token, invite: r.rows[0] };
}

// 先以單一 UPDATE 原子地「佔用」邀請（並行的兩次接受只會有一次成功），建立帳號失敗時再釋放
export async function acceptInvite(token: unknown, name: unknown, password: unknown) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new AccountError(400, 'invalid_invite', '邀請連結無效或已過期');
  validatePassword(password);
  const claim = await pool.query(
    `update invites set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning id, email`,
    [sha256(token)]);
  const inv = claim.rows[0];
  if (!inv) throw new AccountError(400, 'invalid_invite', '邀請連結無效或已過期');
  try {
    const user = await createUserWithPassword(inv.email, typeof name === 'string' ? name : '', password as string, 'member');
    return { user, email: inv.email };
  } catch (e) {
    await pool.query('update invites set used_at = null where id = $1', [inv.id]);
    throw e;
  }
}

export async function inviteInfo(token: string) {
  const r = await pool.query('select email, expires_at from invites where token_hash=$1 and used_at is null and expires_at > now()', [sha256(token)]);
  return r.rows[0] ? { email: r.rows[0].email as string, expiresAt: (r.rows[0].expires_at as Date).toISOString() } : null;
}
