-- requires-backup
-- M2-c：自動存版與版本保留（附錄 B1、B2；第二輪審核 B1-LOCK、B2-ROLLBACK）
-- 1. 先檢查還原紀錄的版本引用：指向不存在的版本或其他頁面的版本時停止遷移（資料不動，不清空任何引用；B2-P0-02）。
-- 2. pages.snap_seq（上次快照的已提交水位）、pages.dirty_since（之後第一筆已提交變更的時間；B1）。
-- 3. page_versions.source：request（make_version，含 M1 的按需存版與介面的「存一版」）或 schedule（排程快照）；
--    同水位去重只約束排程快照（B1-P0）。
-- 4. restore_jobs 的版本引用改可空並加外鍵（版本清除時設為空值），另存目標版本的類型與建立時間（B2-P0-01）。
-- 5. version_purges：90 天清理實際刪除版本時記一筆，供回滾判斷（B2-ROLLBACK）。
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(j.id, ', ' ORDER BY j.id) INTO bad FROM restore_jobs j
   WHERE NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.id = j.target_version_id AND v.page_id = j.page_id)
      OR (j.before_version_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.id = j.before_version_id AND v.page_id = j.page_id));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_restore_refs: 還原紀錄指向不存在或其他頁面的版本（%），已停止遷移，資料沒有變更；請依遷移前備份查明後再遷移', bad;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "snap_seq" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "dirty_since" timestamp with time zone;
--> statement-breakpoint
UPDATE "pages" p SET "snap_seq" = v.m FROM (SELECT page_id, max(up_to_seq) AS m FROM page_versions GROUP BY page_id) v WHERE v.page_id = p.id;
--> statement-breakpoint
UPDATE "pages" SET "dirty_since" = now() WHERE "last_seq" > "snap_seq";
--> statement-breakpoint
CREATE INDEX "pages_dirty_idx" ON "pages" USING btree ("dirty_since") WHERE "dirty_since" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "page_versions" ADD COLUMN "source" text DEFAULT 'request' NOT NULL;
--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_source_check" CHECK ("source" IN ('request', 'schedule'));
--> statement-breakpoint
CREATE UNIQUE INDEX "page_versions_schedule_unique" ON "page_versions" USING btree ("page_id", "up_to_seq") WHERE "source" = 'schedule';
--> statement-breakpoint
CREATE INDEX "page_versions_created_idx" ON "page_versions" USING btree ("created_at");
--> statement-breakpoint
ALTER TABLE "restore_jobs" ALTER COLUMN "target_version_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD COLUMN "target_version_reason" text;
--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD COLUMN "target_version_created_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "restore_jobs" j SET "target_version_reason" = v.reason, "target_version_created_at" = v.created_at
  FROM page_versions v WHERE v.id = j.target_version_id;
--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_target_version_id_fk" FOREIGN KEY ("target_version_id") REFERENCES "public"."page_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_before_version_id_fk" FOREIGN KEY ("before_version_id") REFERENCES "public"."page_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "restore_jobs_target_idx" ON "restore_jobs" USING btree ("target_version_id");
--> statement-breakpoint
CREATE INDEX "restore_jobs_before_idx" ON "restore_jobs" USING btree ("before_version_id");
--> statement-breakpoint
CREATE TABLE "version_purges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deleted" integer NOT NULL,
	"purged_at" timestamp with time zone DEFAULT now() NOT NULL
);
