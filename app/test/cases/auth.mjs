// 認證與安全：AUTH-01～07、SEC-01／02／03／05／06（計畫書 11.3；SEC-02、SEC-06 也是第四輪審核要求以正式認證重跑的項目）
import WS from 'ws';
import { db, Agent, PASSWORD, signIn, newDevice, newPage, collabToken, totp, SECRETS, sleep, enableTwoFactor, removeUsersExcept } from '../lib/harness.mjs';
import { Recorder, runRound, within } from '../lib/recorder.mjs';
import { bootEnv, COLLAB_PORT } from '../lib/env.mjs';
import { signCollabToken } from '../../shared/collab-token.mjs';

const cookieAttrs = res => res.headers.getSetCookie().find(c => c.includes('session_token')) || '';

async function invite(admin, email) {
  const r = await admin.post('/api/invites', { email });
  if (r.status !== 201) throw new Error('invite ' + r.status + r.text);
  return new URL(r.json.url).pathname.split('/').pop();
}

// 以原始 WebSocket 連協作伺服器：回傳第一個訊息類型或關閉代碼
export function probeCollab(docId, token, url = `ws://127.0.0.1:${COLLAB_PORT}`) {
  return new Promise(resolve => {
    const ws = new WS(url);
    const t = setTimeout(() => { ws.terminate(); resolve({ timeout: true }); }, 5000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', docId, token })));
    ws.on('message', d => { const m = JSON.parse(d.toString()); clearTimeout(t); resolve({ msg: m.t, ws }); });
    ws.on('close', code => { clearTimeout(t); resolve({ code }); });
    ws.on('error', () => {});
  });
}

// ---- AUTH-01 正確帳密＋驗證碼登入，進入工作區；cookie 屬性 ----
export async function auth01(n) {
  const rec = new Recorder('AUTH-01', '正確帳號密碼＋驗證碼登入後進入工作區；session cookie 為 HttpOnly、SameSite=Lax、30 天');
  const env = await bootEnv({ users: 2 });
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      const u = env.users[i % 2];
      const ag = new Agent(env.base);
      const r1 = await ag.post('/api/auth/sign-in/email', { email: u.email, password: PASSWORD });
      if (!r1.json?.twoFactorRedirect) fails.push('已啟用兩步驟驗證，密碼後應要求驗證碼');
      const res = await fetch(env.base + '/api/auth/two-factor/verify-totp', { method: 'POST', headers: { 'content-type': 'application/json', origin: env.base, cookie: ag.cookieHeader() }, body: JSON.stringify({ code: totp(u.secret) }) });
      ag.store(res);
      const c = cookieAttrs(res);
      if (res.status !== 200) fails.push('驗證碼登入失敗 ' + res.status);
      if (!/HttpOnly/i.test(c)) fails.push('session cookie 不是 HttpOnly');
      if (!/SameSite=Lax/i.test(c)) fails.push('session cookie 不是 SameSite=Lax');
      const maxAge = Number((c.match(/Max-Age=(\d+)/i) || [])[1]);
      if (Math.abs(maxAge - 30 * 86400) > 120) fails.push('session 有效期不是 30 天：' + maxAge);
      const home = await ag.get('/');
      if (home.status !== 200 && !(home.status >= 300 && home.status < 400 && /\/p\//.test(home.headers.get('location') || ''))) fails.push('首頁沒有進入工作區 ' + home.status + ' ' + home.headers.get('location'));
      if ((await ag.get('/api/pages')).status !== 200) fails.push('登入後無法讀取頁面樹');
      return [fails];
    });
  }
  return rec.save();
}

// ---- AUTH-02 錯誤密碼與不存在的帳號：相同錯誤，不透露帳號是否存在 ----
export async function auth02(n) {
  const rec = new Recorder('AUTH-02', '錯誤密碼與不存在的帳號回應相同');
  const env = await bootEnv({ users: 2 });
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      await db.query('delete from login_attempts');
      const fails = [];
      const a = await new Agent(env.base).post('/api/auth/sign-in/email', { email: env.users[1].email, password: 'wrong password ' + i });
      const b = await new Agent(env.base).post('/api/auth/sign-in/email', { email: `nobody${i}@example.test`, password: 'wrong password ' + i });
      if (a.status !== b.status) fails.push(`狀態碼不同 ${a.status} / ${b.status}`);
      if (JSON.stringify(a.json) !== JSON.stringify(b.json)) fails.push(`錯誤內容不同 ${a.text} / ${b.text}`);
      if (a.status < 400) fails.push('錯誤密碼竟然成功');
      if (a.headers.getSetCookie().some(c => c.includes('session_token=') && !/Max-Age=0/i.test(c))) fails.push('失敗時發出了 session cookie');
      return [fails, { status: a.status }];
    });
  }
  return rec.save();
}

