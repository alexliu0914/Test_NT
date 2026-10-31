// 登入失敗鎖定（計畫書 7.1、SEC-01）：同一帳號或同一 IP 在 15 分鐘內失敗 5 次，第 6 次起暫停 15 分鐘
// 帳號以輸入的 email 字串計算（不論帳號是否存在），因此鎖定訊息不會透露帳號是否存在。
import { pool } from './db';

export const WINDOW_MIN = 15;
export const MAX_FAILURES = 5;
export const LOCKED_MESSAGE = '登入嘗試次數過多，請 15 分鐘後再試';

// 反向代理（Caddy）把用戶端位址加在 X-Forwarded-For 最後；只取最後一個，避免用戶端自行偽造前面的值
export function clientIp(headers?: Headers | null): string {
  const xff = headers?.get('x-forwarded-for');
  if (xff) return xff.split(',').map(s => s.trim()).filter(Boolean).at(-1) || 'unknown';
  return headers?.get('x-real-ip') || 'unknown';
}

// 只計算「最近一次成功之後」且在時間窗內的失敗
const FAIL_SQL = `
  select count(*)::int as n from login_attempts a
  where a.success = false and a.created_at > now() - make_interval(mins => $2)
    and a.{key} = $1
    and a.created_at > coalesce((select max(created_at) from login_attempts s where s.success and s.{key} = $1), '-infinity')`;

export async function checkLocked(email: string, ip: string): Promise<boolean> {
  const byEmail = email ? (await pool.query(FAIL_SQL.replaceAll('{key}', 'email'), [email, WINDOW_MIN])).rows[0].n : 0;
  const byIp = ip !== 'unknown' ? (await pool.query(FAIL_SQL.replaceAll('{key}', 'ip'), [ip, WINDOW_MIN])).rows[0].n : 0;
  return byEmail >= MAX_FAILURES || byIp >= MAX_FAILURES;
}

export async function recordAttempt(email: string, ip: string, success: boolean): Promise<void> {
  await pool.query('insert into login_attempts(email, ip, success) values ($1, $2, $3)', [email, ip, success]);
}
