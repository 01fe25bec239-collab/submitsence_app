#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

export PGDATABASE="${PGDATABASE:-submitsense}"
export PGPORT="${PGPORT:-5432}"
export PGSSLMODE="${PGSSLMODE:-require}"

psql -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists public.infrastructure_schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
SQL

for migration in /workspace/db/migrations/0*.sql; do
  [[ "$migration" == *.down.sql ]] && continue
  filename="${migration##*/}"
  applied="$(psql -Atqc "select 1 from public.infrastructure_schema_migrations where filename = '$filename'")"
  [[ "$applied" == "1" ]] && continue
  psql -v ON_ERROR_STOP=1 -f "$migration"
  psql -v ON_ERROR_STOP=1 -v filename="$filename" -c "insert into public.infrastructure_schema_migrations(filename) values (:'filename')"
done

psql -v ON_ERROR_STOP=1 -v app_password="$APP_DB_PASSWORD" <<'SQL'
select format('create role submitsense_runtime login password %L in role submitsense_app', :'app_password')
where not exists (select 1 from pg_roles where rolname = 'submitsense_runtime') \gexec
select format('alter role submitsense_runtime password %L', :'app_password') \gexec
SQL