// ---- AUTH-03 未經邀請直接建立帳號 ----
export async function auth03(n) {
  const rec = new Recorder('AUTH-03', '未經邀請直接呼叫建立帳號 API：拒絕，沒有帳號被建立');
  const env = await bootEnv({ users: 1 });
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      const before = (await db.query('select count(*)::int as n from "user"')).rows[0].n;
      const ag = new Agent(env.base);
      const s = await ag.post('/api/auth/sign-up/email', { email: `intruder${i}@example.test`, password: 'intruder password 123', name: 'x' });
      if (s.status < 400) fails.push('公開註冊端點沒有被拒絕 ' + s.status);
      const fake = await ag.post(`/api/invites/${'x'.repeat(43)}/accept`, { name: 'x', password: 'intruder password 123' });
      if (fake.status !== 400) fails.push('偽造邀請沒有被拒絕 ' + fake.status);
      const after = (await db.query('select count(*)::int as n from "user"')).rows[0].n;
      if (after !== before) fails.push(`帳號數改變 ${before} → ${after}`);
      return [fails, { signUpStatus: s.status }];
    });
  }
  return rec.save();
}

// ---- AUTH-04 邀請連結第二次使用、過期、同時使用 ----
export async function auth04(n) {
  const rec = new Recorder('AUTH-04', '邀請連結第二次使用或過期後使用：拒絕；同時使用兩次只成功一次');
  const env = await bootEnv({ users: 1 });
  const admin = env.users[0].agent;
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      await removeUsersExcept(env.users);   // M2-s：最多四個帳號，刪除前幾輪建立的帳號（T-M2-03）
      const t1 = await invite(admin, `reuse${i}@example.test`);
      const a = await new Agent(env.base).post(`/api/invites/${t1}/accept`, { name: 'a', password: PASSWORD });
      const b = await new Agent(env.base).post(`/api/invites/${t1}/accept`, { name: 'b', password: PASSWORD });
      if (a.status !== 201) fails.push('第一次使用失敗 ' + a.status);
      if (b.status !== 400) fails.push('第二次使用沒有被拒絕 ' + b.status);
      const t2 = await invite(admin, `expired${i}@example.test`);
      await db.query(`update invites set expires_at = now() - interval '1 minute' where email = $1`, [`expired${i}@example.test`]);
      const c = await new Agent(env.base).post(`/api/invites/${t2}/accept`, { name: 'c', password: PASSWORD });
      if (c.status !== 400) fails.push('過期邀請沒有被拒絕 ' + c.status);
      const t3 = await invite(admin, `race${i}@example.test`);
      const rs = await Promise.all([0, 1, 2].map(() => new Agent(env.base).post(`/api/invites/${t3}/accept`, { name: 'r', password: PASSWORD })));
      const ok = rs.filter(r => r.status === 201).length;
      if (ok !== 1) fails.push('同時使用成功次數 ' + ok);
      const users = (await db.query(`select count(*)::int as n from "user" where email = any($1)`, [[`expired${i}@example.test`, `race${i}@example.test`]])).rows[0].n;
      if (users !== 1) fails.push('建立的帳號數不正確 ' + users);
      return [fails];
    });
  }
  return rec.save();
}

