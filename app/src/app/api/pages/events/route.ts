// 頁面樹變動推送（Server-Sent Events）：資料庫 NOTIFY pages_changed → 推給所有開著的瀏覽器（PAGE-01）
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { requireUser } from '@/lib/guard';
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
        c.on('notification', n => em.emit('changed', n.payload));
        await c.query('listen pages_changed');
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
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(ctrl) {
      const send = (s: string) => { try { ctrl.enqueue(enc.encode(s)); } catch { cleanup(); } };
      // 合併 50 毫秒內的多次變動，只推一次
      let t: ReturnType<typeof setTimeout> | null = null;
      const onChange = () => { if (!t) t = setTimeout(() => { t = null; send('event: changed\ndata: {}\n\n'); }, 50); };
      const ping = setInterval(() => send(': ping\n\n'), 25000);
      em.on('changed', onChange);
      cleanup = () => { em.off('changed', onChange); clearInterval(ping); if (t) clearTimeout(t); };
      send('event: ready\ndata: {}\n\n');
      req.signal.addEventListener('abort', () => { cleanup(); try { ctrl.close(); } catch { /* 已關閉 */ } });
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } });
}
