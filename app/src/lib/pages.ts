// 頁面樹（計畫書 7.2、FR-03）
// - 排序用分數排序鍵：移動一頁只更新一筆
// - 移動時拒絕移到自己或自己的子孫底下（PAGE-02）
// - 刪除：整棵子樹標上同一個 trash_batch 進垃圾桶，30 天內可整批還原（PAGE-03）；超過 30 天永久刪除（PAGE-04）
// - 所有改變樹狀結構的操作都在交易中持有工作區層級的 advisory lock，避免兩個並行移動造成循環
import { generateKeyBetween } from 'fractional-indexing';
import type { PoolClient } from 'pg';
import { pool } from './db';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TRASH_DAYS = 30;
export const MAX_TITLE = 300;
export const MAX_ICON = 16;

export type PageRow = { id: string; parentId: string | null; title: string; icon: string | null; position: string; updatedAt: string };
export type TrashRow = { id: string; title: string; icon: string | null; deletedAt: string; count: number };

export class PageError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

let wsCache: string | null = null;
export async function workspaceId(): Promise<string> {
  if (wsCache) return wsCache;
  const r = await pool.query('select id from workspaces order by created_at limit 1');
  if (!r.rows[0]) throw new PageError(500, 'no_workspace', '工作區尚未建立');
  wsCache = r.rows[0].id;
  return wsCache!;
}

async function tx<T>(fn: (c: PoolClient, ws: string) => Promise<T>): Promise<T> {
  const ws = await workspaceId();
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', ['tree:' + ws]);
    const r = await fn(c, ws);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}

const mapRow = (r: Record<string, unknown>): PageRow => ({
  id: r.id as string, parentId: (r.parent_id as string) ?? null, title: r.title as string, icon: (r.icon as string) ?? null,
  position: r.position as string, updatedAt: (r.updated_at as Date).toISOString(),
});

export async function listTree(): Promise<PageRow[]> {
  const ws = await workspaceId();
  const r = await pool.query(
    `select id, parent_id, title, icon, position, updated_at from pages
      where workspace_id=$1 and deleted_at is null order by parent_id nulls first, position, id`, [ws]);
  return r.rows.map(mapRow);
}

export async function listTrash(): Promise<TrashRow[]> {
  const ws = await workspaceId();
  // 每個垃圾桶批次的根：父頁面不在同一批次
  const r = await pool.query(
    `select p.id, p.title, p.icon, p.deleted_at,
            (select count(*)::int from pages q where q.trash_batch = p.trash_batch) as count
       from pages p
      where p.workspace_id=$1 and p.deleted_at is not null
        and not exists (select 1 from pages par where par.id = p.parent_id and par.trash_batch = p.trash_batch)
      order by p.deleted_at desc`, [ws]);
  return r.rows.map(x => ({ id: x.id, title: x.title, icon: x.icon, deletedAt: x.deleted_at.toISOString(), count: x.count }));
}

async function liveParent(c: PoolClient, ws: string, parentId: string | null) {
  if (parentId === null) return;
  if (!UUID_RE.test(parentId)) throw new PageError(400, 'bad_parent', '上層頁面不正確');
  const r = await c.query('select 1 from pages where id=$1 and workspace_id=$2 and deleted_at is null', [parentId, ws]);
  if (!r.rows[0]) throw new PageError(404, 'parent_not_found', '上層頁面不存在');
}

// 在 parentId 之下、afterId 之後的位置（afterId 為 null＝最前面；undefined＝最後面）
async function positionFor(c: PoolClient, ws: string, parentId: string | null, afterId: string | null | undefined, excludeId?: string) {
  const sibs = (await c.query(
    `select id, position from pages where workspace_id=$1 and parent_id is not distinct from $2 and deleted_at is null
       and ($3::uuid is null or id <> $3) order by position, id`, [ws, parentId, excludeId ?? null])).rows as { id: string; position: string }[];
  if (afterId === undefined) return generateKeyBetween(sibs.at(-1)?.position ?? null, null);
  if (afterId === null) return generateKeyBetween(null, sibs[0]?.position ?? null);
  const i = sibs.findIndex(s => s.id === afterId);
  if (i < 0) throw new PageError(400, 'bad_after', '指定的相鄰頁面不在同一層');
  // 相鄰兩頁排序鍵相同時（極少見的並行插入）退到下一個不同的鍵
  let j = i + 1;
  while (j < sibs.length && sibs[j].position === sibs[i].position) j++;
  return generateKeyBetween(sibs[i].position, sibs[j]?.position ?? null);
}

function cleanTitle(t: unknown): string {
  if (t === undefined || t === null) return '';
  if (typeof t !== 'string') throw new PageError(400, 'bad_title', '標題格式不正確');
  const s = t.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (s.length > MAX_TITLE) throw new PageError(400, 'title_too_long', `標題最多 ${MAX_TITLE} 字`);
  return s;
}

function cleanIcon(i: unknown): string | null {
  if (i === undefined || i === null || i === '') return null;
  if (typeof i !== 'string' || [...i].length > MAX_ICON || /[<>\u0000-\u001f]/.test(i)) throw new PageError(400, 'bad_icon', '圖示格式不正確');
  return i;
}

