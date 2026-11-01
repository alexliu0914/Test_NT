// 頁面樹：PAGE-01～05（計畫書 11.3；PAGE-05 為 M1 新增的隨機操作不變量測試）
import { spawnSync } from 'node:child_process';
import { db, APP_DIR, DB_URL, SECRETS, newPage, collabToken, sleep } from '../lib/harness.mjs';
import { Recorder, runRound, rng } from '../lib/recorder.mjs';
import { bootEnv } from '../lib/env.mjs';

// 讀取 SSE：回傳「下一次 changed 事件」的 Promise 產生器
function sse(base, agent) {
  const ctrl = new AbortController();
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
        if (ev.includes('event: changed')) waiters.splice(0).forEach(w => w(Date.now()));
      }
    }
  })().catch(() => {});
  return { ready: readyP, next: () => new Promise(r => waiters.push(r)), close: () => ctrl.abort() };
}

const tree = async ag => (await ag.get('/api/pages')).json.pages;

// ---- PAGE-01 建立、改名、設定圖示：另一位使用者 2 秒內看到 ----
export async function page01(n) {
  const rec = new Recorder('PAGE-01', '建立、改名、設定圖示：另一位使用者 2 秒內收到推送並讀到變更');
  const env = await bootEnv({ users: 2 });
  const [A, B] = env.users;
  const stream = sse(env.base, B.agent);
  await stream.ready;
  const lat = [];
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      const step = async (label, fn, check) => {
        const t0 = Date.now();
        const got = stream.next();
        await fn();
        const t1 = await Promise.race([got, sleep(2000).then(() => null)]);
        if (!t1) { fails.push(`${label}：2 秒內沒有收到推送`); return; }
        const ms = Date.now() - t0;
        lat.push(ms);
        if (!check(await tree(B.agent))) fails.push(`${label}：B 讀到的頁面樹沒有反映變更`);
        if (ms > 2000) fails.push(`${label}：${ms} 毫秒`);
      };
      let id = null;
      await step('建立', async () => { id = await newPage(A.agent, `頁面${i}`); }, t => t.some(p => p.id === id && p.title === `頁面${i}`));
      await step('改名', () => A.agent.patch(`/api/pages/${id}`, { title: `改名${i}` }), t => t.some(p => p.id === id && p.title === `改名${i}`));
      await step('圖示', () => A.agent.patch(`/api/pages/${id}`, { icon: '📚' }), t => t.some(p => p.id === id && p.icon === '📚'));
      return [fails];
    });
  }
  stream.close();
  lat.sort((a, b) => a - b);
  return rec.save({ latency: { p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)], max: lat.at(-1) } });
}

// ---- PAGE-02 移到自己的子頁面底下：拒絕，頁面樹不變；並行交叉移動不會形成循環 ----
export async function page02(n) {
  const rec = new Recorder('PAGE-02', '把頁面移到自己或子孫底下：拒絕且頁面樹不變；兩人同時交叉移動不會形成循環');
  const env = await bootEnv({ users: 2 });
  const [A, B] = env.users;
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      const root = await newPage(A.agent, 'R' + i);
      const child = (await A.agent.post('/api/pages', { parentId: root, title: 'C' })).json.page.id;
      const grand = (await A.agent.post('/api/pages', { parentId: child, title: 'G' })).json.page.id;
      const before = JSON.stringify(await tree(A.agent));
      for (const target of [root, child, grand]) {
        const r = await A.agent.patch(`/api/pages/${root}`, { parentId: target });
        if (r.status !== 409) fails.push(`移到 ${target === root ? '自己' : '子孫'} 沒有被拒 ${r.status}`);
      }
      if (JSON.stringify(await tree(A.agent)) !== before) fails.push('被拒的移動改變了頁面樹');
      // 並行交叉移動：X 移到 Y 底下、Y 移到 X 底下，只能有一個成功
      const x = await newPage(A.agent, 'X' + i), y = await newPage(A.agent, 'Y' + i);
      const [r1, r2] = await Promise.all([A.agent.patch(`/api/pages/${x}`, { parentId: y }), B.agent.patch(`/api/pages/${y}`, { parentId: x })]);
      const okCount = [r1, r2].filter(r => r.status === 200).length;
      if (okCount !== 1) fails.push('交叉移動成功次數 ' + okCount);
      const cyc = await db.query(`with recursive walk(id, parent_id, depth) as (
          select id, parent_id, 0 from pages where deleted_at is null
          union all select w.id, p.parent_id, w.depth + 1 from walk w join pages p on p.id = w.parent_id where w.depth < 1000)
        select count(*)::int as n from walk where parent_id = id`);
      if (cyc.rows[0].n) fails.push('資料庫中出現循環');
      return [fails];
    });
  }
  return rec.save();
}