// ---- AUTH-05 啟用 TOTP 後只輸入密碼；備援碼兩次 ----
export async function auth05(n) {
  const rec = new Recorder('AUTH-05', '啟用 TOTP 後只輸入密碼會要求驗證碼；同一組備援碼第二次失效；錯誤驗證碼被拒');
  const env = await bootEnv({ users: 2 });
  const u = env.users[1];
  for (let i = 0; i < Math.min(n, 9); i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      const ag = new Agent(env.base);
      const p = await ag.post('/api/auth/sign-in/email', { email: u.email, password: PASSWORD });
      if (!p.json?.twoFactorRedirect) fails.push('只輸入密碼沒有要求驗證碼');
      if ((await ag.get('/api/pages')).status !== 401) fails.push('只輸入密碼就能讀取資料');
      const bad = await ag.post('/api/auth/two-factor/verify-totp', { code: totp(u.secret, Date.now() + 10 * 60 * 1000) });
      if (bad.status === 200) fails.push('錯誤的驗證碼被接受');
      const code = u.backupCodes[i];
      const ok = await ag.post('/api/auth/two-factor/verify-backup-code', { code });
      if (ok.status !== 200) fails.push('備援碼第一次使用失敗 ' + ok.status + ok.text);
      if ((await ag.get('/api/pages')).status !== 200) fails.push('備援碼登入後無法讀取資料');
      const ag2 = new Agent(env.base);
      await ag2.post('/api/auth/sign-in/email', { email: u.email, password: PASSWORD });
      const again = await ag2.post('/api/auth/two-factor/verify-backup-code', { code });
      if (again.status === 200) fails.push('同一組備援碼第二次仍可使用');
      return [fails];
    });
  }
  return rec.save();
}

// ---- AUTH-06 未完成兩步驟驗證：不能使用工作區、API、協作 ----
export async function auth06(n) {
  const rec = new Recorder('AUTH-06', '尚未設定兩步驟驗證：工作區導向設定頁，API 與協作憑證被拒');
  const env = await bootEnv({ users: 1 });
  const admin = env.users[0].agent;
  const pid = await newPage(admin);
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      await removeUsersExcept(env.users);   // M2-s：最多四個帳號（T-M2-03）
      const email = `no2fa${i}@example.test`;
      const t = await invite(admin, email);
      await new Agent(env.base).post(`/api/invites/${t}/accept`, { name: 'n', password: PASSWORD });
      const ag = new Agent(env.base);
      const s = await signIn(ag, email);
      if (s.status !== 200 || s.json?.twoFactorRedirect) fails.push('首次登入（尚未設定）應直接取得受限 session');
      const api = await ag.get('/api/pages');
      if (api.status !== 403 || api.json?.error?.code !== 'two_factor_required') fails.push('未設定兩步驟驗證仍可讀取頁面 ' + api.status);
      const tok = await ag.post(`/api/pages/${pid}/collab-token`);
      if (tok.status !== 403) fails.push('未設定兩步驟驗證仍可取得協作憑證 ' + tok.status);
      const home = await ag.get('/');
      if (!(home.status >= 300 && home.status < 400 && (home.headers.get('location') || '').includes('/setup-2fa'))) fails.push('首頁沒有導向兩步驟驗證設定 ' + home.status);
      // 即使拿到有效簽章的憑證，協作伺服器也要拒絕未啟用兩步驟驗證的帳號
      const sess = (await db.query(`select s.id, s.user_id from "session" s join "user" u on u.id = s.user_id where u.email=$1 order by s.created_at desc limit 1`, [email])).rows[0];
      const forged = signCollabToken({ sid: sess.id, uid: sess.user_id, pid }, SECRETS.COLLAB_SECRET);
      const pr = await probeCollab(pid, forged);
      if (pr.code !== 4001) fails.push('協作伺服器接受了未啟用兩步驟驗證的帳號 ' + JSON.stringify({ code: pr.code, msg: pr.msg }));
      if (pr.ws) pr.ws.terminate();
      await enableTwoFactor(ag);
      if ((await ag.get('/api/pages')).status !== 200) fails.push('完成設定後仍無法使用');
      return [fails];
    });
  }
  return rec.save();
}

// ---- AUTH-07 密碼規則 ----
export async function auth07(n) {
  const rec = new Recorder('AUTH-07', '密碼少於 12 或多於 128 個字元被拒，邀請不因此失效');
  const env = await bootEnv({ users: 1 });
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      await removeUsersExcept(env.users);   // M2-s：最多四個帳號（T-M2-03）
      const t = await invite(env.users[0].agent, `pw${i}@example.test`);
      const short = await new Agent(env.base).post(`/api/invites/${t}/accept`, { name: 'p', password: 'a'.repeat(11) });
      const long = await new Agent(env.base).post(`/api/invites/${t}/accept`, { name: 'p', password: 'a'.repeat(129) });
      if (short.status !== 400) fails.push('11 字元密碼沒有被拒 ' + short.status);
      if (long.status !== 400) fails.push('129 字元密碼沒有被拒 ' + long.status);
      const ok = await new Agent(env.base).post(`/api/invites/${t}/accept`, { name: 'p', password: 'a'.repeat(12) });
      if (ok.status !== 201) fails.push('密碼被拒後邀請失效 ' + ok.status);
      return [fails];
    });
  }
  return rec.save();
}

