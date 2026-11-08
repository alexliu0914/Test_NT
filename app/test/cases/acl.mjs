// M2-s 空間與權限：ACL-01～03（API／協作伺服器層，四個帳號）、AUTH-08（帳號上限）
// 規則：使用者是頁面所屬空間的成員，才能讀或寫這個頁面；無權限一律回應「不存在」，不透露頁面是否存在（M2-s 增修文件「授權規則」）
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import WS from 'ws';
import * as Y from 'yjs';
import { db, Agent, PASSWORD, APP_DIR, DB_URL, SECRETS, sleep, newPage, collabToken, removeUsersExcept, createSharedSpace } from '../lib/harness.mjs';
import { Recorder, runRound, rng, within } from '../lib/recorder.mjs';
import { bootEnv, COLLAB_PORT } from '../lib/env.mjs';
import { signCollabToken } from '../../shared/collab-token.mjs';
import { Client } from '../../shared/client.js';
import { tokensOf } from '../../shared/doc.js';
import { probeCollab } from './auth.mjs';
import { loadFromDb } from '../lib/m0-compat.mjs';

// ---- 共用 ----

// SSE：記錄每一次 changed 事件的時間
export function sse(base, agent) {
  const ctrl = new AbortController();
  const events = [];
  const waiters = [];
  let ready;
  const readyP = new Promise(r => { ready = r; });
  (async () => {
    const res = await fetch(base + '/api/pages/events', { headers: { cookie: agent.cookieHeader() }, signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, k); buf = buf.slice(k + 2);
        if (ev.includes('event: ready')) ready();
        if (ev.includes('event: changed')) { const t = Date.now(); events.push(t); waiters.splice(0).forEach(w => w(t)); }
      }
    }
  })().catch(() => {});
  return {
    ready: readyP, events,
    next: (ms = 2000) => Promise.race([new Promise(r => waiters.push(r)), sleep(ms).then(() => null)]),
    since: t => events.filter(x => x >= t).length,
    close: () => ctrl.abort(),
  };
}

const tree = async ag => (await ag.get('/api/pages')).json;
const pageIds = async ag => new Set((await tree(ag)).pages.map(p => p.id));
const spaceIds = async ag => new Set((await tree(ag)).spaces.map(s => s.id));
const personalOf = async uid => (await db.query(`select id from spaces where owner_id=$1 and kind='personal'`, [uid])).rows[0].id;

// 協作用戶端（Node）：每次連線前以該使用者的登入取得協作憑證
export function collabClient(u, pageId, extra = {}) {
  return new Client({
    url: `ws://127.0.0.1:${COLLAB_PORT}`, docId: pageId, token: '', userId: u.id, name: u.email.slice(0, 1).toUpperCase(), WebSocketImpl: WS,
    getToken: async () => {
      const r = await u.agent.post(`/api/pages/${pageId}/collab-token`);
      if (r.status !== 200) { const e = new Error('collab token ' + r.status); e.status = r.status; throw e; }
      return r.json.token;
    },
    ...extra,
  });
}
const waitUntil = async (cond, ms, label) => {
  const end = Date.now() + ms;
  for (;;) { if (await cond()) return true; if (Date.now() > end) return false; await sleep(10); }
};
const sessionOf = async u => (await db.query(
  `select s.id from "session" s where s.user_id=$1 order by s.updated_at desc limit 1`, [u.id])).rows[0].id;
const pageState = async id => (await db.query('select title, icon, parent_id, space_id, deleted_at, position from pages where id=$1', [id])).rows[0];

// ACL-01 的 API 路由註冊表（P0-06）：每個 route.ts 都必須列在這裡並說明它與頁面資料的關係；
// 新增的 API 沒有列入就直接失敗，避免新的讀寫路徑漏掉授權檢查
export const ROUTE_REGISTRY = {
  'auth/[...all]': '認證（Better Auth），不含頁面資料',
  'health': '健康檢查，不含資料（SEC-05）',
  'invites': '建立邀請（管理者），不含頁面資料',
  'invites/[token]/accept': '兌換邀請，不含頁面資料',
  'pages': 'ACL-01：頁面樹讀取、在別人的空間／頁面下建立',
  'pages/[id]': 'ACL-01：改名、移動（來源與目的）、刪除',
  'pages/[id]/collab-token': 'ACL-01：協作憑證',
  'pages/[id]/conflicts/[cid]': 'VER-02（M2-c）：衝突副本預覽（非成員、錯頁、垃圾桶頁 404；只讀）',
  'pages/[id]/move-preview': 'ACL-01：搬移預覽',
  'pages/[id]/restore': 'ACL-01：還原',
  'pages/[id]/versions': 'VER-02（M2-c）：版本清單（非成員、垃圾桶頁 404；只讀）',
  'pages/[id]/versions/[vid]': 'VER-02（M2-c）：版本預覽（非成員、錯頁、垃圾桶頁 404；只讀、安全轉換）',
  'pages/events': 'ACL-01：即時推送',
  'pages/trash': 'ACL-01：垃圾桶',
  'sessions': '自己的登入裝置，不含頁面資料',
  'sessions/[id]': '撤銷自己的登入裝置',
  'sessions/revoke-others': '登出其他裝置',
  'spaces': 'ACL-01：空間清單只含自己所屬的',
  'spaces/[id]': 'ACL-01／02：改名、刪除（非成員 404、非建立者 403）',
  'spaces/[id]/leave': 'ACL-02：退出',
  'spaces/[id]/members': 'ACL-01／02：加入成員',
  'spaces/[id]/members/[userId]': 'ACL-02：移除成員',
  'users': '帳號名字與信箱清單（審核確認：所有登入者可見），不含頁面資料',
};
function scanRoutes(dir = APP_DIR + 'src/app/api', prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = dir + '/' + name;
    if (statSync(p).isDirectory()) out.push(...scanRoutes(p, prefix ? prefix + '/' + name : name));
    else if (name === 'route.ts') out.push(prefix);
  }
  return out;
}

