// Better Auth 設定（計畫書 7.1）
// - 帳號只能由管理者指令或邀請連結建立：公開註冊端點關閉
// - 密碼至少 12 字元，Better Auth 預設以 scrypt（記憶體困難）雜湊
// - 兩步驟驗證：TOTP＋10 組一次性備援碼；未啟用前不能使用工作區（由 guard 強制）
// - Session：HttpOnly、SameSite=Lax cookie，30 天未使用即失效（每天延長一次）
// - 登入失敗鎖定：同一帳號或 IP 在 15 分鐘內失敗 5 次，暫停 15 分鐘（lockout.ts）
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { db } from './db';
import * as schema from './schema';
import { checkLocked, recordAttempt, clientIp, LOCKED_MESSAGE } from './lockout';

const DAY = 60 * 60 * 24;

export const auth = betterAuth({
  appName: 'Notes',
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: process.env.BETTER_AUTH_URL ? [process.env.BETTER_AUTH_URL] : [],
  telemetry: { enabled: false },
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    autoSignIn: false,
  },
  user: {
    additionalFields: {
      role: { type: 'string', required: false, defaultValue: 'member', input: false },
    },
  },
  session: {
    expiresIn: 30 * DAY,
    updateAge: DAY,
  },
  advanced: {
    useSecureCookies: (process.env.BETTER_AUTH_URL || '').startsWith('https://'),
  },
  // 我們自己的鎖定規則已涵蓋登入；Better Auth 內建的速率限制在測試中會干擾，關閉以免兩套規則互相影響
  rateLimit: { enabled: false },
  hooks: {
    before: createAuthMiddleware(async ctx => {
      if (ctx.path !== '/sign-in/email') return;
      const email = String((ctx.body as { email?: string } | undefined)?.email || '').toLowerCase();
      const ip = clientIp(ctx.request?.headers);
      if (await checkLocked(email, ip)) {
        throw new APIError('TOO_MANY_REQUESTS', { message: LOCKED_MESSAGE, code: 'LOGIN_LOCKED' });
      }
    }),
    after: createAuthMiddleware(async ctx => {
      if (ctx.path !== '/sign-in/email') return;
      const email = String((ctx.body as { email?: string } | undefined)?.email || '').toLowerCase();
      const ip = clientIp(ctx.request?.headers);
      const failed = ctx.context.returned instanceof APIError;
      // 鎖定中的請求不再累計（否則鎖定會被自己延長）
      if (failed && (ctx.context.returned as APIError).body?.code === 'LOGIN_LOCKED') return;
      await recordAttempt(email, ip, !failed);
    }),
  },
  plugins: [
    twoFactor({
      issuer: 'Notes',
      backupCodeOptions: { amount: 10, length: 10 },
      accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 15 * 60 },
    }),
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
