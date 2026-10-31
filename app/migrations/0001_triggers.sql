-- 撤銷登入：Better Auth 刪除 session 時通知協作伺服器，立即中斷該 session 的連線
CREATE FUNCTION notify_session_revoked() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('session_revoked', OLD.id);
  RETURN OLD;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER session_revoked AFTER DELETE ON "session" FOR EACH ROW EXECUTE FUNCTION notify_session_revoked();
--> statement-breakpoint
-- 頁面樹有變動時通知網頁伺服器，再推送給所有開著的瀏覽器（PAGE-01：2 秒內看到）
CREATE FUNCTION notify_pages_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('pages_changed', COALESCE(NEW.workspace_id, OLD.workspace_id)::text);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER pages_changed AFTER INSERT OR UPDATE OF parent_id, title, icon, position, deleted_at OR DELETE ON "pages"
  FOR EACH ROW EXECUTE FUNCTION notify_pages_changed();
--> statement-breakpoint
-- 頁面被移入垃圾桶或永久刪除時，協作伺服器中斷該頁面的連線
CREATE FUNCTION notify_page_closed() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('page_closed', OLD.id::text);
  ELSIF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    PERFORM pg_notify('page_closed', NEW.id::text);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER page_closed AFTER UPDATE OF deleted_at OR DELETE ON "pages" FOR EACH ROW EXECUTE FUNCTION notify_page_closed();
