// 空間與成員（M2-s，FR-20）
// - 每個帳號一個個人空間（帳號建立時由資料庫觸發器在同一個交易中建立），只有本人
// - 共享空間：建立者管理成員、改名、刪除；成員都可以編輯，可以自己退出；建立者不能退出，只能刪除空間
// - 非成員一律 404（不透露空間是否存在）；成員但不是建立者 403
// - 鎖定順序（access.ts）：頁面樹鎖 → spaces → space_members → pages
// - 撤銷類操作（移除、退出、刪除）以 FOR UPDATE 鎖住空間列，與協作提交時的 FOR SHARE 重新授權必定一前一後（P0-01）
import type { PoolClient } from 'pg';
import { pool } from './db';
import { AccessError, tx, lockSpaces, notFound } from './access';
import { UUID_RE } from './pages';

export const MAX_SPACE_NAME = 100;
export const MAX_SPACES_PER_USER = 50;

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

function cleanName(n: unknown): string {
  if (typeof n !== 'string') throw new AccessError(400, 'bad_name', '請輸入空間名稱');
  const s = n.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) throw new AccessError(400, 'bad_name', '請輸入空間名稱');
  if (s.length > MAX_SPACE_NAME) throw new AccessError(400, 'name_too_long', `空間名稱最多 ${MAX_SPACE_NAME} 字`);
  return s;
}

async function isMember(c: Pick<PoolClient, 'query'>, spaceId: string, userId: string, lock: 'share' | 'update' = 'share') {
  const r = await c.query(`select role from space_members where space_id=$1 and user_id=$2 for ${lock}`, [spaceId, userId]);
  return r.rows[0]?.role as 'owner' | 'member' | undefined;
}

export async function createSpace(userId: string, name: unknown) {
  const n = cleanName(name);
  return tx(async c => {
    const cnt = (await c.query(`select count(*)::int as n from spaces where owner_id=$1 and kind='shared'`, [userId])).rows[0].n;
    if (cnt >= MAX_SPACES_PER_USER) throw new AccessError(409, 'too_many_spaces', `每人最多建立 ${MAX_SPACES_PER_USER} 個共享空間`);
    const s = (await c.query(`insert into spaces(kind, name, owner_id) values ('shared', $1, $2) returning id, kind, name, owner_id`, [n, userId])).rows[0];
    await c.query(`insert into space_members(space_id, user_id, role, added_by) values ($1, $2, 'owner', $2)`, [s.id, userId]);
    return { id: s.id as string, kind: s.kind as string, name: s.name as string, ownerId: s.owner_id as string };
  });
}

// 建立者限定的操作：鎖住空間列（FOR UPDATE）並檢查身分
async function ownerSpace(c: PoolClient, userId: string, spaceId: unknown, extraSpaces: string[] = []) {
  if (!isUuid(spaceId)) throw notFound('空間');
  const sp = await lockSpaces(c, [spaceId, ...extraSpaces], 'update');
  const s = sp.get(spaceId);
  if (!s || !(await isMember(c, spaceId, userId))) throw notFound('空間');
  if (s.kind !== 'shared') throw new AccessError(400, 'personal_space', '個人空間不能分享或刪除');
  if (s.owner_id !== userId) throw new AccessError(403, 'owner_only', '只有空間的建立者可以管理成員');
  return s;
}

export async function renameSpace(userId: string, spaceId: unknown, name: unknown) {
  const n = cleanName(name);
  return tx(async c => {
    await ownerSpace(c, userId, spaceId);
    await c.query('update spaces set name=$1 where id=$2', [n, spaceId]);
    await c.query(`select pg_notify('pages_changed', $1::text)`, [spaceId]);
    return { id: spaceId as string, name: n };
  });
}

