-- 測試專用（不屬於正式遷移）：開啟 db_write_fail 時，寫入 doc_updates 會在資料庫內拋出錯誤
create table if not exists fault_flags (name text primary key, on_ boolean not null);
create or replace function fault_check() returns trigger as $$
begin
  if exists (select 1 from fault_flags where name = 'db_write_fail' and on_) then
    raise exception 'injected db write failure';
  end if;
  return new;
end $$ language plpgsql;
drop trigger if exists fault_check on doc_updates;
create trigger fault_check before insert on doc_updates for each row execute function fault_check();