// ---- ACL-01 四人各自的個人空間：其他人從每條路徑都存取不到 ----
export async function acl01(n) {
  const rec = new Recorder('ACL-01', '四人各自在個人空間建頁；其他人從頁面樹、垃圾桶、改名、移動、刪除、還原、協作憑證、別人的憑證、即時推送都存取不到');
  const env = await bootEnv({ users: 4, shared: false });
  const U = env.users;
  const routes = scanRoutes();
  const unlisted = routes.filter(r => !(r in ROUTE_REGISTRY));
  const stale = Object.keys(ROUTE_REGISTRY).filter(r => !routes.includes(r));
  // 每人：個人空間的頁面 P（含子頁面 C）、一個在垃圾桶中的頁面 T
  const mine = [];
  for (const u of U) {
    const P = await newPage(u.agent, `私人-${u.email}`);
    const C = (await u.agent.post('/api/pages', { parentId: P, title: '子頁' })).json.page.id;
    const T = await newPage(u.agent, `垃圾-${u.email}`);
    await u.agent.del(`/api/pages/${T}`);
    mine.push({ P, C, T, space: await personalOf(u.id) });
  }
  const streams = U.map(u => sse(env.base, u.agent));
  await Promise.all(streams.map(s => s.ready));
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      if (unlisted.length) fails.push('API 路由未列入註冊表：' + unlisted.join(', '));
      if (stale.length) fails.push('註冊表中的路由已不存在：' + stale.join(', '));
      const before = await Promise.all(mine.flatMap(m => [m.P, m.C, m.T]).map(pageState));
      const t0 = Date.now();
      for (let o = 0; o < U.length; o++) {
        const own = mine[o];
        for (let k = 0; k < U.length; k++) {
          if (k === o) continue;
          const u = U[k], ag = u.agent, tag = `${k}→${o}`;
          const t = await tree(ag);
          if (t.pages.some(p => [own.P, own.C, own.T].includes(p.id))) fails.push(`${tag} 頁面樹看得到別人的頁面`);
          if (t.spaces.some(s => s.id === own.space)) fails.push(`${tag} 空間清單看得到別人的個人空間`);
          const sp = await ag.get('/api/spaces');
          if (sp.json.spaces.some(s => s.id === own.space)) fails.push(`${tag} /api/spaces 看得到別人的個人空間`);
          const tr = await ag.get('/api/pages/trash');
          if (tr.json.items.some(x => x.id === own.T)) fails.push(`${tag} 垃圾桶看得到別人的頁面`);
          const expect404 = async (label, r) => { if (r.status !== 404) fails.push(`${tag} ${label} → ${r.status}（應為 404）`); };
          await expect404('改名', await ag.patch(`/api/pages/${own.P}`, { title: '入侵' + i }));
          await expect404('改圖示', await ag.patch(`/api/pages/${own.C}`, { icon: '💀' }));
          await expect404('移到自己的頁面下', await ag.patch(`/api/pages/${own.P}`, { parentId: mine[k].P }));
          await expect404('把自己的頁面移到別人的頁面下', await ag.patch(`/api/pages/${mine[k].P}`, { parentId: own.P }));
          await expect404('移到別人的空間', await ag.patch(`/api/pages/${mine[k].C}`, { parentId: null, spaceId: own.space, confirm: 'x' }));
          await expect404('在別人的頁面下建立', await ag.post('/api/pages', { parentId: own.P, title: 'x' }));
          await expect404('在別人的空間建立', await ag.post('/api/pages', { spaceId: own.space, title: 'x' }));
          await expect404('刪除', await ag.del(`/api/pages/${own.C}`));
          await expect404('還原', await ag.post(`/api/pages/${own.T}/restore`));
          await expect404('協作憑證', await ag.post(`/api/pages/${own.P}/collab-token`));
          await expect404('搬移預覽', await ag.get(`/api/pages/${own.P}/move-preview?space=${mine[k].space}`));
          await expect404('搬移預覽（目的）', await ag.get(`/api/pages/${mine[k].P}/move-preview?space=${own.space}`));
          await expect404('改名別人的空間', await ag.patch(`/api/spaces/${own.space}`, { name: 'x' }));
          await expect404('加入別人的空間', await ag.post(`/api/spaces/${own.space}/members`, { userId: u.id }));
          await expect404('退出別人的空間', await ag.post(`/api/spaces/${own.space}/leave`));
          // 協作：自己頁面的憑證拿去連別人的頁面（憑證綁定頁面）→ 4003
          const myTok = await collabToken(ag, mine[k].P);
          const a = await probeCollab(own.P, myTok);
          if (a.msg === 'welcome' || a.code !== 4003) fails.push(`${tag} 以自己頁面的憑證連別人的頁面：${a.msg || a.code}`);
          if (a.ws) a.ws.terminate();
          // 有效簽章、綁定別人頁面的憑證（例如先前是成員時取得的）：協作伺服器必須以成員身分拒絕（4004，與頁面不存在相同）
          const forged = signCollabToken({ sid: await sessionOf(u), uid: u.id, pid: own.P }, SECRETS.COLLAB_SECRET);
          const b = await probeCollab(own.P, forged);
          if (b.msg === 'welcome' || b.code !== 4004) fails.push(`${tag} 非成員以有效憑證連線：${b.msg || b.code}`);
          if (b.ws) b.ws.terminate();
        }
      }
      // 即時推送：每人改自己的頁面，其他三人都不得收到推送；本人要收到（確認推送本身正常）
      for (let o = 0; o < U.length; o++) {
        const t1 = Date.now();
        await U[o].agent.patch(`/api/pages/${mine[o].P}`, { title: `私人-${U[o].email}` });
        const got = await streams[o].next(2000);
        if (!got) fails.push(`${o} 自己的變更沒有收到推送`);
        await sleep(300);
        for (let k = 0; k < U.length; k++) if (k !== o && streams[k].since(t1)) fails.push(`${k} 收到 ${o} 個人空間的推送`);
      }
      // 資料沒有任何變更
      const after = await Promise.all(mine.flatMap(m => [m.P, m.C, m.T]).map(pageState));
      if (JSON.stringify(before) !== JSON.stringify(after)) fails.push('其他人的操作改變了頁面資料');
      const extra = (await db.query(`select count(*)::int as n from pages where title in ('x')`)).rows[0].n;
      if (extra) fails.push('非成員建立了頁面 ' + extra);
      return [fails, { ms: Date.now() - t0, routes: routes.length }];
    });
  }
  streams.forEach(s => s.close());
  return rec.save({ routeRegistry: ROUTE_REGISTRY });
}

