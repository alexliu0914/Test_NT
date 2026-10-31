DROP TRIGGER IF EXISTS page_closed ON "pages";
DROP FUNCTION IF EXISTS notify_page_closed();
DROP TRIGGER IF EXISTS pages_changed ON "pages";
DROP FUNCTION IF EXISTS notify_pages_changed();
DROP TRIGGER IF EXISTS session_revoked ON "session";
DROP FUNCTION IF EXISTS notify_session_revoked();