// ---- SEC-01 15 分鐘內登入失敗 6 次 ----
export async function sec01(n) {
  const rec = new Recorder('SEC-01', '同一帳號或 IP 在 15 分鐘內失敗 5 次，第 6 次起暫停（即使密碼正確）；15 分鐘後恢復');
  const env = await bootEnv({ users: 2 });
  const u = env.users[1];
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      await db.query('delete from login_attempts');
      const fails = [];
      const ip = h => ({ headers: { 'x-forwarded-for': h } });
      // 帳號：5 次錯誤（每次不同 IP）後，第 6 次即使密碼正確也被擋
      for (let k = 0; k < 5; k++) await new Agent(env.base).req('POST', '/api/auth/sign-in/email', { email: u.email, password: 'nope nope nope' }, ip(`10.1.${i}.${k}`));
      const locked = await new Agent(env.base).req('POST', '/api/auth/sign-in/email', { email: u.email, password: PASSWORD }, ip(`10.2.${i}.1`));
      if (locked.status !== 429) fails.push('帳號鎖定沒有生效 ' + locked.status);
      // 鎖定訊息對不存在的帳號也一樣（不透露帳號是否存在）
      for (let k = 0; k < 5; k++) await new Agent(env.base).req('POST', '/api/auth/sign-in/email', { email: `ghost${i}@example.test`, password: 'x'.repeat(12) }, ip(`10.3.${i}.${k}`));
      const ghost = await new Agent(env.base).req('POST', '/api/auth/sign-in/email', { email: `ghost${i}@example.test`, password: 'x'.repeat(12) }, ip(`10.4.${i}.1`));
      if (ghost.status !== 429 || ghost.json?.message !== locked.json?.message) fails.push('不存在帳號的鎖定回應與真實帳號不同');
      // 15 分鐘後恢復
      await db.query(`update login_attempts set created_at = created_at - interval '16 minutes'`);
      const after = await new Agent(env.base).req('POST', '/api/auth/sign-in/email', { email: u.email, password: PASSWORD }, ip(`10.5.${i}.1`));
      if (after.status !== 200) fails.push('15 分鐘後仍無法登入 ' + after.status);
      // IP：同一 IP 對不同帳號失敗 5 次後，該 IP 被擋；其他 IP 不受影響
      await db.query('delete from login_attempts');
      const evil = `10.9.${i}.9`;
      for (let k = 0; k < 5; k++) await new Agent(env.base).req('POST', '/api/auth/sign-in/email', { email: `spray${k}@example.test`, password: 'x'.repeat(12) }, ip(evil));
      const fromEvil = await new Agent(env.base).req('POST', '/api/auth/sign-in/email', { email: u.email, password: PASSWORD }, ip(evil));
      if (fromEvil.status !== 429) fails.push('IP 鎖定沒有生效 ' + fromEvil.status);
      const fromOther = await new Agent(env.base).req('POST', '/api/auth/sign-in/email', { email: u.email, password: PASSWORD }, ip(`10.8.${i}.8`));
      if (fromOther.status !== 200) fails.push('其他 IP 被誤擋 ' + fromOther.status);
      return [fails];
    });
  }
  return rec.save();
}