export async function createPage(userId: string, body: { parentId?: string | null; afterId?: string | null; title?: unknown; icon?: unknown }) {
  return tx(async (c, ws) => {
    const parentId = body.parentId ?? null;
    await liveParent(c, ws, parentId);
    const pos = await positionFor(c, ws, parentId, body.afterId);
    const r = await c.query(
      `insert into pages(workspace_id, parent_id, title, icon, position, created_by)
       values ($1,$2,$3,$4,$5,$6) returning id, parent_id, title, icon, position, updated_at`,
      [ws, parentId, cleanTitle(body.title), cleanIcon(body.icon), pos, userId]);
    return mapRow(r.rows[0]);
  });
}

export async function updatePage(id: string, body: { title?: unknown; icon?: unknown; parentId?: string | null; afterId?: string | null }) {
  if (!UUID_RE.test(id)) throw new PageError(404, 'not_found', '頁面不存在');
  return tx(async (c, ws) => {
    const cur = (await c.query('select id, parent_id from pages where id=$1 and workspace_id=$2 and deleted_at is null for update', [id, ws])).rows[0];
    if (!cur) throw new PageError(404, 'not_found', '頁面不存在');
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if ('title' in body) set('title', cleanTitle(body.title));
    if ('icon' in body) set('icon', cleanIcon(body.icon));
    if ('parentId' in body || 'afterId' in body) {
      const parentId = 'parentId' in body ? (body.parentId ?? null) : cur.parent_id;
      if (parentId !== null) {
        await liveParent(c, ws, parentId);
        // 拒絕移到自己或自己的子孫底下（PAGE-02）
        const cyc = await c.query(
          `with recursive anc(id, parent_id) as (
             select id, parent_id from pages where id=$1
             union all select p.id, p.parent_id from pages p join anc on p.id = anc.parent_id)
           select 1 from anc where id=$2 limit 1`, [parentId, id]);
        if (cyc.rows[0]) throw new PageError(409, 'cycle', '不能把頁面移到自己或自己的子頁面底下');
      }
      set('parent_id', parentId);
      set('position', await positionFor(c, ws, parentId, 'afterId' in body ? body.afterId : undefined, id));
    }
    if (sets.length === 0) throw new PageError(400, 'nothing_to_update', '沒有要更新的欄位');
    vals.push(id);
    const r = await c.query(`update pages set ${sets.join(', ')}, updated_at=now() where id=$${vals.length}
                             returning id, parent_id, title, icon, position, updated_at`, vals);
    return mapRow(r.rows[0]);
  });
}

export async function trashPage(id: string) {
  if (!UUID_RE.test(id)) throw new PageError(404, 'not_found', '頁面不存在');
  return tx(async (c, ws) => {
    const r = await c.query(
      `with recursive sub(id) as (
         select id from pages where id=$1 and workspace_id=$2 and deleted_at is null
         union all select p.id from pages p join sub on p.parent_id = sub.id where p.deleted_at is null)
       update pages set deleted_at=now(), trash_batch=$3, updated_at=now() where id in (select id from sub) returning id`,
      [id, ws, crypto.randomUUID()]);
    if (!r.rows.length) throw new PageError(404, 'not_found', '頁面不存在');
    return { trashed: r.rows.length };
  });
}

export async function restorePage(id: string) {
  if (!UUID_RE.test(id)) throw new PageError(404, 'not_found', '頁面不存在');
  return tx(async (c, ws) => {
    const root = (await c.query('select id, parent_id, trash_batch from pages where id=$1 and workspace_id=$2 and deleted_at is not null', [id, ws])).rows[0];
    if (!root) throw new PageError(404, 'not_in_trash', '垃圾桶裡沒有這個頁面');
    // 整批還原。指定的頁面不一定是這一批的根（API 可指定批次中的任何頁面），所以還原後檢查這一批中每個頁面：
    // 上層仍在垃圾桶裡（屬於另一批）的，改掛到最上層的最後面（F-M1-04）
    const n = await c.query('update pages set deleted_at=null, trash_batch=null, updated_at=now() where trash_batch=$1 returning id', [root.trash_batch]);
    const restored = n.rows.map(r => r.id as string);
    const orphans = (await c.query(
      `select c.id from pages c join pages p on p.id = c.parent_id
        where c.id = any($1::uuid[]) and p.deleted_at is not null order by c.position, c.id`, [restored])).rows.map(r => r.id as string);
    for (const o of orphans) {
      await c.query('update pages set parent_id=null, position=$1 where id=$2', [await positionFor(c, ws, null, undefined, o), o]);
    }
    const parentId = (await c.query('select parent_id from pages where id=$1', [id])).rows[0].parent_id ?? null;
    return { restored: restored.length, parentId, reattached: orphans.length };
  });
}

// 永久刪除超過 30 天的垃圾桶批次（PAGE-04）；子頁面與協作資料以外鍵 cascade 一起刪除
export async function purgeTrash(days = TRASH_DAYS) {
  return tx(async (c, ws) => {
    const r = await c.query(
      `delete from pages where workspace_id=$1 and deleted_at is not null and deleted_at < now() - make_interval(days => $2)
         and trash_batch is not null returning id`, [ws, days]);
    return { purged: r.rows.length };
  });
}

export async function pageExists(id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const ws = await workspaceId();
  return !!(await pool.query('select 1 from pages where id=$1 and workspace_id=$2 and deleted_at is null', [id, ws])).rows[0];
}