export async function addMember(userId: string, spaceId: unknown, targetId: unknown) {
  return tx(async c => {
    await ownerSpace(c, userId, spaceId);
    if (typeof targetId !== 'string' || targetId.length > 100) throw new AccessError(404, 'user_not_found', '帳號不存在');
    const u = (await c.query('select id from "user" where id=$1', [targetId])).rows[0];
    if (!u) throw new AccessError(404, 'user_not_found', '帳號不存在');
    const r = await c.query(
      `insert into space_members(space_id, user_id, role, added_by) values ($1, $2, 'member', $3) on conflict do nothing returning user_id`,
      [spaceId, targetId, userId]);
    return { added: r.rows.length === 1 };
  });
}

export async function removeMember(userId: string, spaceId: unknown, targetId: unknown) {
  return tx(async c => {
    const s = await ownerSpace(c, userId, spaceId);
    if (targetId === s.owner_id) throw new AccessError(400, 'cannot_remove_owner', '不能移除空間的建立者');
    const r = await c.query(`delete from space_members where space_id=$1 and user_id=$2 and role='member' returning user_id`, [spaceId, targetId]);
    if (!r.rows[0]) throw new AccessError(404, 'member_not_found', '這個帳號不是空間成員');
    return { removed: true };
  });
}

export async function leaveSpace(userId: string, spaceId: unknown) {
  if (!isUuid(spaceId)) throw notFound('空間');
  return tx(async c => {
    const sp = await lockSpaces(c, [spaceId], 'update');
    const s = sp.get(spaceId);
    const role = s ? await isMember(c, spaceId, userId, 'update') : undefined;
    if (!s || !role) throw notFound('空間');
    if (role === 'owner') throw new AccessError(400, 'owner_cannot_leave', '建立者不能退出空間；不再需要時請刪除空間');
    await c.query('delete from space_members where space_id=$1 and user_id=$2', [spaceId, userId]);
    return { left: true };
  });
}

// 刪除共享空間（P0-03）：單一交易，任一步失敗全部回滾
// 空間內每個頂層頁面（含子樹）改到建立者的個人空間並移入垃圾桶（每個頂層頁面一個垃圾桶批次）→ 刪除成員與空間
export async function deleteSpace(userId: string, spaceId: unknown) {
  if (!isUuid(spaceId)) throw notFound('空間');
  return tx(async c => {
    const personal = (await c.query(`select id from spaces where owner_id=$1 and kind='personal'`, [userId])).rows[0]?.id as string;
    await ownerSpace(c, userId, spaceId, personal ? [personal] : []);
    await c.query('select space_id, user_id from space_members where space_id=$1 order by space_id, user_id for update', [spaceId]);
    await c.query('select id from pages where space_id=$1 order by id for update', [spaceId]);
    // 每個「上層不在垃圾桶外」的頁面是一個批次的根
    const roots = (await c.query(
      `select p.id from pages p where p.space_id=$1 and p.deleted_at is null
         and not exists (select 1 from pages par where par.id = p.parent_id and par.deleted_at is null) order by p.position, p.id`,
      [spaceId])).rows.map(r => r.id as string);
    let trashed = 0;
    for (const root of roots) {
      const r = await c.query(
        `with recursive sub(id) as (
           select id from pages where id=$1 and deleted_at is null
           union all select p.id from pages p join sub on p.parent_id = sub.id where p.deleted_at is null)
         update pages set deleted_at=now(), trash_batch=$2, updated_at=now() where id in (select id from sub) returning id`,
        [root, crypto.randomUUID()]);
      trashed += r.rows.length;
    }
    const moved = await c.query('update pages set space_id=$1 where space_id=$2 returning id', [personal, spaceId]);
    await c.query('delete from space_members where space_id=$1', [spaceId]);
    await c.query('delete from spaces where id=$1', [spaceId]);
    return { deleted: true, trashed, moved: moved.rows.length };
  }, { treeLock: true });
}

// 帳號清單（邀請成員用）：所有帳號的名字與信箱（最多四個帳號）
export async function listUsers() {
  const r = await pool.query('select id, name, email from "user" order by created_at, id');
  return r.rows as { id: string; name: string; email: string }[];
}
