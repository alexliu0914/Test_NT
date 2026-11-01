// 頁面樹（計畫書 7.2、FR-03；M2-s 起頁面屬於空間，FR-20）
// - 排序用分數排序鍵：移動一頁只更新一筆；頂層頁面依空間各自排序
// - 移動時拒絕移到自己或自己的子孫底下（PAGE-02）
// - 刪除：整棵子樹標上同一個 trash_batch 進垃圾桶，30 天內可整批還原（PAGE-03）；超過 30 天永久刪除（PAGE-04）
// - 所有改變樹狀結構的操作都在交易中持有工作區層級的 advisory lock，避免兩個並行移動造成循環
// - 授權（M2-s）：來源與目的空間都必須是成員，在同一個交易中以鎖定順序檢查（access.ts）；無權限一律回 404
// - 跨空間移動：必須帶 move-preview 的確認碼，在頁面樹鎖與兩個空間列 FOR UPDATE 下重新計算，不一致回 409（P0-02）
import { createHash } from 'node:crypto';
import { generateKeyBetween } from 'fractional-indexing';
import type { PoolClient } from 'pg';
import { pool } from './db';
import { initialDocUpdate } from '@shared/initial-doc.js';
import { AccessError, tx, lockSpaces, lockMembership, memberSpaceIds, personalSpaceId, canAccessPage, workspaceId, notFound } from './access';

export { workspaceId };
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TRASH_DAYS = 30;
export const MAX_TITLE = 300;
export const MAX_ICON = 16;

export type PageRow = { id: string; parentId: string | null; spaceId: string; title: string; icon: string | null; position: string; updatedAt: string };
export type TrashRow = { id: string; spaceId: string; title: string; icon: string | null; deletedAt: string; count: number };
export type SpaceMember = { id: string; name: string; email: string; role: 'owner' | 'member' };
export type SpaceRow = { id: string; kind: 'personal' | 'shared'; name: string; ownerId: string; members: SpaceMember[] };

// 頁面錯誤與授權錯誤同一類（路由以 instanceof PageError 轉成 JSON 回應）
export const PageError = AccessError;
export type PageError = AccessError;

const mapRow = (r: Record<string, unknown>): PageRow => ({
  id: r.id as string, parentId: (r.parent_id as string) ?? null, spaceId: r.space_id as string, title: r.title as string, icon: (r.icon as string) ?? null,
  position: r.position as string, updatedAt: (r.updated_at as Date).toISOString(),
});

const COLS = 'id, parent_id, space_id, title, icon, position, updated_at';

// 使用者看得到的空間（個人空間在前，共享空間依建立時間）與成員
export async function listSpaces(userId: string): Promise<SpaceRow[]> {
  const r = await pool.query(
    `select s.id, s.kind, s.name, s.owner_id, s.created_at,
            coalesce(json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'role', m2.role)
                     order by (m2.role = 'owner') desc, u.name, u.id), '[]') as members
       from spaces s
       join space_members me on me.space_id = s.id and me.user_id = $1
       join space_members m2 on m2.space_id = s.id
       join "user" u on u.id = m2.user_id
      group by s.id
      order by (s.kind = 'personal') desc, s.created_at, s.id`, [userId]);
  return r.rows.map(x => ({ id: x.id, kind: x.kind, name: x.name, ownerId: x.owner_id, members: x.members }));
}

export async function listTree(userId: string): Promise<PageRow[]> {
  const r = await pool.query(
    `select ${COLS} from pages
      where deleted_at is null and space_id in (select space_id from space_members where user_id = $1)
      order by space_id, parent_id nulls first, position, id`, [userId]);
  return r.rows.map(mapRow);
}

export async function listTrash(userId: string): Promise<TrashRow[]> {
  // 每個垃圾桶批次的根：父頁面不在同一批次
  const r = await pool.query(
    `select p.id, p.space_id, p.title, p.icon, p.deleted_at,
            (select count(*)::int from pages q where q.trash_batch = p.trash_batch) as count
       from pages p
      where p.deleted_at is not null and p.space_id in (select space_id from space_members where user_id = $1)
        and not exists (select 1 from pages par where par.id = p.parent_id and par.trash_batch = p.trash_batch)
      order by p.deleted_at desc`, [userId]);
  return r.rows.map(x => ({ id: x.id, spaceId: x.space_id, title: x.title, icon: x.icon, deletedAt: x.deleted_at.toISOString(), count: x.count }));
}

