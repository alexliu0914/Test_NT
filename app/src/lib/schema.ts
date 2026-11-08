// 資料表定義（計畫書第 6 節）。認證資料表由 Better Auth CLI 產生於 auth-schema.ts。
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn, pgTable, text, uuid, timestamp, integer, bigint, boolean, bigserial, customType, primaryKey, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { user } from './auth-schema';

export * from './auth-schema';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 邀請連結：72 小時有效、只能用一次；資料庫只存權杖的 SHA-256
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 空間（M2-s，遷移 0002）：每個帳號一個個人空間；共享空間由建立者管理成員。
// 約束（每個帳號一個個人空間、每個空間一個 owner、個人空間只有本人、帳號上限）在遷移 0002 以索引與觸發器實作
export const spaces = pgTable('spaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  name: text('name').notNull().default(''),
  ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  membersVersion: integer('members_version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const spaceMembers = pgTable('space_members', {
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  role: text('role').notNull(),
  addedBy: text('added_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ name: 'space_members_pk', columns: [t.spaceId, t.userId] }),
  index('space_members_user_idx').on(t.userId),
]);

// 頁面樹：position 為分數排序鍵（fractional index）；刪除時整棵子樹標上同一個 trash_batch，還原時一起回來
export const pages = pgTable('pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id),
  // 所屬空間（M2-s）：子頁面必須與上層同空間（遷移 0002 的延後檢查觸發器）
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'restrict' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => pages.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('page'),
  title: text('title').notNull().default(''),
  icon: text('icon'),
  position: text('position').notNull(),
  restoreEpoch: integer('restore_epoch').notNull().default(0),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
  // 自動存版（M2-c B1，遷移 0003）：上次快照的已提交水位、之後第一筆已提交變更的時間
  snapSeq: bigint('snap_seq', { mode: 'number' }).notNull().default(0),
  dirtySince: timestamp('dirty_since', { withTimezone: true }),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  trashBatch: uuid('trash_batch'),
}, t => [
  index('pages_parent_idx').on(t.workspaceId, t.parentId).where(sql`deleted_at is null`),
  index('pages_trash_idx').on(t.trashBatch).where(sql`trash_batch is not null`),
  index('pages_space_idx').on(t.spaceId).where(sql`deleted_at is null`),
  index('pages_dirty_idx').on(t.dirtySince).where(sql`dirty_since is not null`),
]);

// ---- 協作（沿用 M0 已驗證的資料表；page_id 改為參照 pages） ----
export const docStates = pgTable('doc_states', {
  pageId: uuid('page_id').primaryKey().references(() => pages.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  upToSeq: bigint('up_to_seq', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const docUpdates = pgTable('doc_updates', {
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  data: bytea('data').notNull(),
  userId: text('user_id'),
  kind: text('kind').notNull().default('edit'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.pageId, t.seq] })]);

export const docUpdateIds = pgTable('doc_update_ids', {
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  updateId: text('update_id').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.pageId, t.updateId] })]);

export const pageVersions = pgTable('page_versions', {
  id: text('id').primaryKey(),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  upToSeq: bigint('up_to_seq', { mode: 'number' }).notNull(),
  reason: text('reason').notNull(),
  // request：make_version（M1 的按需存版、介面的「存一版」）；schedule：排程快照（M2-c B1-P0）
  source: text('source').notNull().default('request'),
  restoreId: text('restore_id'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('page_versions_page_idx').on(t.pageId, t.createdAt),
  uniqueIndex('page_versions_schedule_unique').on(t.pageId, t.upToSeq).where(sql`source = 'schedule'`),
  index('page_versions_created_idx').on(t.createdAt),
]);

export const restoreJobs = pgTable('restore_jobs', {
  id: text('id').primaryKey(),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  // 版本清除時設為空值（M2-c B2-P0-01）；目標版本的類型與建立時間另存，清除後仍可顯示紀錄
  targetVersionId: text('target_version_id').references(() => pageVersions.id, { onDelete: 'set null' }),
  beforeVersionId: text('before_version_id').references(() => pageVersions.id, { onDelete: 'set null' }),
  targetVersionReason: text('target_version_reason'),
  targetVersionCreatedAt: timestamp('target_version_created_at', { withTimezone: true }),
  requestedBy: text('requested_by'),
  status: text('status').notNull(),
  seq: bigint('seq', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
});

export const conflictCopies = pgTable('conflict_copies', {
  id: text('id').primaryKey(),
  pageId: uuid('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  userId: text('user_id'),
  basedEpoch: integer('based_epoch'),
  state: bytea('state').notNull(),
  contentJson: text('content_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---- 安全 ----
export const loginAttempts = pgTable('login_attempts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  email: text('email').notNull(),
  ip: text('ip').notNull(),
  success: boolean('success').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('login_attempts_email_idx').on(t.email, t.createdAt), index('login_attempts_ip_idx').on(t.ip, t.createdAt)]);

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: text('user_id'),
  action: text('action').notNull(),
  target: text('target'),
  ip: text('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 90 天版本清理實際刪除資料時的紀錄（M2-c B2-ROLLBACK）：有紀錄時遷移 0003 不能無損回滾
export const versionPurges = pgTable('version_purges', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  deleted: integer('deleted').notNull(),
  purgedAt: timestamp('purged_at', { withTimezone: true }).notNull().defaultNow(),
});