// ---- PAGE-03 刪除含子頁面的頁面後還原：結構與內容完整復原 ----
export async function page03(n) {
  const rec = new Recorder('PAGE-03', '刪除含子頁面的頁面後還原：結構、順序、標題、協作內容完整復原；先刪除的子頁面維持在垃圾桶');
  const env = await bootEnv({ users: 2 });
  const [A, B] = env.users;
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      const root = await newPage(A.agent, 'R' + i);
      const kids = [];
      for (let k = 0; k < 3; k++) kids.push((await A.agent.post('/api/pages', { parentId: root, title: 'K' + k, icon: '📌' })).json.page.id);
      const deep = (await A.agent.post('/api/pages', { parentId: kids[1], title: 'D' })).json.page.id;
      const early = (await A.agent.post('/api/pages', { parentId: root, title: 'early' })).json.page.id;
      // 協作內容：直接放幾筆更新進資料庫（與協作伺服器寫入的格式相同）
      await db.query(`insert into doc_updates(page_id, seq, data, kind) values ($1, 1, '\\x00', 'edit')`, [deep]);
      await A.agent.del(`/api/pages/${early}`);               // 先單獨刪掉一個子頁面
      const snap = JSON.stringify((await tree(A.agent)).filter(p => [root, ...kids, deep].includes(p.id)));
      const d = await A.agent.del(`/api/pages/${root}`);
      if (d.status !== 200 || d.json.trashed !== 5) fails.push('刪除數量不正確 ' + JSON.stringify(d.json));
      const t1 = await tree(B.agent);
      if (t1.some(p => [root, ...kids, deep].includes(p.id))) fails.push('刪除後子頁面仍在頁面樹');
      const trash = (await B.agent.get('/api/pages/trash')).json.items;
      if (!trash.some(t => t.id === root && t.count === 5)) fails.push('垃圾桶沒有顯示整批（含子頁面）');
      if (!trash.some(t => t.id === early)) fails.push('先刪除的子頁面不在垃圾桶');
      const r = await B.agent.post(`/api/pages/${root}/restore`);
      if (r.status !== 200 || r.json.restored !== 5) fails.push('還原數量不正確 ' + JSON.stringify(r.json));
      const after = JSON.stringify((await tree(A.agent)).filter(p => [root, ...kids, deep].includes(p.id)).map(p => ({ ...p, updatedAt: undefined })));
      const want = JSON.stringify(JSON.parse(snap).map(p => ({ ...p, updatedAt: undefined })));
      if (after !== want) fails.push('還原後結構或標題與刪除前不同');
      if ((await tree(A.agent)).some(p => p.id === early)) fails.push('先刪除的子頁面被一起還原');
      const c = (await db.query('select count(*)::int as n from doc_updates where page_id=$1', [deep])).rows[0].n;
      if (c !== 1) fails.push('子頁面的協作內容遺失');
      // 再還原先刪除的那一頁：上層已在，回到原位置
      const r2 = await A.agent.post(`/api/pages/${early}/restore`);
      if (r2.status !== 200 || r2.json.parentId !== root) fails.push('單獨刪除的子頁面沒有回到原上層');
      // F-M1-04：指定批次中「不是根」的頁面還原，而批次的根的上層屬於另一批、仍在垃圾桶
      // kids[1]（含 deep）先刪 → 批次 X；再刪 root → 批次 Y；指定 deep 還原批次 X：kids[1] 必須改掛到最上層
      await A.agent.del(`/api/pages/${kids[1]}`);
      await A.agent.del(`/api/pages/${root}`);
      const r3 = await B.agent.post(`/api/pages/${deep}/restore`);
      const t3 = await tree(A.agent);
      const k1 = t3.find(p => p.id === kids[1]), dp = t3.find(p => p.id === deep);
      if (r3.status !== 200 || r3.json.restored !== 2) fails.push('指定子頁面還原時數量不正確 ' + JSON.stringify(r3.json));
      if (!k1 || k1.parentId !== null) fails.push('批次的根仍掛在垃圾桶裡的頁面底下 ' + JSON.stringify(k1));
      if (!dp || dp.parentId !== kids[1]) fails.push('批次內的結構沒有保留');
      const orphan = (await db.query(`select count(*)::int as n from pages c join pages p on p.id = c.parent_id where c.deleted_at is null and p.deleted_at is not null`)).rows[0].n;
      if (orphan) fails.push('有頁面掛在已刪除的頁面底下');
      await B.agent.post(`/api/pages/${root}/restore`);       // 收尾：其餘頁面還原，下一輪不受影響
      return [fails];
    });
  }
  return rec.save();
}

