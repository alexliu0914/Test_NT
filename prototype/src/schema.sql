-- M0 原型使用的資料表（正式版的子集，欄位名稱與計畫書第 6 節一致）
drop table if exists sessions, pages, doc_states, doc_updates, doc_update_ids,
  page_versions, restore_jobs, conflict_copies, fault_flags cascade;

create table sessions (
  id text primary key,
  user_id text not null,
  created_at timestamptz not null default now()
);

create table pages (
  id text primary key,
  restore_epoch int not null default 0,
  last_seq bigint not null default 0
);

create table doc_states (
  page_id text primary key,
  state bytea not null,
  up_to_seq bigint not null,
  updated_at timestamptz not null default now()
);

create table doc_updates (
  page_id text not null,
  seq bigint not null,
  data bytea not null,
  user_id text,
  kind text not null default 'edit',
  created_at timestamptz not null default now(),
  primary key (page_id, seq)
);

create table doc_update_ids (
  page_id text not null,
  update_id text not null,
  seq bigint not null,
  created_at timestamptz not null default now(),
  primary key (page_id, update_id)
);

create table page_versions (
  id text primary key,
  page_id text not null,
  state bytea not null,
  up_to_seq bigint not null,
  reason text not null,
  restore_id text,
  created_at timestamptz not null default now()
);

create table restore_jobs (
  id text primary key,
  page_id text not null,
  target_version_id text not null,
  before_version_id text,
  status text not null,
  seq bigint,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create table conflict_copies (
  id text primary key,
  page_id text not null,
  user_id text,
  based_epoch int,
  state bytea not null,
  content_json text not null,
  created_at timestamptz not null default now()
);

-- 故障注入：開啟 db_write_fail 時，寫入 doc_updates 會在資料庫內拋出錯誤
create table fault_flags (name text primary key, on_ boolean not null);

create or replace function fault_check() returns trigger as $$
begin
  if exists (select 1 from fault_flags where name = 'db_write_fail' and on_) then
    raise exception 'injected db write failure';
  end if;
  return new;
end $$ language plpgsql;

create trigger doc_updates_fault before insert on doc_updates
  for each row execute function fault_check();

-- 撤銷登入：刪除 session 時通知協作伺服器
create or replace function notify_revoke() returns trigger as $$
begin
  perform pg_notify('session_revoked', old.id);
  return old;
end $$ language plpgsql;

create trigger sessions_revoke after delete on sessions
  for each row execute function notify_revoke();
