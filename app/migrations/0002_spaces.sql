-- requires-backup
-- M2-s：空間與權限（FR-20；M2 計畫增修 P0-04～P0-06）
-- 每個帳號一個個人空間；共享空間由建立者管理成員；頁面屬於一個空間，子頁面與上層同空間。
-- 現有資料：每個頂層頁面（含子頁面）歸建立者的個人空間，不自動公開。
-- 最多四個帳號：在新增帳號的交易中以 advisory lock 計數（管理者與停用的帳號都計入）。
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"owner_id" text NOT NULL,
	"members_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_kind_check" CHECK ("kind" IN ('personal', 'shared')),
	CONSTRAINT "spaces_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_personal_owner_unique" ON "spaces" USING btree ("owner_id") WHERE "kind" = 'personal';
--> statement-breakpoint
CREATE TABLE "space_members" (
	"space_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_pk" PRIMARY KEY ("space_id", "user_id"),
	CONSTRAINT "space_members_role_check" CHECK ("role" IN ('owner', 'member')),
	CONSTRAINT "space_members_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "space_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "space_members_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "space_members_one_owner" ON "space_members" USING btree ("space_id") WHERE "role" = 'owner';
--> statement-breakpoint
CREATE INDEX "space_members_user_idx" ON "space_members" USING btree ("user_id");
--> statement-breakpoint
-- 成員列的約束：owner 必須是空間的 owner_id；個人空間只能有本人
CREATE FUNCTION check_space_member() RETURNS trigger AS $$
DECLARE s record;
BEGIN
  SELECT kind, owner_id INTO s FROM spaces WHERE id = NEW.space_id;
  IF NEW.role = 'owner' AND NEW.user_id <> s.owner_id THEN
    RAISE EXCEPTION 'space owner row must match spaces.owner_id' USING ERRCODE = 'check_violation';
  END IF;
  IF s.kind = 'personal' AND NEW.user_id <> s.owner_id THEN
    RAISE EXCEPTION 'personal space cannot have other members' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER space_member_check BEFORE INSERT OR UPDATE ON "space_members" FOR EACH ROW EXECUTE FUNCTION check_space_member();
--> statement-breakpoint
-- 成員變動：版本號加 1（跨空間搬移的確認碼用）並通知協作伺服器重新檢查連線
CREATE FUNCTION notify_space_members_changed() RETURNS trigger AS $$
DECLARE sid uuid := COALESCE(NEW.space_id, OLD.space_id);
BEGIN
  UPDATE spaces SET members_version = members_version + 1 WHERE id = sid;
  PERFORM pg_notify('space_access_changed', json_build_object('space', sid)::text);
  PERFORM pg_notify('pages_changed', sid::text);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER space_members_changed AFTER INSERT OR UPDATE OR DELETE ON "space_members" FOR EACH ROW EXECUTE FUNCTION notify_space_members_changed();
--> statement-breakpoint
-- 帳號上限：先取得帳號專用的鎖，再以新的快照計數（READ COMMITTED 下函式內每個查詢取新快照）
CREATE FUNCTION enforce_account_limit() RETURNS trigger AS $$
DECLARE n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('notes:accounts'));
  SELECT count(*) INTO n FROM "user";
  IF n >= 4 THEN
    RAISE EXCEPTION 'account_limit: 最多四個帳號' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint
CREATE TRIGGER account_limit BEFORE INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION enforce_account_limit();
--> statement-breakpoint
-- 新帳號在同一個交易中建立個人空間
CREATE FUNCTION create_personal_space() RETURNS trigger AS $$
DECLARE sid uuid;
BEGIN
  INSERT INTO spaces(kind, name, owner_id) VALUES ('personal', '我的頁面', NEW.id) RETURNING id INTO sid;
  INSERT INTO space_members(space_id, user_id, role) VALUES (sid, NEW.id, 'owner');
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER personal_space AFTER INSERT ON "user" FOR EACH ROW EXECUTE FUNCTION create_personal_space();
--> statement-breakpoint
-- 現有帳號的個人空間
INSERT INTO spaces(kind, name, owner_id) SELECT 'personal', '我的頁面', id FROM "user";
--> statement-breakpoint
INSERT INTO space_members(space_id, user_id, role) SELECT id, owner_id, 'owner' FROM spaces WHERE kind = 'personal';
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "space_id" uuid;
--> statement-breakpoint
-- 現有頁面：頂層頁面歸建立者的個人空間（建立者不存在時歸最早的管理者），子頁面跟著頂層
WITH RECURSIVE fallback AS (
  SELECT s.id FROM spaces s JOIN "user" u ON u.id = s.owner_id
   WHERE s.kind = 'personal' ORDER BY (u.role = 'admin') DESC, u.created_at, u.id LIMIT 1
), tree AS (
  SELECT p.id, COALESCE((SELECT s.id FROM spaces s WHERE s.kind = 'personal' AND s.owner_id = p.created_by), (SELECT id FROM fallback)) AS sid
    FROM pages p WHERE p.parent_id IS NULL
  UNION ALL
  SELECT c.id, tree.sid FROM pages c JOIN tree ON c.parent_id = tree.id
)
UPDATE pages SET space_id = tree.sid FROM tree WHERE pages.id = tree.id;
--> statement-breakpoint
ALTER TABLE "pages" ALTER COLUMN "space_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pages_space_idx" ON "pages" USING btree ("space_id") WHERE deleted_at is null;
--> statement-breakpoint
-- 子頁面必須與上層同空間（提交時檢查，讓搬移整棵子樹的多筆更新可以在同一個交易中完成）
CREATE FUNCTION check_page_space() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND EXISTS (SELECT 1 FROM pages p WHERE p.id = NEW.parent_id AND p.space_id <> NEW.space_id) THEN
    RAISE EXCEPTION 'child page must be in the same space as its parent' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = NEW.id AND c.space_id <> NEW.space_id) THEN
    RAISE EXCEPTION 'child page must be in the same space as its parent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER page_space_check AFTER INSERT OR UPDATE OF parent_id, space_id ON "pages"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_page_space();
--> statement-breakpoint
-- 頁面樹變動的通知改為帶空間 id，只推送給該空間的成員；跨空間搬移時兩個空間都通知，並請協作伺服器重新檢查該頁的連線
CREATE OR REPLACE FUNCTION notify_pages_changed() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM pg_notify('pages_changed', OLD.space_id::text); END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.space_id IS DISTINCT FROM OLD.space_id) THEN
    PERFORM pg_notify('pages_changed', NEW.space_id::text);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.space_id IS DISTINCT FROM OLD.space_id THEN
    PERFORM pg_notify('space_access_changed', json_build_object('page', NEW.id)::text);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS pages_changed ON "pages";
--> statement-breakpoint
CREATE TRIGGER pages_changed AFTER INSERT OR UPDATE OF parent_id, title, icon, position, deleted_at, space_id OR DELETE ON "pages"
  FOR EACH ROW EXECUTE FUNCTION notify_pages_changed();
--> statement-breakpoint
-- 回滾判斷用：遷移時間與每個頁面當時分配到的空間（P0-04）
CREATE TABLE "migration_0002" (
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "migration_0002" DEFAULT VALUES;
--> statement-breakpoint
CREATE TABLE "migration_0002_pages" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL
);
--> statement-breakpoint
INSERT INTO "migration_0002_pages" SELECT id, space_id FROM pages;