// 在 parentId 之下（頂層時為 spaceId 的頂層）、afterId 之後的位置（afterId 為 null＝最前面；undefined＝最後面）
async function positionFor(c: PoolClient, spaceId: string, parentId: string | null, afterId: string | null | undefined, excludeId?: string) {
  const sibs = (await c.query(
    `select id, position from pages where space_id=$1 and parent_id is not distinct from $2 and deleted_at is null
       and ($3::uuid is null or id <> $3) order by position, id`, [spaceId, parentId, excludeId ?? null])).rows as { id: string; position: string }[];
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

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

// 不加鎖讀取頁面目前所在的空間（之後在交易中依鎖定順序鎖住空間與頁面，再確認沒有變動）
async function pageSpace(c: PoolClient, id: string, { trashed = false } = {}): Promise<{ space_id: string; parent_id: string | null; trash_batch: string | null } | null> {
  const r = await c.query(`select space_id, parent_id, trash_batch from pages where id=$1 and deleted_at is ${trashed ? 'not null' : 'null'}`, [id]);
  return r.rows[0] ?? null;
}

// 鎖住頁面列（鎖定順序第 4 層）並確認仍在預期的空間
async function lockPage(c: PoolClient, id: string, spaceId: string, { trashed = false } = {}) {
  const r = (await c.query(`select id, parent_id, space_id from pages where id=$1 and deleted_at is ${trashed ? 'not null' : 'null'} for update`, [id])).rows[0];
  if (!r || r.space_id !== spaceId) throw notFound();
  return r as { id: string; parent_id: string | null; space_id: string };
}

export async function createPage(userId: string, body: { parentId?: string | null; afterId?: string | null; title?: unknown; icon?: unknown; spaceId?: unknown }) {
  return tx(async (c, ws) => {
    const parentId = body.parentId ?? null;
    let spaceId: string;
    if (parentId !== null) {
      if (!isUuid(parentId)) throw new PageError(400, 'bad_parent', '上層頁面不正確');
      const par = await pageSpace(c, parentId);
      if (!par) throw new PageError(404, 'parent_not_found', '上層頁面不存在');
      spaceId = par.space_id;
    } else if (body.spaceId !== undefined && body.spaceId !== null) {
      if (!isUuid(body.spaceId)) throw notFound('空間');
      spaceId = body.spaceId;
    } else {
      spaceId = await personalSpaceId(userId, c);
    }
    if (!(await lockMembership(c, userId, [spaceId]))) throw parentId !== null ? new PageError(404, 'parent_not_found', '上層頁面不存在') : notFound('空間');
    if (parentId !== null) {
      const par = (await c.query('select space_id from pages where id=$1 and deleted_at is null for share', [parentId])).rows[0];
      if (!par || par.space_id !== spaceId) throw new PageError(404, 'parent_not_found', '上層頁面不存在');
    }
    const pos = await positionFor(c, spaceId, parentId, body.afterId);
    const r = await c.query(
      `insert into pages(workspace_id, space_id, parent_id, title, icon, position, created_by)
       values ($1,$2,$3,$4,$5,$6,$7) returning ${COLS}`,
      [ws, spaceId, parentId, cleanTitle(body.title), cleanIcon(body.icon), pos, userId]);
    // 新頁面的文件骨架（固定 clientID）：兩人同時開始輸入時不會各自建立一份（F-M1-05）
    await c.query('insert into doc_states(page_id, state, up_to_seq) values ($1, $2, 0)', [r.rows[0].id, Buffer.from(initialDocUpdate())]);
    return mapRow(r.rows[0]);
  }, { treeLock: true });
}

// ---- 跨空間移動的預覽與確認碼（P0-02） ----
type MoveTarget = { spaceId?: unknown; parentId?: unknown };

async function subtreeIds(c: PoolClient, id: string): Promise<string[]> {
  // 包含垃圾桶中的子孫：子頁面必須與上層同空間（資料庫觸發器檢查），整棵一起移動
  const r = await c.query(
    `with recursive sub(id) as (select id from pages where id=$1 union all select p.id from pages p join sub on p.parent_id = sub.id)
     select id from sub order by id`, [id]);
  return r.rows.map(x => x.id as string);
}

async function members(c: PoolClient, spaceId: string): Promise<{ id: string; name: string; email: string }[]> {
  const r = await c.query(
    `select u.id, u.name, u.email from space_members m join "user" u on u.id = m.user_id where m.space_id=$1 order by u.name, u.id`, [spaceId]);
  return r.rows;
}

function confirmCode(from: { id: string; members_version: number }, to: { id: string; members_version: number }, ids: string[]) {
  return createHash('sha256').update(`${from.id}:${from.members_version}|${to.id}:${to.members_version}|${ids.join(',')}`).digest('hex').slice(0, 32);
}

async function buildPreview(c: PoolClient, pageId: string, title: string, from: { id: string; name: string; kind: string; members_version: number }, to: { id: string; name: string; kind: string; members_version: number }) {
  const ids = await subtreeIds(c, pageId);
  const live = (await c.query('select count(*)::int as n from pages where id = any($1::uuid[]) and deleted_at is null', [ids])).rows[0].n as number;
  const [fm, tm] = [await members(c, from.id), await members(c, to.id)];
  const fset = new Set(fm.map(u => u.id));
  const tset = new Set(tm.map(u => u.id));
  return {
    page: { id: pageId, title },
    from: { id: from.id, name: from.name, kind: from.kind },
    to: { id: to.id, name: to.name, kind: to.kind },
    gained: tm.filter(u => !fset.has(u.id)),
    lost: fm.filter(u => !tset.has(u.id)),
    kept: tm.filter(u => fset.has(u.id)),
    count: live,
    descendants: live - 1,
    confirm: confirmCode(from, to, ids),
  };
}
export type MovePreview = Awaited<ReturnType<typeof buildPreview>>;

async function resolveTargetSpace(c: PoolClient, target: MoveTarget, current: string): Promise<string> {
  if (target.parentId !== undefined && target.parentId !== null) {
    if (!isUuid(target.parentId)) throw new PageError(400, 'bad_parent', '上層頁面不正確');
    const par = await pageSpace(c, target.parentId);
    if (!par) throw new PageError(404, 'parent_not_found', '上層頁面不存在');
    return par.space_id;
  }
  if (target.spaceId !== undefined && target.spaceId !== null) {
    if (!isUuid(target.spaceId)) throw notFound('空間');
    return target.spaceId;
  }
  return current;
}

export async function movePreview(userId: string, id: string, target: MoveTarget): Promise<MovePreview> {
  if (!isUuid(id)) throw notFound();
  return tx(async c => {
    const cur = await pageSpace(c, id);
    if (!cur) throw notFound();
    const dst = await resolveTargetSpace(c, target, cur.space_id);
    // 先依 id 遞增鎖住兩個空間列，再分別檢查成員身分（鎖定順序 2→3）
    const sp = await lockSpaces(c, [cur.space_id, dst], 'share');
    if (!(await lockMembership(c, userId, [cur.space_id]))) throw notFound();
    if (!sp.get(dst) || !(await lockMembership(c, userId, [dst]))) throw target.parentId ? new PageError(404, 'parent_not_found', '上層頁面不存在') : notFound('空間');
    const p = (await c.query('select title, space_id from pages where id=$1 and deleted_at is null', [id])).rows[0];
    if (!p || p.space_id !== cur.space_id) throw notFound();
    return buildPreview(c, id, p.title, sp.get(cur.space_id)!, sp.get(dst)!);
  });
}

export async function updatePage(userId: string, id: string, body: { title?: unknown; icon?: unknown; parentId?: string | null; afterId?: string | null; spaceId?: unknown; confirm?: unknown }) {
  if (!isUuid(id)) throw notFound();
  return tx(async c => {
    const cur0 = await pageSpace(c, id);
    if (!cur0) throw notFound();
    const moving = 'parentId' in body || 'afterId' in body || ('spaceId' in body && body.spaceId !== undefined);
    const parentId = 'parentId' in body ? (body.parentId ?? null) : (moving && body.spaceId && body.spaceId !== cur0.space_id ? null : cur0.parent_id);
    const dst = moving ? await resolveTargetSpace(c, { parentId, spaceId: parentId === null ? (body.spaceId ?? cur0.space_id) : undefined }, cur0.space_id) : cur0.space_id;
    const cross = dst !== cur0.space_id;
    // 鎖定順序：空間列（跨空間時兩個都 FOR UPDATE）→ 成員列 → 頁面列
    let spaces: Awaited<ReturnType<typeof lockSpaces>> | null = null;
    if (cross) spaces = await lockSpaces(c, [cur0.space_id, dst], 'update');
    if (!(await lockMembership(c, userId, [cur0.space_id]))) throw notFound();
    if (cross && !(await lockMembership(c, userId, [dst]))) throw parentId !== null ? new PageError(404, 'parent_not_found', '上層頁面不存在') : notFound('空間');
    const cur = await lockPage(c, id, cur0.space_id);
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if ('title' in body) set('title', cleanTitle(body.title));
    if ('icon' in body) set('icon', cleanIcon(body.icon));
    if (moving) {
      if (parentId !== null) {
        const par = (await c.query('select space_id from pages where id=$1 and deleted_at is null for share', [parentId])).rows[0];
        if (!par || par.space_id !== dst) throw new PageError(404, 'parent_not_found', '上層頁面不存在');
        // 拒絕移到自己或自己的子孫底下（PAGE-02）
        const cyc = await c.query(
          `with recursive anc(id, parent_id) as (
             select id, parent_id from pages where id=$1
             union all select p.id, p.parent_id from pages p join anc on p.id = anc.parent_id)
           select 1 from anc where id=$2 limit 1`, [parentId, id]);
        if (cyc.rows[0]) throw new PageError(409, 'cycle', '不能把頁面移到自己或自己的子頁面底下');
      }
      if (cross) {
        const p = (await c.query('select title from pages where id=$1', [id])).rows[0];
        const preview = await buildPreview(c, id, p.title, spaces!.get(cur0.space_id)!, spaces!.get(dst)!);
        if (body.confirm !== preview.confirm) {
          const e = new PageError(409, 'move_confirm_required', '移到其他空間會改變誰看得到這些頁面，請確認') as PageError & { preview?: MovePreview };
          e.preview = preview;
          throw e;
        }
        const ids = await subtreeIds(c, id);
        await c.query('select id from pages where id = any($1::uuid[]) order by id for update', [ids]);
        await c.query('update pages set space_id=$1 where id = any($2::uuid[])', [dst, ids]);
      }
      set('parent_id', parentId);
      set('position', await positionFor(c, dst, parentId, 'afterId' in body ? body.afterId : undefined, id));
    }
    if (sets.length === 0) throw new PageError(400, 'nothing_to_update', '沒有要更新的欄位');
    vals.push(cur.id);
    const r = await c.query(`update pages set ${sets.join(', ')}, updated_at=now() where id=$${vals.length} returning ${COLS}`, vals);
    return mapRow(r.rows[0]);
  }, { treeLock: true });
}

export async function trashPage(userId: string, id: string) {
  if (!isUuid(id)) throw notFound();
  return tx(async c => {
    const cur = await pageSpace(c, id);
    if (!cur || !(await lockMembership(c, userId, [cur.space_id]))) throw notFound();
    await lockPage(c, id, cur.space_id);
    const r = await c.query(
      `with recursive sub(id) as (
         select id from pages where id=$1 and deleted_at is null
         union all select p.id from pages p join sub on p.parent_id = sub.id where p.deleted_at is null)
       update pages set deleted_at=now(), trash_batch=$2, updated_at=now() where id in (select id from sub) returning id`,
      [id, crypto.randomUUID()]);
    return { trashed: r.rows.length };
  }, { treeLock: true });
}

export async function restorePage(userId: string, id: string) {
  if (!isUuid(id)) throw notFound();
  return tx(async c => {
    const root0 = await pageSpace(c, id, { trashed: true });
    if (!root0 || !(await lockMembership(c, userId, [root0.space_id]))) throw new PageError(404, 'not_in_trash', '垃圾桶裡沒有這個頁面');
    const root = (await c.query('select id, space_id, trash_batch from pages where id=$1 and deleted_at is not null for update', [id])).rows[0];
    if (!root || root.space_id !== root0.space_id) throw new PageError(404, 'not_in_trash', '垃圾桶裡沒有這個頁面');
    // 整批還原。指定的頁面不一定是這一批的根（API 可指定批次中的任何頁面），所以還原後檢查這一批中每個頁面：
    // 上層仍在垃圾桶裡（屬於另一批）的，改掛到所在空間最上層的最後面（F-M1-04）
    const n = await c.query('update pages set deleted_at=null, trash_batch=null, updated_at=now() where trash_batch=$1 returning id', [root.trash_batch]);
    const restored = n.rows.map(r => r.id as string);
    const orphans = (await c.query(
      `select c.id from pages c join pages p on p.id = c.parent_id
        where c.id = any($1::uuid[]) and p.deleted_at is not null order by c.position, c.id`, [restored])).rows.map(r => r.id as string);
    for (const o of orphans) {
      await c.query('update pages set parent_id=null, position=$1 where id=$2', [await positionFor(c, root.space_id, null, undefined, o), o]);
    }
    const parentId = (await c.query('select parent_id from pages where id=$1', [id])).rows[0].parent_id ?? null;
    return { restored: restored.length, parentId, reattached: orphans.length, spaceId: root.space_id as string };
  }, { treeLock: true });
}

// 永久刪除超過 30 天的垃圾桶批次（PAGE-04）；子頁面與協作資料以外鍵 cascade 一起刪除
export async function purgeTrash(days = TRASH_DAYS) {
  return tx(async (c, ws) => {
    const r = await c.query(
      `delete from pages where workspace_id=$1 and deleted_at is not null and deleted_at < now() - make_interval(days => $2)
         and trash_batch is not null returning id`, [ws, days]);
    return { purged: r.rows.length };
  }, { treeLock: true });
}

// 頁面存在、不在垃圾桶，且使用者是所屬空間的成員
export async function pageVisible(userId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return canAccessPage(userId, id);
}

export { memberSpaceIds };