// ---- ACL-02 共享空間成員管理、移除與退出、在途修改、刪除空間、權限恢復後的舊草稿 ----
const ensureFaultTrigger = () => db.query(`
  create or replace function test_space_delete_fault() returns trigger as $$
  begin
    if exists (select 1 from fault_flags where name = 'space_delete_fail' and on_) then raise exception 'injected space delete failure'; end if;
    return old;
  end $$ language plpgsql;
  drop trigger if exists test_space_delete_fault on spaces;
  create trigger test_space_delete_fault before delete on spaces for each row execute function test_space_delete_fault();`);
const setFault = on => db.query(`insert into fault_flags(name, on_) values ('space_delete_fail', $1) on conflict (name) do update set on_=excluded.on_`, [on]);

export async function acl02(n) {
  const rec = new Recorder('ACL-02', '建立者邀請 B、C（D 不是成員）；移除 C、C 退出另一個空間；在途修改不提交；刪除空間（含注入失敗）；權限恢復後舊草稿不自動補送');
  const env = await bootEnv({ users: 4, shared: false });
  await ensureFaultTrigger();
  // 建立者 A＝一般成員帳號（管理者沒有特權）；D＝管理者，不是成員
  const [D, A, B, C] = env.users;
  const S = Object.fromEntries(env.users.map(u => [u.email, sse(env.base, u.agent)]));
  await Promise.all(Object.values(S).map(s => s.ready));
  const live = new Set();
  const track = c => { live.add(c); return c; };
  const lat = [];
  for (let i = 0; i < n; i++) {
    const seed = 70200 + i;
    await runRound(rec, i, seed, async () => {
      const fails = [];
      const m = {};
      const rnd = rng(seed);
      const within2s = async (label, cond) => {
        const t0 = Date.now();
        const ok = await waitUntil(cond, 4000);
        const ms = Date.now() - t0;
        if (!ok || ms > 2000) fails.push(`${label}：${ok ? ms + ' 毫秒' : '4 秒內沒有發生'}`); else lat.push(ms);
      };
      // 1. 建立兩個共享空間，加入成員
      const s1 = (await A.agent.post('/api/spaces', { name: `共享${i}` })).json.space.id;
      const s2 = (await A.agent.post('/api/spaces', { name: `另一個${i}` })).json.space.id;
      const tB = Date.now();
      if ((await A.agent.post(`/api/spaces/${s1}/members`, { userId: B.id })).status !== 201) fails.push('加入 B 失敗');
      await within2s('B 看到新加入的空間', async () => (await spaceIds(B.agent)).has(s1));
      if (!(await waitUntil(() => S[B.email].since(tB) > 0, 2000))) fails.push('B 沒有收到加入空間的推送');
      await A.agent.post(`/api/spaces/${s1}/members`, { userId: C.id });
      await A.agent.post(`/api/spaces/${s2}/members`, { userId: C.id });
      const P = await newPage(A.agent, `共享頁${i}`, { spaceId: s1 });
      const P2 = await newPage(A.agent, `另一頁${i}`, { spaceId: s2 });
      await within2s('B 看到共享頁', async () => (await pageIds(B.agent)).has(P));
      await within2s('C 看到兩個空間的頁面', async () => { const ids = await pageIds(C.agent); return ids.has(P) && ids.has(P2); });
      // D 不是成員：看不到、拿不到憑證、沒有推送
      const tD = Date.now();
      if ((await pageIds(D.agent)).has(P) || (await spaceIds(D.agent)).has(s1)) fails.push('D 看得到不是成員的空間');
      if ((await D.agent.post(`/api/pages/${P}/collab-token`)).status !== 404) fails.push('D 取得了協作憑證');
      await A.agent.patch(`/api/pages/${P}`, { title: `共享頁${i}` });
      await sleep(300);
      if (S[D.email].since(tD)) fails.push('D 收到不是成員的空間的推送');

      // 2. 只有建立者能管理成員
      const expect = async (label, r, code) => { if (r.status !== code) fails.push(`${label} → ${r.status}（應為 ${code}）`); };
      await expect('B 加入成員', await B.agent.post(`/api/spaces/${s1}/members`, { userId: D.id }), 403);
      await expect('B 移除成員', await B.agent.del(`/api/spaces/${s1}/members/${C.id}`), 403);
      await expect('B 改名', await B.agent.patch(`/api/spaces/${s1}`, { name: 'B 改的' }), 403);
      await expect('B 刪除空間', await B.agent.del(`/api/spaces/${s1}`), 403);
      await expect('D（非成員）加入自己', await D.agent.post(`/api/spaces/${s1}/members`, { userId: D.id }), 404);
      await expect('A 移除自己（建立者）', await A.agent.del(`/api/spaces/${s1}/members/${A.id}`), 400);
      await expect('A 退出（建立者）', await A.agent.post(`/api/spaces/${s1}/leave`), 400);
      const mem = (await db.query('select user_id from space_members where space_id=$1 order by user_id', [s1])).rows.map(r => r.user_id);
      if (JSON.stringify(mem) !== JSON.stringify([A.id, B.id, C.id].sort())) fails.push('成員名單被非建立者改變 ' + mem.length);
      if ((await db.query('select name from spaces where id=$1', [s1])).rows[0]?.name !== `共享${i}`) fails.push('空間被非建立者改名或刪除');
      if (fails.length) return [fails, m];   // 空間已被非建立者改變，後續步驟的前提不成立

      // 3. 移除 C：C 的頁面樹 2 秒內不再有 P、協作連線 2 秒內中斷、憑證被拒；之後的修改只留在本機
      const cC = track(collabClient(C, P));
      cC.connect();
      if (!(await waitUntil(() => cC.ready, 8000))) fails.push('C 無法連上共享頁');
      cC.type(`[Ca${i}]`);
      await waitUntil(() => cC.pending.length === 0, 5000);
      let closedAt = null;
      cC.on('access_denied', () => { closedAt = Date.now(); });
      const tR = Date.now();
      await A.agent.del(`/api/spaces/${s1}/members/${C.id}`);
      await within2s('C 的頁面樹不再有 P', async () => !(await pageIds(C.agent)).has(P));
      await within2s('C 的協作連線中斷（4005）', () => closedAt !== null);
      if (closedAt) m.revokeMs = closedAt - tR;
      if ((await C.agent.post(`/api/pages/${P}/collab-token`)).status !== 404) fails.push('被移除後仍可取得協作憑證');
      if (cC.storage.docUpdates.length) fails.push('失去權限後本機仍保存伺服器的文件狀態');
      // 失去權限後的修改（離線編輯）：只留在本機
      const draft = [`[Cx${i}]`, `[Cy${i}]`];
      for (const t of draft) { try { cC.type(t); } catch { /* 唯讀時直接寫入文件 */ cC.ydoc.transact(() => { const f = cC.ydoc.getXmlFragment('blocks'); const el = new Y.XmlElement('p'); const tx = new Y.XmlText(); tx.insert(0, ' ' + t); el.insert(0, [tx]); f.insert(f.length, [el]); }, 'local'); } }
      const own = cC.ydoc.clientID;
      const foreign = cC.storage.denied.flatMap(e => Y.decodeUpdate(e.data).structs.map(s => s.id.client)).filter(cl => cl !== own);
      if (foreign.length) fails.push('無權限草稿含有其他人的內容');
      if (!cC.storage.denied.length) fails.push('失去權限後的修改沒有保留在本機');
      if (!cC.deniedDraft().text.includes(draft[0])) fails.push('下載的草稿沒有自己的內容');
      const storageAfter = cC.storage;
      cC.disconnect();

      // 4. C 自己退出另一個空間
      if ((await C.agent.post(`/api/spaces/${s2}/leave`)).status !== 200) fails.push('C 無法退出空間');
      await within2s('C 退出後頁面樹不再有另一個空間的頁面', async () => !(await pageIds(C.agent)).has(P2));
      if (!(await pageIds(A.agent)).has(P2)) fails.push('C 退出後建立者看不到空間的頁面');

      // 5. 權限恢復：重新加入 C；舊草稿不得自動補送，直到 C 選擇另存為衝突副本
      await A.agent.post(`/api/spaces/${s1}/members`, { userId: C.id });
      const cC2 = track(collabClient(C, P, { storage: storageAfter }));
      let deniedNotice = 0;
      cC2.on('denied_drafts', k => { deniedNotice = k; });
      cC2.connect();
      if (!(await waitUntil(() => cC2.ready, 8000))) fails.push('重新加入後無法連線');
      await sleep(400);
      const dbTok = (await loadFromDb(P)).tokens;
      if (draft.some(t => dbTok.has(t))) fails.push('權限恢復後舊草稿被自動送出');
      if (!deniedNotice) fails.push('權限恢復後沒有提示失去權限前的草稿');
      if (!dbTok.has(`[Ca${i}]`)) fails.push('C 被移除前已確認的修改不見了');
      const copyId = cC2.saveDeniedAsCopy();
      if (!(await waitUntil(() => cC2.storage.unackedCopies.length === 0, 5000))) fails.push('另存為衝突副本沒有確認');
      const cc = (await db.query('select user_id, content_json from conflict_copies where id=$1', [copyId])).rows[0];
      if (!cc || cc.user_id !== C.id || !draft.every(t => cc.content_json.includes(t))) fails.push('衝突副本沒有保存 C 的草稿');
      const dbTok2 = (await loadFromDb(P)).tokens;
      if (draft.some(t => dbTok2.has(t))) fails.push('另存為衝突副本時把草稿合併進了文件');
      cC2.disconnect();

      // 6. 在途修改（P0-01）：協作伺服器延後處理撤銷通知，被移除者在連線中斷前繼續送出修改
      await env.collab.stop();
      await env.collab.start({ ACCESS_NOTIFY_DELAY_MS: '3000' });
      const cB = track(collabClient(B, P));
      cB.connect();
      if (!(await waitUntil(() => cB.ready, 8000))) fails.push('B 無法連上');
      const typed = [];
      const acked = [];
      cB.on('acked', ids => acked.push(...ids));
      let k = 0;
      const typer = setInterval(() => { try { const t = `[Bn${i * 100000 + k++}]`; cB.type(t); typed.push(t); } catch { /* 已唯讀 */ } }, 15);
      await sleep(300);
      await A.agent.del(`/api/spaces/${s1}/members/${B.id}`);
      const seqAt = Number((await db.query('select last_seq from pages where id=$1', [P])).rows[0].last_seq);
      const deniedFast = await waitUntil(() => cB.accessDenied, 2500);
      clearInterval(typer);
      if (!deniedFast) fails.push('在途修改：提交時沒有重新授權（2.5 秒內沒有被拒）');
      await sleep(3500);
      const late = (await db.query('select count(*)::int as n from doc_updates where page_id=$1 and user_id=$2 and seq > $3', [P, B.id, seqAt])).rows[0].n;
      if (late) fails.push(`在途修改：撤銷之後仍寫入 ${late} 筆 B 的修改`);
      // 確認過的每一筆都必須已提交（未提交就確認＝假的「已儲存」）
      const committed = new Set((await db.query('select update_id from doc_update_ids where page_id=$1 and update_id = any($2)', [P, acked])).rows.map(r => r.update_id));
      if (acked.some(id => !committed.has(id))) fails.push('在途修改：有未提交就確認的修改');
      const tokNow = (await loadFromDb(P)).tokens;
      const deniedText = cB.deniedDraft().text;
      const lost = typed.filter(t => !tokNow.has(t) && !deniedText.includes(t));
      if (lost.length) fails.push(`在途修改：${lost.length} 個修改既不在資料庫也不在本機草稿`);
      m.inflight = { typed: typed.length, denied: cB.storage.denied.length };
      cB.disconnect();
      await env.collab.stop();
      await env.collab.start();

      // 7. 刪除共享空間（P0-03）：注入失敗時全部回滾；成功時頁面移到建立者個人空間的垃圾桶
      const s3 = (await A.agent.post('/api/spaces', { name: `刪除測試${i}` })).json.space.id;
      await A.agent.post(`/api/spaces/${s3}/members`, { userId: B.id });
      const Q = await newPage(A.agent, `將刪除${i}`, { spaceId: s3 });
      const Qc = (await A.agent.post('/api/pages', { parentId: Q, title: '子' })).json.page.id;
      const Q2 = await newPage(B.agent, `B 建的${i}`, { spaceId: s3 });
      await setFault(true);
      const bad = await A.agent.del(`/api/spaces/${s3}`);
      await setFault(false);
      if (bad.status < 500) fails.push('注入失敗時刪除空間沒有失敗 ' + bad.status);
      const still = (await db.query('select count(*)::int as n from pages where space_id=$1 and deleted_at is null', [s3])).rows[0].n;
      const memb = (await db.query('select count(*)::int as n from space_members where space_id=$1', [s3])).rows[0].n;
      if (still !== 3 || memb !== 2) fails.push(`注入失敗後沒有完整回滾（頁面 ${still}、成員 ${memb}）`);
      const cBq = track(collabClient(B, Q));
      let bClosed = null;
      cBq.on('page_closed', () => { bClosed = Date.now(); });
      cBq.on('access_denied', () => { bClosed = Date.now(); });
      cBq.connect();
      await waitUntil(() => cBq.ready, 8000);
      const td = Date.now();
      if ((await A.agent.del(`/api/spaces/${s3}`)).status !== 200) fails.push('刪除空間失敗');
      await within2s('刪除空間後 B 的連線中斷', () => bClosed !== null);
      if (bClosed) m.deleteCloseMs = bClosed - td;
      const pA = await personalOf(A.id);
      const rows = (await db.query('select id, space_id, deleted_at is not null as trashed, trash_batch from pages where id = any($1::uuid[])', [[Q, Qc, Q2]])).rows;
      if (rows.length !== 3 || rows.some(r => r.space_id !== pA || !r.trashed)) fails.push('刪除空間後頁面沒有全部移到建立者個人空間的垃圾桶');
      const batches = new Set(rows.map(r => r.trash_batch));
      if (batches.size !== 2) fails.push('每個頂層頁面應各自一個垃圾桶批次 ' + batches.size);
      if ((await db.query('select 1 from spaces where id=$1', [s3])).rows.length) fails.push('空間沒有被刪除');
      if ((await B.agent.get('/api/pages/trash')).json.items.some(x => [Q, Q2].includes(x.id))) fails.push('前成員的垃圾桶看得到原頁面');
      if ((await B.agent.post(`/api/pages/${Q2}/restore`)).status !== 404) fails.push('前成員可以還原自己在已刪除空間建的頁面');
      if ((await A.agent.post(`/api/pages/${Q}/restore`)).status !== 200) fails.push('建立者無法還原');
      if ((await pageIds(B.agent)).has(Q) || (await B.agent.post(`/api/pages/${Q}/collab-token`)).status !== 404) fails.push('還原後前成員重新取得存取權');
      if ((await pageState(Q)).space_id !== pA) fails.push('還原後不在建立者的個人空間');
      cBq.disconnect();
      // 下一輪：B 重新加入 s1（隨機決定是否保留 s2），不影響判定
      if (rnd() < 0.5) await A.agent.del(`/api/spaces/${s2}`);
      return [fails, m];
    }, async () => { for (const c of live) c.disconnect(); live.clear(); await setFault(false); });
  }
  Object.values(S).forEach(s => s.close());
  lat.sort((a, b) => a - b);
  return rec.save({ latency: { p50: lat[Math.floor(lat.length / 2)], max: lat.at(-1) } });
}

