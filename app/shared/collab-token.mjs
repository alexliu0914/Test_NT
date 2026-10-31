// 協作憑證（計畫書 API：POST /api/pages/:id/collab-token，5 分鐘有效）
// 內容：session id、user id、page id、到期時間；以 COLLAB_SECRET 做 HMAC-SHA256 簽章。
// 協作伺服器只接受「簽章正確、未過期、頁面相符」的憑證，並另外確認 session 仍存在。
import { createHmac, timingSafeEqual } from 'node:crypto';

export const COLLAB_TOKEN_TTL_MS = 5 * 60 * 1000;

const b64u = buf => Buffer.from(buf).toString('base64url');

function secret(s) {
  const k = s ?? process.env.COLLAB_SECRET;
  if (!k || k.length < 32) throw new Error('COLLAB_SECRET 未設定或長度不足 32');
  return k;
}

export function signCollabToken({ sid, uid, pid, name, ttlMs = COLLAB_TOKEN_TTL_MS, now = Date.now() }, key) {
  const payload = b64u(JSON.stringify({ v: 1, sid, uid, pid, name, exp: now + ttlMs }));
  const sig = b64u(createHmac('sha256', secret(key)).update(payload).digest());
  return `${payload}.${sig}`;
}

// 回傳 { ok: true, claims } 或 { ok: false, reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_page' }
export function verifyCollabToken(token, pid, { now = Date.now(), key } = {}) {
  if (typeof token !== 'string' || token.length > 4096) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payload, sig] = parts;
  const expect = createHmac('sha256', secret(key)).update(payload).digest();
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { return { ok: false, reason: 'malformed' }; }
  if (given.length !== expect.length || !timingSafeEqual(given, expect)) return { ok: false, reason: 'bad_signature' };
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (claims.v !== 1 || typeof claims.exp !== 'number') return { ok: false, reason: 'malformed' };
  if (claims.exp <= now) return { ok: false, reason: 'expired' };
  if (claims.pid !== pid) return { ok: false, reason: 'wrong_page' };
  return { ok: true, claims };
}
