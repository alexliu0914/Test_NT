// 授權（M2-s，FR-20）：使用者是頁面所屬空間的成員，才能讀或寫這個頁面。
// 網頁與 API 的所有頁面讀寫都經過這裡；協作伺服器的連線與提交檢查在 collab/server.mjs（同一條規則）。
// 無權限時一律回應「不存在」（404），不透露頁面或空間是否存在。
//
// 交易鎖定順序（第二輪審核「實作驗收補充」）：所有交易依同一個順序取鎖
//   1. 工作區頁面樹鎖（advisory lock；改變樹狀結構、搬移、刪除空間時取）
//   2. spaces 列（依 id 遞增）　3. space_members 列（依 space_id, user_id 遞增）　4. pages 列（依 id 遞增）　5. 協作資料
// 偵測到死鎖（40P01）或序列化衝突（40001）時整個交易回滾重試，最多 3 次，間隔隨機 20～100 毫秒；仍失敗回 503。
import type { PoolClient } from 'pg';
import { pool } from './db';

export class AccessError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const notFound = (what = '頁面') => new AccessError(404, 'not_found', `${what}不存在`);

export const RETRY_CODES = new Set(['40P01', '40001']);
export const MAX_TX_RETRIES = 3;
export const txStats = { retries: 0, exhausted: 0 };

const g = globalThis as unknown as { __wsId?: string };
export async function workspaceId(): Promise<string> {
  if (g.__wsId) return g.__wsId;
  const r = await pool.query('select id from workspaces order by created_at limit 1');
  if (!r.rows[0]) throw new AccessError(500, 'no_workspace', '工作區尚未建立');
  g.__wsId = r.rows[0].id as string;
  return g.__wsId;
}

// 交易：treeLock＝取工作區頁面樹鎖（鎖定順序第 1 層）
export async function tx<T>(fn: (c: PoolClient, ws: string) => Promise<T>, { treeLock = false } = {}): Promise<T> {
  const ws = await workspaceId();
  for (let attempt = 0; ; attempt++) {
    const c = await pool.connect();
    let retry = false;
    try {
      await c.query('begin');
      if (treeLock) await c.query('select pg_advisory_xact_lock(hashtext($1))', ['tree:' + ws]);
      const r = await fn(c, ws);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      const code = (e as { code?: string }).code;
      if (!code || !RETRY_CODES.has(code)) throw e;
      if (attempt >= MAX_TX_RETRIES) {
        txStats.exhausted++;
        throw new AccessError(503, 'busy', '系統忙碌，請稍後再試');
      }
      txStats.retries++;
      retry = true;
    } finally { c.release(); }
    if (retry) await new Promise(r => setTimeout(r, 20 + Math.floor(Math.random() * 80)));
  }
}

export type SpaceLock = 'share' | 'update';

// 鎖住空間列（依 id 遞增），回傳 id → 列
export async function lockSpaces(c: PoolClient, ids: string[], mode: SpaceLock) {
  const uniq = [...new Set(ids)].sort();
  const r = await c.query(
    `select id, kind, name, owner_id, members_version from spaces where id = any($1::uuid[]) order by id for ${mode === 'update' ? 'update' : 'share'}`,
    [uniq]);
  return new Map(r.rows.map(x => [x.id as string, x as { id: string; kind: string; name: string; owner_id: string; members_version: number }]));
}

// 確認 userId 是 spaceId 的成員；同時以 FOR SHARE 鎖住空間列與成員列（鎖定順序 2→3），撤銷類操作會以 FOR UPDATE 修改同一些列
export async function lockMembership(c: PoolClient, userId: string, spaceIds: string[]): Promise<boolean> {
  const uniq = [...new Set(spaceIds)].sort();
  const spaces = await lockSpaces(c, uniq, 'share');
  if (spaces.size !== uniq.length) return false;
  const m = await c.query(
    `select space_id from space_members where space_id = any($1::uuid[]) and user_id = $2 order by space_id, user_id for share`,
    [uniq, userId]);
  return m.rows.length === uniq.length;
}

// 使用者所屬的空間
export async function memberSpaceIds(userId: string, c: Pick<PoolClient, 'query'> = pool): Promise<string[]> {
  const r = await c.query('select space_id from space_members where user_id=$1 order by space_id', [userId]);
  return r.rows.map(x => x.space_id as string);
}

export async function personalSpaceId(userId: string, c: Pick<PoolClient, 'query'> = pool): Promise<string> {
  const r = await c.query(`select id from spaces where owner_id=$1 and kind='personal'`, [userId]);
  if (!r.rows[0]) throw new AccessError(500, 'no_personal_space', '找不到個人空間');
  return r.rows[0].id as string;
}

// 不加鎖的唯讀檢查（顯示用：頁面樹、協作憑證）；寫入一律在交易內以 lockMembership 檢查
export async function canAccessPage(userId: string, pageId: string, { includeTrash = false } = {}): Promise<boolean> {
  const r = await pool.query(
    `select 1 from pages p join space_members m on m.space_id = p.space_id and m.user_id = $2
      where p.id = $1 ${includeTrash ? '' : 'and p.deleted_at is null'}`, [pageId, userId]);
  return !!r.rows[0];
}