// ---- ACL-03 四人隨機並行：建頁、移動（含跨空間）、刪除、還原、加入與移除成員、刪除空間 ----
export async function acl03(n) {
  const rec = new Recorder('ACL-03', '四人隨機並行操作：沒有人能存取自己空間以外的頁面；子頁面與上層同空間；個人空間只有本人；前成員存取不到');
  const env = await bootEnv({ users: 4, shared: false });
  const U = env.users;
  const personal = await Promise.all(U.map(u => personalOf(u.id)));
  const deadlocks = async () => Number((await db.query('select deadlocks from pg_stat_database where datname = current_database()')).rows[0].deadlocks);
  for (let i = 0; i < n; i++) {
    const seed = 70300 + i;
    await runRound(rec, i, seed, async () => {
      const rnd = rng(seed);
      const fails = [];
      const statuses = {};
      const pick = a => a[Math.floor(rnd() * a.length)];
      const dl0 = await deadlocks();
      // 每人一個自己建立的共享空間，隨機加入其他人
      const shared = [];
      for (const u of U) {
        const id = (await u.agent.post('/api/spaces', { name: `隨機${i}-${u.email}` })).json.space.id;
        for (const o of U) if (o !== u && rnd() < 0.6) await u.agent.post(`/api/spaces/${id}/members`, { userId: o.id });
        shared.push({ id, owner: u });
      }
      const exMembers = [];   // 刪除空間時的成員（之後不得存取原頁面）
      const actor = async (u, ui) => {
        for (let k = 0; k < 30; k++) {
          const t = await tree(u.agent);
          const vis = t.pages.map(p => p.id);
          const mySpaces = t.spaces.map(s => s.id);
          const r = rnd();
          let res;
          if (r < 0.22 || vis.length < 3) {
            res = await u.agent.post('/api/pages', rnd() < 0.5 && vis.length ? { parentId: pick(vis), title: 't' + k } : { spaceId: pick(mySpaces), title: 't' + k });
          } else if (r < 0.42) {
            // 移動：目的是看得到的頁面、自己的空間，或「別人的個人空間」（永遠不是成員，必須 404）
            const id = pick(vis);
            const forbidden = rnd() < 0.25;
            const body = forbidden ? { parentId: null, spaceId: personal[(ui + 1 + Math.floor(rnd() * 3)) % 4] }
              : rnd() < 0.5 ? { parentId: pick(vis) } : { parentId: null, spaceId: pick(mySpaces) };
            res = await u.agent.patch(`/api/pages/${id}`, body);
            if (res.status === 409 && res.json?.preview) res = await u.agent.patch(`/api/pages/${id}`, { ...body, confirm: res.json.preview.confirm });
            if (forbidden && res.status < 300) fails.push(`${ui} 把頁面移到不是成員的空間成功了`);
          } else if (r < 0.55) res = await u.agent.del(`/api/pages/${pick(vis)}`);
          else if (r < 0.65) {
            const tr = (await u.agent.get('/api/pages/trash')).json.items;
            res = tr.length ? await u.agent.post(`/api/pages/${pick(tr).id}/restore`) : { status: 0 };
          } else if (r < 0.8) {
            const s = shared.find(x => x.owner === u && x.alive !== false);
            const o = pick(U.filter(x => x !== u));
            res = s ? (rnd() < 0.5 ? await u.agent.post(`/api/spaces/${s.id}/members`, { userId: o.id }) : await u.agent.del(`/api/spaces/${s.id}/members/${o.id}`)) : { status: 0 };
          } else if (r < 0.88) {
            const s = shared.find(x => x.owner !== u && mySpaces.includes(x.id));
            res = s ? await u.agent.post(`/api/spaces/${s.id}/leave`) : { status: 0 };
          } else if (r < 0.92) {
            const s = shared.find(x => x.owner === u && x.alive !== false);
            if (s) {
              const before = (await db.query('select user_id from space_members where space_id=$1', [s.id])).rows.map(x => x.user_id);
              const pagesBefore = (await db.query('select id from pages where space_id=$1', [s.id])).rows.map(x => x.id);
              res = await u.agent.del(`/api/spaces/${s.id}`);
              if (res.status === 200) { s.alive = false; exMembers.push({ users: before.filter(x => x !== u.id), pages: pagesBefore }); }
            } else res = { status: 0 };
          } else {
            // 非成員嘗試：取得別人個人空間頁面的協作憑證
            const other = (await db.query('select id from pages where space_id=$1 limit 1', [personal[(ui + 1) % 4]])).rows[0];
            res = other ? await u.agent.post(`/api/pages/${other.id}/collab-token`) : { status: 0 };
            if (other && res.status !== 404) fails.push(`${ui} 取得了別人個人空間頁面的協作憑證 ${res.status}`);
          }
          statuses[res.status] = (statuses[res.status] || 0) + 1;
          if (res.status >= 500) fails.push('伺服器錯誤 ' + res.status + ' ' + (res.text || '').slice(0, 120));
        }
      };
      await Promise.all(U.map((u, ui) => actor(u, ui)));
      // 不變量
      const q = async (sql, args = []) => (await db.query(sql, args)).rows;
      if ((await q('select 1 from pages c join pages p on p.id = c.parent_id where c.space_id <> p.space_id')).length) fails.push('子頁面與上層不在同一個空間');
      if ((await q(`select 1 from space_members m join spaces s on s.id = m.space_id where s.kind = 'personal' and m.user_id <> s.owner_id`)).length) fails.push('個人空間有其他成員');
      if ((await q(`select 1 from spaces s where not exists (select 1 from space_members m where m.space_id = s.id and m.role = 'owner' and m.user_id = s.owner_id)`)).length) fails.push('有空間沒有建立者成員列');
      for (const u of U) {
        const api = (await tree(u.agent)).pages.map(p => p.id).sort();
        const exp = (await q(`select p.id from pages p join space_members m on m.space_id = p.space_id and m.user_id = $1 where p.deleted_at is null order by p.id`, [u.id])).map(r => r.id).sort();
        if (JSON.stringify(api) !== JSON.stringify(exp)) fails.push(`${u.email} 的頁面樹與成員身分不一致`);
        // 抽樣：看不到的頁面一律 404
        const hidden = await q(`select p.id from pages p where p.deleted_at is null and not exists (select 1 from space_members m where m.space_id = p.space_id and m.user_id = $1) order by random() limit 5`, [u.id]);
        for (const h of hidden) {
          if ((await u.agent.post(`/api/pages/${h.id}/collab-token`)).status !== 404) fails.push(`${u.email} 取得看不到的頁面的憑證`);
          if ((await u.agent.patch(`/api/pages/${h.id}`, { title: '入侵' })).status !== 404) fails.push(`${u.email} 改了看不到的頁面`);
        }
      }
      for (const ex of exMembers) {
        for (const uid of ex.users) {
          const u = U.find(x => x.id === uid);
          const vis = await pageIds(u.agent);
          const stillMember = async pid => (await q('select 1 from pages p join space_members m on m.space_id = p.space_id and m.user_id = $2 where p.id = $1', [pid, uid])).length > 0;
          for (const pid of ex.pages) if (vis.has(pid) && !(await stillMember(pid))) fails.push('已刪除空間的前成員仍看得到原頁面');
        }
      }
      if ((await q(`select 1 from pages where (deleted_at is null) <> (trash_batch is null)`)).length) fails.push('deleted_at 與 trash_batch 不一致');
      return [fails, { statuses, deadlocks: (await deadlocks()) - dl0, pages: (await q('select count(*)::int as n from pages'))[0].n }];
    });
  }
  return rec.save();
}

