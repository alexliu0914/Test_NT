// 版本紀錄的讀取（M2-c W4-C）：只讀，不提供任何寫入；還原與存版只走既有協作連線（D2）。
// 授權：頁面必須存在、不在垃圾桶，且使用者是所屬空間的成員（與協作憑證相同），否則一律 404。
// 版本清單只含存在的版本（90 天清理後就不列出）；還原紀錄在目標版本清除後以歷史欄位顯示。
import { pool } from './db';
import { notFound } from './access';
import { pageVisible } from './pages';
import { blocksOfState, FORMAT_VERSION } from '@shared/export.js';
import { safeBlocks } from '@shared/version-preview.js';
import { RETENTION_DAYS } from '@shared/version-retention.js';

export type VersionRow = { id: string; reason: string; source: string; createdAt: string; expiresAt: string; author: string | null; upToSeq: number };
export type RestoreRow = { id: string; appliedAt: string | null; by: string | null; targetVersionId: string | null; targetReason: string | null; targetCreatedAt: string | null; beforeVersionId: string | null };
export type ConflictRow = { id: string; createdAt: string; author: string | null };

const VERSION_ID_RE = /^[\w:.-]{1,100}$/;

export async function listVersions(userId: string, pageId: string) {
  if (!(await pageVisible(userId, pageId))) throw notFound();
  const versions = (await pool.query(
    `select v.id, v.reason, v.source, v.created_at, v.created_at + make_interval(days => $2) as expires_at, u.name as author, v.up_to_seq
       from page_versions v left join "user" u on u.id = v.created_by
      where v.page_id = $1 order by v.created_at desc, v.id`, [pageId, RETENTION_DAYS])).rows
    .map(r => ({ id: r.id, reason: r.reason, source: r.source, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(), author: r.author, upToSeq: Number(r.up_to_seq) }) as VersionRow);
  const restores = (await pool.query(
    `select j.id, j.applied_at, u.name as by, j.target_version_id, j.target_version_reason, j.target_version_created_at, j.before_version_id
       from restore_jobs j left join "user" u on u.id = j.requested_by
      where j.page_id = $1 and j.status = 'applied' order by j.applied_at desc nulls last, j.id`, [pageId])).rows
    .map(r => ({ id: r.id, appliedAt: r.applied_at && r.applied_at.toISOString(), by: r.by, targetVersionId: r.target_version_id, targetReason: r.target_version_reason,
      targetCreatedAt: r.target_version_created_at && r.target_version_created_at.toISOString(), beforeVersionId: r.before_version_id }) as RestoreRow);
  const conflicts = (await pool.query(
    `select c.id, c.created_at, u.name as author from conflict_copies c left join "user" u on u.id = c.user_id
      where c.page_id = $1 order by c.created_at desc, c.id`, [pageId])).rows
    .map(r => ({ id: r.id, createdAt: r.created_at.toISOString(), author: r.author }) as ConflictRow);
  return { versions, restores, conflicts, retentionDays: RETENTION_DAYS };
}

export async function previewVersion(userId: string, pageId: string, versionId: string) {
  if (!VERSION_ID_RE.test(versionId) || !(await pageVisible(userId, pageId))) throw notFound('版本');
  const v = (await pool.query('select reason, source, created_at, state from page_versions where id = $1 and page_id = $2', [versionId, pageId])).rows[0];
  if (!v) throw notFound('版本');
  return { id: versionId, reason: v.reason as string, source: v.source as string, createdAt: v.created_at.toISOString(), formatVersion: FORMAT_VERSION,
    blocks: safeBlocks(blocksOfState(new Uint8Array(v.state))) };
}

export async function previewConflict(userId: string, pageId: string, copyId: string) {
  if (!VERSION_ID_RE.test(copyId) || !(await pageVisible(userId, pageId))) throw notFound('衝突副本');
  const c = (await pool.query('select created_at, content_json from conflict_copies where id = $1 and page_id = $2', [copyId, pageId])).rows[0];
  if (!c) throw notFound('衝突副本');
  let blocks: unknown = [];
  try { blocks = JSON.parse(c.content_json); } catch { blocks = []; }
  return { id: copyId, createdAt: c.created_at.toISOString(), formatVersion: FORMAT_VERSION, blocks: safeBlocks(Array.isArray(blocks) ? blocks : []) };
}