// ---- PAGE-04 垃圾桶超過 30 天（模擬時間） ----
export async function page04(n) {
  const rec = new Recorder('PAGE-04', '垃圾桶超過 30 天的頁面（含子頁面與協作資料）被永久刪除；未滿 30 天的保留（附件部分屬 M3）');
  const env = await bootEnv({ users: 1 });
  const A = env.users[0];
  for (let i = 0; i < n; i++) {
    await runRound(rec, i, i, async () => {
      const fails = [];
      const old = await newPage(A.agent, 'old');
      const oldKid = (await A.agent.post('/api/pages', { parentId: old, title: 'k' })).json.page.id;
      const recent = await newPage(A.agent, 'recent');
      await db.query(`insert into doc_updates(page_id, seq, data) values ($1, 1, '\\x00')`, [oldKid]);
      await db.query(`insert into page_versions(id, page_id, state, up_to_seq, reason) values ($1, $2, '\\x00', 1, 'auto')`, ['v' + i, oldKid]);
      await A.agent.del(`/api/pages/${old}`);
      await A.agent.del(`/api/pages/${recent}`);
      await db.query(`update pages set deleted_at = now() - interval '31 days' where id in ($1, $2)`, [old, oldKid]);
      await db.query(`update pages set deleted_at = now() - interval '29 days' where id = $1`, [recent]);
      const r = spawnSync(process.execPath, [APP_DIR + 'node_modules/tsx/dist/cli.mjs', APP_DIR + 'scripts/purge-trash.ts'],
        { cwd: APP_DIR, env: { ...process.env, DATABASE_URL: DB_URL, ...SECRETS }, encoding: 'utf8' });
      if (r.status !== 0) fails.push('清理程式失敗 ' + r.stderr);
      const left = (await db.query('select id from pages where id = any($1)', [[old, oldKid, recent]])).rows.map(x => x.id);
      if (left.includes(old) || left.includes(oldKid)) fails.push('超過 30 天的頁面沒有被永久刪除');
      if (!left.includes(recent)) fails.push('未滿 30 天的頁面被刪除');
      const orphan = (await db.query('select (select count(*) from doc_updates where page_id=$1) + (select count(*) from page_versions where page_id=$1) as n', [oldKid])).rows[0].n;
      if (Number(orphan)) fails.push('永久刪除後仍殘留協作資料');
      return [fails];
    });
  }
  return rec.save();
}

// ---- PAGE-05 兩人隨機操作頁面樹：不變量 ----
export async function page05(n) {
  const rec = new Recorder('PAGE-05', '兩人同時隨機建立、移動、改名、刪除、還原：沒有循環、沒有掛在已刪除頁面下的頁面、API 與資料庫一致');
  const env = await bootEnv({ users: 2 });
  for (let i = 0; i < n; i++) {
    const seed = 50500 + i;
    await runRound(rec, i, seed, async () => {
      const rnd = rng(seed);
      const fails = [];
      const statuses = {};
      const ids = (await tree(env.users[0].agent)).map(p => p.id);
      const pick = () => ids.length ? ids[Math.floor(rnd() * ids.length)] : null;
      const actor = async ag => {
        for (let k = 0; k < 40; k++) {
          const r = rnd();
          let res;
          if (r < 0.3 || ids.length < 3) {
            res = await ag.post('/api/pages', { parentId: rnd() < 0.5 ? pick() : null, title: 't' + k, spaceId: env.shared });
            if (res.status === 201) ids.push(res.json.page.id);
          } else if (r < 0.55) res = await ag.patch(`/api/pages/${pick()}`, { parentId: rnd() < 0.2 ? null : pick(), afterId: undefined });
          else if (r < 0.7) res = await ag.patch(`/api/pages/${pick()}`, { title: '改' + k });
          else if (r < 0.85) res = await ag.del(`/api/pages/${pick()}`);
          else res = await ag.post(`/api/pages/${pick()}/restore`);
          statuses[res.status] = (statuses[res.status] || 0) + 1;
          if (res.status >= 500) fails.push('伺服器錯誤 ' + res.status + ' ' + res.text.slice(0, 120));
        }
      };
      await Promise.all(env.users.map(u => actor(u.agent)));
      const q = async sql => (await db.query(sql)).rows[0].n;
      if (await q(`with recursive walk(id, parent_id, depth) as (select id, parent_id, 0 from pages union all
          select w.id, p.parent_id, w.depth + 1 from walk w join pages p on p.id = w.parent_id where w.depth < 500)
          select count(*)::int as n from walk where parent_id = id`)) fails.push('出現循環');
      if (await q(`select count(*)::int as n from pages c join pages p on p.id = c.parent_id where c.deleted_at is null and p.deleted_at is not null`)) fails.push('有頁面掛在已刪除的頁面底下');
      if (await q(`select count(*)::int as n from pages where (deleted_at is null) <> (trash_batch is null)`)) fails.push('deleted_at 與 trash_batch 不一致');
      // M2-s：子頁面與上層同空間；所有頁面都在兩人共同所屬的共享空間
      if (await q(`select count(*)::int as n from pages c join pages p on p.id = c.parent_id where c.space_id <> p.space_id`)) fails.push('子頁面與上層不在同一個空間');
      if ((await db.query('select count(*)::int as n from pages where space_id <> $1', [env.shared])).rows[0].n) fails.push('有頁面不在共享空間');
      const api = (await tree(env.users[1].agent)).map(p => p.id).sort();
      const dbIds = (await db.query('select id from pages where deleted_at is null order by id')).rows.map(r => r.id).sort();
      if (JSON.stringify(api) !== JSON.stringify(dbIds)) fails.push('API 頁面樹與資料庫不一致');
      return [fails, { statuses, pages: dbIds.length }];
    });
  }
  return rec.save();
}

export { SECRETS, collabToken };