// ---- AUTH-08 帳號上限（P0-05）：最多四個帳號，管理者與停用的帳號都計入；並行兌換只成功一個 ----
async function createInvitedUser(env, admin, email) {
  const t = await inviteToken(admin.agent, email);
  if (typeof t !== 'string') throw new Error('invite failed ' + JSON.stringify(t));
  const r = await new Agent(env.base).post(`/api/invites/${t}/accept`, { name: 'd', password: PASSWORD });
  if (r.status !== 201) throw new Error('accept failed ' + r.status);
  return (await db.query('select id from "user" where email=$1', [email])).rows[0].id;
}
async function inviteToken(admin, email) {
  const r = await admin.post('/api/invites', { email });
  return r.status === 201 ? new URL(r.json.url).pathname.split('/').pop() : { status: r.status, code: r.json?.error?.code };
}
export async function auth08(n) {
  const rec = new Recorder('AUTH-08', '最多四個帳號：第五個帳號被拒；剩一個名額時兩個邀請同時兌換只成功一個；停用的帳號仍占名額');
  const env = await bootEnv({ users: 3, shared: false });
  const [admin] = env.users;
  const count = async () => (await db.query('select count(*)::int as n from "user"')).rows[0].n;
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      await removeUsersExcept(env.users);
      // 剩一個名額：兩個邀請都能建立，同時兌換只成功一個
      const t1 = await inviteToken(admin.agent, `slot${i}a@example.test`);
      const t2 = await inviteToken(admin.agent, `slot${i}b@example.test`);
      if (typeof t1 !== 'string' || typeof t2 !== 'string') fails.push('剩一個名額時無法建立邀請');
      else {
        const rs = await Promise.all([t1, t2].map(t => new Agent(env.base).post(`/api/invites/${t}/accept`, { name: 's', password: PASSWORD })));
        const ok = rs.filter(r => r.status === 201).length;
        if (ok !== 1) fails.push('同時兌換成功 ' + ok + ' 個（應為 1）');
        const rej = rs.find(r => r.status !== 201);
        if (rej && rej.json?.error?.code !== 'account_limit') fails.push('被拒的兌換不是帳號上限錯誤 ' + rej.status + ' ' + rej.text);
        // 被拒的邀請沒有被用掉（日後有名額時仍可使用）
        const unused = (await db.query(`select count(*)::int as n from invites where email = any($1) and used_at is null`, [[`slot${i}a@example.test`, `slot${i}b@example.test`]])).rows[0].n;
        if (unused !== 1) fails.push('被拒的邀請狀態不正確 ' + unused);
      }
      if ((await count()) !== 4) fails.push('帳號數應為 4，實際 ' + (await count()));
      // 已滿：建立邀請被拒；管理者指令建立帳號被拒
      const t3 = await inviteToken(admin.agent, `fifth${i}@example.test`);
      if (typeof t3 === 'string' || t3.code !== 'account_limit') fails.push('已滿時仍可建立邀請 ' + JSON.stringify(t3));
      const sc = spawnSync(process.execPath, [APP_DIR + 'node_modules/tsx/dist/cli.mjs', APP_DIR + 'scripts/create-admin.ts', '--email', `fifth-admin${i}@example.test`, '--name', 'x', '--force'],
        { cwd: APP_DIR, env: { ...process.env, DATABASE_URL: DB_URL, ...SECRETS, ADMIN_PASSWORD: PASSWORD }, encoding: 'utf8' });
      if (sc.status === 0) fails.push('已滿時管理者指令仍建立了帳號');
      else if (!/上限/.test(sc.stderr + sc.stdout)) fails.push('管理者指令的錯誤訊息沒有說明帳號上限：' + (sc.stderr + sc.stdout).slice(-200));
      // 直接寫入資料庫（繞過應用程式）也被資料庫拒絕
      const direct = await db.query(`insert into "user"(id, name, email, email_verified, role, created_at, updated_at) values ('direct${i}', 'x', 'direct${i}@example.test', true, 'member', now(), now())`).then(() => true, e => !String(e.message).includes('account_limit'));
      if (direct) fails.push('直接寫入資料庫可以建立第五個帳號');
      if ((await count()) !== 4) fails.push('第五個帳號被建立');
      // 停用的帳號仍占名額。R1 沒有停用功能；這裡以「無法再登入」模擬停用：刪除該帳號的登入裝置與密碼（帳號列仍在）
      await removeUsersExcept(env.users);
      const disabled = await createInvitedUser(env, admin, `disabled${i}@example.test`);
      await db.query(`delete from "session" where user_id=$1`, [disabled]);
      await db.query(`delete from account where user_id=$1`, [disabled]);
      if ((await count()) !== 4) fails.push('停用測試前帳號數應為 4');
      const t5 = await inviteToken(admin.agent, `overban${i}@example.test`);
      if (typeof t5 === 'string') {
        fails.push('停用的帳號沒有計入名額（仍可建立邀請）');
        const r5 = await new Agent(env.base).post(`/api/invites/${t5}/accept`, { name: 'n', password: PASSWORD });
        if (r5.status === 201) fails.push('停用的帳號沒有計入名額（建立了第五個帳號）');
      }
      return [fails, { users: await count() }];
    });
  }
  return rec.save();
}

export { createSharedSpace, within };
