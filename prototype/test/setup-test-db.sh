#!/usr/bin/env bash
# 建立 M0 測試資料庫（m0_test），LC_CTYPE 固定為 C.UTF-8，並加上測試標記資料表。
# 用法：PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres test/setup-test-db.sh
set -euo pipefail
DB="${M0_TEST_DB:-m0_test}"
case "$DB" in *_test) ;; *) echo "資料庫名稱必須以 _test 結尾：$DB" >&2; exit 1 ;; esac
if ! psql -d postgres -tAc "select 1 from pg_database where datname='$DB'" | grep -q 1; then
  psql -d postgres -v ON_ERROR_STOP=1 -c "create database \"$DB\" template template0 encoding 'UTF8' lc_collate 'C.UTF-8' lc_ctype 'C.UTF-8'"
fi
psql -d "$DB" -v ON_ERROR_STOP=1 -c "create table if not exists __m0_test_database (created_at timestamptz default now()); create extension if not exists pg_trgm;"
echo "測試資料庫 $DB 已就緒"
