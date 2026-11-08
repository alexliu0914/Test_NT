-- 回滾 0003（M2-c）：只在不會遺失資料時才回滾結構（B2-P0-02、B2-ROLLBACK）。無法安全回滾的情況：
--   1. 90 天清理曾實際刪除版本（version_purges 有紀錄；不論被刪的版本是否被還原紀錄引用）
--   2. 還原紀錄的目標版本已是空值（版本已被清除，無法恢復 NOT NULL）
--   3. 有手動版本（reason = 'manual'）或排程快照（source = 'schedule'），M2-b 結構無法區分
-- 有任何一類就拒絕，請改用遷移前自動產生的備份還原（scripts/migrate.mjs restore）。
-- snap_seq、dirty_since 可由版本與 last_seq 重新計算，移除不會遺失內容。
DO $$
DECLARE reasons text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM version_purges) THEN reasons := array_append(reasons, '版本清理曾刪除資料'); END IF;
  IF EXISTS (SELECT 1 FROM restore_jobs WHERE target_version_id IS NULL) THEN reasons := array_append(reasons, '還原紀錄的目標版本已清除'); END IF;
  IF EXISTS (SELECT 1 FROM page_versions WHERE reason = 'manual') THEN reasons := array_append(reasons, '手動版本'); END IF;
  IF EXISTS (SELECT 1 FROM page_versions WHERE source = 'schedule') THEN reasons := array_append(reasons, '排程快照'); END IF;
  IF array_length(reasons, 1) > 0 THEN
    RAISE EXCEPTION 'unsafe_rollback: 無法安全回滾到 M2-b（%），請從遷移前的備份還原', array_to_string(reasons, '、');
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "version_purges";
--> statement-breakpoint
DROP INDEX IF EXISTS "restore_jobs_before_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "restore_jobs_target_idx";
--> statement-breakpoint
ALTER TABLE "restore_jobs" DROP CONSTRAINT IF EXISTS "restore_jobs_before_version_id_fk";
--> statement-breakpoint
ALTER TABLE "restore_jobs" DROP CONSTRAINT IF EXISTS "restore_jobs_target_version_id_fk";
--> statement-breakpoint
ALTER TABLE "restore_jobs" DROP COLUMN IF EXISTS "target_version_created_at";
--> statement-breakpoint
ALTER TABLE "restore_jobs" DROP COLUMN IF EXISTS "target_version_reason";
--> statement-breakpoint
ALTER TABLE "restore_jobs" ALTER COLUMN "target_version_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "page_versions_created_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "page_versions_schedule_unique";
--> statement-breakpoint
ALTER TABLE "page_versions" DROP CONSTRAINT IF EXISTS "page_versions_source_check";
--> statement-breakpoint
ALTER TABLE "page_versions" DROP COLUMN IF EXISTS "source";
--> statement-breakpoint
DROP INDEX IF EXISTS "pages_dirty_idx";
--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN IF EXISTS "dirty_since";
--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN IF EXISTS "snap_seq";
