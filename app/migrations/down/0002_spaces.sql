-- 回滾 0002（M2-s）：只在沒有「無法安全還原到 M1」的資料時才回滾結構（P0-04，第二輪審核修正）
-- 個人空間的 owner 成員列是遷移本身產生的，不影響判斷。無法安全回滾的資料：
--   1. 共享空間　2. 共享空間的成員（role = member）　3. 與遷移當時分配的空間不同的頁面（搬移過）
--   4. 遷移後才建立的頁面（建立時是私人的，回到 M1 的共用工作區會被所有人看到）
-- 有任何一類就拒絕，請改用遷移前自動產生的備份還原（scripts/migrate.mjs restore）。
DO $$
DECLARE reasons text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM spaces WHERE kind = 'shared') THEN reasons := array_append(reasons, '共享空間'); END IF;
  IF EXISTS (SELECT 1 FROM space_members WHERE role = 'member') THEN reasons := array_append(reasons, '共享空間的成員'); END IF;
  IF EXISTS (SELECT 1 FROM pages p JOIN migration_0002_pages a ON a.page_id = p.id WHERE a.space_id <> p.space_id) THEN
    reasons := array_append(reasons, '搬移過空間的頁面');
  END IF;
  IF EXISTS (SELECT 1 FROM pages p WHERE NOT EXISTS (SELECT 1 FROM migration_0002_pages a WHERE a.page_id = p.id)) THEN
    reasons := array_append(reasons, '遷移後建立的頁面');
  END IF;
  IF array_length(reasons, 1) > 0 THEN
    RAISE EXCEPTION 'unsafe_rollback: 無法安全回滾到 M1（%），請從遷移前的備份還原', array_to_string(reasons, '、');
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "migration_0002_pages";
--> statement-breakpoint
DROP TABLE IF EXISTS "migration_0002";
--> statement-breakpoint
DROP TRIGGER IF EXISTS pages_changed ON "pages";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_pages_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pages_changed', COALESCE(NEW.workspace_id, OLD.workspace_id)::text);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER pages_changed AFTER INSERT OR UPDATE OF parent_id, title, icon, position, deleted_at OR DELETE ON "pages"
  FOR EACH ROW EXECUTE FUNCTION notify_pages_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS page_space_check ON "pages";
--> statement-breakpoint
DROP FUNCTION IF EXISTS check_page_space();
--> statement-breakpoint
DROP INDEX IF EXISTS "pages_space_idx";
--> statement-breakpoint
ALTER TABLE "pages" DROP CONSTRAINT IF EXISTS "pages_space_id_spaces_id_fk";
--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN IF EXISTS "space_id";
--> statement-breakpoint
DROP TRIGGER IF EXISTS personal_space ON "user";
--> statement-breakpoint
DROP FUNCTION IF EXISTS create_personal_space();
--> statement-breakpoint
DROP TRIGGER IF EXISTS account_limit ON "user";
--> statement-breakpoint
DROP FUNCTION IF EXISTS enforce_account_limit();
--> statement-breakpoint
DROP TRIGGER IF EXISTS space_members_changed ON "space_members";
--> statement-breakpoint
DROP FUNCTION IF EXISTS notify_space_members_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS space_member_check ON "space_members";
--> statement-breakpoint
DROP FUNCTION IF EXISTS check_space_member();
--> statement-breakpoint
DROP TABLE IF EXISTS "space_members";
--> statement-breakpoint
DROP TABLE IF EXISTS "spaces";