// ---- SEC-02 從設定頁登出另一台裝置（含協作連線，第四輪審核要求以正式認證重跑） ----
export async function sec02(n) {
  const rec = new Recorder('SEC-02', '撤銷另一台裝置：下一個請求即失效，協作連線 2 秒內以 4001 中斷；登出其他所有裝置');
  const env = await bootEnv({ users: 2 });
  const A = env.users[0];
  const pid = await newPage(A.agent);
  const lat = [];
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      const dev2 = await newDevice(env.base, A);
      const tok = await collabToken(dev2, pid);
      const pr = await probeCollab(pid, tok);
      if (pr.msg !== 'welcome') fails.push('協作連線沒有建立 ' + JSON.stringify(pr));
      const closed = pr.ws ? new Promise(r => pr.ws.on('close', code => r(code))) : Promise.resolve(null);
      const list = (await A.agent.get('/api/sessions')).json.sessions;
      const target = list.find(s => !s.current && s.lastActiveAt);
      const sid = (await db.query(`select id from "session" where token = $1`, [decodeURIComponent(dev2.cookies.get('better-auth.session_token') || '').split('.')[0]])).rows[0]?.id || target?.id;
      const t0 = Date.now();
      const del = await A.agent.del(`/api/sessions/${sid}`);
      if (del.status !== 200) fails.push('撤銷失敗 ' + del.status);
      if ((await dev2.get('/api/pages')).status !== 401) fails.push('被撤銷的裝置下一個請求仍有效');
      const code = await within(closed, 3000, 'collab close').catch(() => 'timeout');
      const ms = Date.now() - t0;
      lat.push(ms);
      if (code !== 4001) fails.push('協作連線沒有以 4001 中斷：' + code);
      if (ms > 2000) fails.push('協作連線中斷超過 2 秒：' + ms);
      if ((await A.agent.get('/api/pages')).status !== 200) fails.push('撤銷別台後自己也被登出');
      // 登出其他所有裝置
      const d3 = await newDevice(env.base, A), d4 = await newDevice(env.base, A);
      const ro = await A.agent.post('/api/sessions/revoke-others');
      if (ro.status !== 200) fails.push('登出其他裝置失敗 ' + ro.status);
      if ((await d3.get('/api/pages')).status !== 401 || (await d4.get('/api/pages')).status !== 401) fails.push('登出其他裝置後仍有裝置有效');
      if ((await A.agent.get('/api/pages')).status !== 200) fails.push('登出其他裝置時把自己也登出');
      return [fails, { closeMs: ms }];
    });
  }
  lat.sort((a, b) => a - b);
  return rec.save({ latency: { p50: lat[Math.floor(lat.length / 2)], max: lat.at(-1) } });
}

// ---- SEC-03 從其他網域送出變更型請求 ----
export async function sec03(n) {
  const rec = new Recorder('SEC-03', '其他網域或缺少 Origin 的變更型請求被拒，且沒有產生任何變更');
  const env = await bootEnv({ users: 2 });
  const A = env.users[0];
  const pid = await newPage(A.agent, '原標題');
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      for (const origin of ['https://evil.example', null]) {
        const o = { origin };
        const tag = origin || '無 Origin';
        const tries = [
          ['POST', '/api/pages', { title: 'evil' }], ['PATCH', `/api/pages/${pid}`, { title: 'evil' }], ['DELETE', `/api/pages/${pid}`],
          ['POST', '/api/invites', { email: 'evil@example.test' }], ['POST', '/api/sessions/revoke-others', {}],
        ];
        for (const [m, p, b] of tries) {
          const r = await A.agent.req(m, p, b, o);
          if (r.status !== 403) fails.push(`${tag} ${m} ${p} 沒有被拒 ${r.status}`);
        }
        const so = await A.agent.req('POST', '/api/auth/sign-out', {}, o);
        if (so.status !== 403) fails.push(`${tag} 登出請求沒有被拒 ${so.status}`);
      }
      const page = (await A.agent.get('/api/pages')).json.pages.find(p => p.id === pid);
      if (!page || page.title !== '原標題') fails.push('跨站請求改變了資料');
      if ((await db.query(`select count(*)::int as n from invites where email='evil@example.test'`)).rows[0].n) fails.push('跨站請求建立了邀請');
      return [fails];
    });
  }
  return rec.save();
}

