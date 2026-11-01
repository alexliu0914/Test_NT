// 頁面樹變動推送（Server-Sent Events）：資料庫 NOTIFY pages_changed → 推給開著的瀏覽器（PAGE-01）
// M2-s：通知帶空間 id，只推給該空間的成員；成員變動（space_access_changed）時重新查詢這位使用者所屬的空間，
// 加入或失去空間時推送 changed（瀏覽器重新載入頁面樹，失去權限的頁面就此消失）
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { requireUser } from '@/lib/guard';
import { memberSpaceIds } from '@/lib/access';
export const dynamic = 'force-dynamic';

const g = globalThis as unknown as { __treeBus?: EventEmitter };
function bus(): EventEmitter {
  if (g.__treeBus) return g.__treeBus;
  const em = new EventEmitter();
  em.setMaxListeners(1000);
  g.__treeBus = em;
  (async function listen() {
    for (;;) {
      try {
        const c = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'web-listen' });
        await c.connect();
        c.on('notification', n => em.emit(n.channel === 'space_access_changed' ? 'access' : 'changed', n.payload));
        await c.query('listen pages_changed');
        await c.query('listen space_access_changed');
        em.emit('changed', 'reconnected');
        await new Promise((_, rej) => { c.on('error', rej); c.on('end', () => rej(new Error('end'))); });
      } catch { await new Promise(r => setTimeout(r, 500)); }
    }
  })();
  return em;
}

export async function GET(req: Request) {
  const a = await requireUser(req);
  if (a instanceof Response) return a;
  const em = bus();
  const userId = a.user.id;
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(ctrl) {
      const send = (s: string) => { try { ctrl.enqueue(enc.encode(s)); } catch { cleanup(); } };
      // 合併 50 毫秒內的多次變動，只推一次
      let t: ReturnType<typeof setTimeout> | null = null;
      const fire = () => { if (!t) t = setTimeout(() => { t = null; send('event: changed\ndata: {}\n\n'); }, 50); };
      // 這位使用者所屬的空間；重新連上資料庫（reconnected）或成員變動時重新查詢
      // 每次重新查詢都取新的結果（不沿用進行中的查詢，避免漏掉剛發生的成員變動）；只採用最後一次查詢的結果
      let mine = new Set<string>();
      let gen = 0;
      const reload = () => {
        const my = ++gen;
        return memberSpaceIds(userId).then(ids => { if (my === gen) mine = new Set(ids); }, () => {});
      };
      const ready = reload();
      const onChange = (payload: string) => {
        if (payload === 'reconnected') { reload().then(fire); return; }
        ready.then(() => { if (mine.has(payload)) fire(); });
      };
      const onAccess = () => {
        const before = mine;
        reload().then(() => {
          const changed = before.size !== mine.size || [...before].some(id => !mine.has(id));
          if (changed) fire();
        });
      };
      const ping = setInterval(() => send(': ping\n\n'), 25000);
      em.on('changed', onChange);
      em.on('access', onAccess);
      cleanup = () => { em.off('changed', onChange); em.off('access', onAccess); clearInterval(ping); if (t) clearTimeout(t); };
      send('event: ready\ndata: {}\n\n');
      req.signal.addEventListener('abort', () => { cleanup(); try { ctrl.close(); } catch { /* 已關閉 */ } });
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } });
}
