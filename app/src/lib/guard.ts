// API 共用防護：登入檢查、兩步驟驗證檢查、同源檢查（SEC-03）、統一錯誤格式 { error: { code, message } }
import { auth } from './auth';
import { clientIp } from './lockout';
import { pool } from './db';

export type AuthedUser = { id: string; name: string; email: string; role: string; twoFactorEnabled: boolean };
export type Authed = { user: AuthedUser; sessionId: string };

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });
}

export async function currentSession(headers: Headers): Promise<Authed | null> {
  const s = await auth.api.getSession({ headers });
  if (!s) return null;
  const u = s.user as unknown as AuthedUser;
  return { user: { id: u.id, name: u.name, email: u.email, role: u.role || 'member', twoFactorEnabled: !!u.twoFactorEnabled }, sessionId: s.session.id };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// 變更型請求必須來自本站：Origin 必須存在且等於設定的網址（SameSite=Lax cookie 之外的第二道防線）
export function sameOrigin(req: Request): boolean {
  if (!MUTATING.has(req.method)) return true;
  const origin = req.headers.get('origin');
  const allowed = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL).origin : null;
  return !!origin && !!allowed && origin === allowed;
}

// 用在每個需要登入的 API：回傳使用者，或回傳應直接送出的錯誤回應
export async function requireUser(req: Request, { admin = false } = {}): Promise<Authed | Response> {
  if (!sameOrigin(req)) return jsonError(403, 'bad_origin', '請求來源不正確');
  const a = await currentSession(req.headers);
  if (!a) return jsonError(401, 'unauthenticated', '請先登入');
  if (!a.user.twoFactorEnabled) return jsonError(403, 'two_factor_required', '請先完成兩步驟驗證設定');
  if (admin && a.user.role !== 'admin') return jsonError(403, 'forbidden', '只有管理者可以執行');
  return a;
}

export async function audit(userId: string | null, action: string, target: string | null, req?: Request) {
  await pool.query('insert into audit_log(user_id, action, target, ip) values ($1,$2,$3,$4)',
    [userId, action, target, req ? clientIp(req.headers) : null]);
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try { const v = await req.json(); return v && typeof v === 'object' ? (v as T) : null; } catch { return null; }
}