// ---- SEC-05 未登入呼叫每一個 API；一般成員呼叫管理者 API ----
export async function sec05(n) {
  const rec = new Recorder('SEC-05', '未登入呼叫每個 API 端點都被拒（health 除外且不含資料）；一般成員不能建立邀請');
  const env = await bootEnv({ users: 2 });
  const pid = await newPage(env.users[0].agent);
  const sp = env.shared;
  const sid = (await db.query('select id from "session" limit 1')).rows[0].id;
  const endpoints = [
    ['GET', '/api/pages'], ['POST', '/api/pages', {}], ['PATCH', `/api/pages/${pid}`, { title: 'x' }], ['DELETE', `/api/pages/${pid}`],
    ['POST', `/api/pages/${pid}/restore`, {}], ['GET', '/api/pages/trash'], ['GET', '/api/pages/events'], ['POST', `/api/pages/${pid}/collab-token`, {}],
    ['GET', '/api/sessions'], ['DELETE', `/api/sessions/${sid}`], ['POST', '/api/sessions/revoke-others', {}], ['POST', '/api/invites', { email: 'x@example.test' }],
    // M2-s：空間相關的新 API
    ['GET', '/api/spaces'], ['POST', '/api/spaces', { name: 'x' }], ['PATCH', `/api/spaces/${sp}`, { name: 'x' }], ['DELETE', `/api/spaces/${sp}`],
    ['POST', `/api/spaces/${sp}/members`, { userId: 'x' }], ['DELETE', `/api/spaces/${sp}/members/x`], ['POST', `/api/spaces/${sp}/leave`, {}],
    ['GET', '/api/users'], ['GET', `/api/pages/${pid}/move-preview?space=${sp}`],
    // M2-c：版本紀錄（只讀）
    ['GET', `/api/pages/${pid}/versions`], ['GET', `/api/pages/${pid}/versions/v1`], ['GET', `/api/pages/${pid}/conflicts/c1`],
  ];
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      const anon = new Agent(env.base);
      for (const [m, p, b] of endpoints) {
        const r = await anon.req(m, p, b);
        if (r.status !== 401) fails.push(`未登入 ${m} ${p} → ${r.status}`);
      }
      const h = await anon.get('/api/health');
      if (h.status !== 200 || JSON.stringify(h.json) !== '{"ok":true}') fails.push('health 回應含有其他內容 ' + h.text);
      for (const p of ['/', `/p/${pid}`, '/settings']) {
        const r = await anon.get(p);
        if (!(r.status >= 300 && r.status < 400 && (r.headers.get('location') || '').includes('/login'))) fails.push(`未登入開啟 ${p} 沒有導向登入 ${r.status}`);
      }
      const member = await env.users[1].agent.post('/api/invites', { email: `m${i}@example.test` });
      if (member.status !== 403) fails.push('一般成員可以建立邀請 ' + member.status);
      return [fails];
    });
  }
  return rec.save();
}

// ---- SEC-06 以過期、竄改或其他頁面的憑證連協作伺服器 ----
export async function sec06(n) {
  const rec = new Recorder('SEC-06', '過期、竄改、其他頁面、錯誤金鑰、已撤銷 session、已刪除頁面的協作憑證都被拒');
  const env = await bootEnv({ users: 2 });
  const A = env.users[0];
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      const p1 = await newPage(A.agent), p2 = await newPage(A.agent);
      const s = (await db.query(`select s.id, s.user_id from "session" s join "user" u on u.id=s.user_id where u.email=$1 order by s.updated_at desc limit 1`, [A.email])).rows[0];
      const good = await collabToken(A.agent, p1);
      const cases = {
        valid: [good, 'welcome'],
        expired: [signCollabToken({ sid: s.id, uid: s.user_id, pid: p1, ttlMs: -1000 }, SECRETS.COLLAB_SECRET), 4003],
        tampered: [good.slice(0, -2) + (good.at(-2) === 'A' ? 'BB' : 'AA'), 4003],
        otherPage: [await collabToken(A.agent, p2), 4003],
        wrongKey: [signCollabToken({ sid: s.id, uid: s.user_id, pid: p1 }, 'k'.repeat(48)), 4003],
        garbage: ['not-a-token', 4003],
      };
      for (const [name, [tok, expect]] of Object.entries(cases)) {
        const r = await probeCollab(p1, tok);
        const got = r.msg || r.code;
        if (got !== expect) fails.push(`${name}: 預期 ${expect}，實際 ${got}`);
        if (r.ws) r.ws.terminate();
      }
      // 已撤銷 session 的憑證
      const dev = await newDevice(env.base, A);
      const tok = await collabToken(dev, p1);
      await db.query(`delete from "session" where token = $1`, [decodeURIComponent(dev.cookies.get('better-auth.session_token') || '').split('.')[0]]);
      const rv = await probeCollab(p1, tok);
      if (rv.code !== 4001) fails.push('已撤銷 session 的憑證未被拒：' + (rv.msg || rv.code));
      // 已移到垃圾桶的頁面：不能再取得憑證；先前取得的憑證連線也被拒
      const tok3 = await collabToken(A.agent, p2);
      await A.agent.del(`/api/pages/${p2}`);
      if ((await A.agent.post(`/api/pages/${p2}/collab-token`)).status !== 404) fails.push('垃圾桶中的頁面仍可取得協作憑證');
      const pc = await probeCollab(p2, tok3);
      if (pc.code !== 4004) fails.push('垃圾桶中的頁面仍可連線：' + (pc.msg || pc.code));
      return [fails];
    });
  }
  return rec.save();
}

export { sleep };
