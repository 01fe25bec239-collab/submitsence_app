#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

export PGDATABASE="${PGDATABASE:-submitsense}"
export PGPORT="${PGPORT:-5432}"
export PGSSLMODE="${PGSSLMODE:-require}"

# PB-10: install or upgrade the migration_control control schema before any
# application migration executes or any new-format migration_runs event is
# ever inserted. Uses the same PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD
# already exported above — no DATABASE_URL is set or required here.
bash /workspace/db/control/install-or-upgrade-control-schema.sh

psql -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists public.infrastructure_schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
SQL

for migration in /workspace/db/migrations/0*.sql; do
  [[ "$migration" == *.down.sql ]] && continue
  filename="${migration##*/}"
  # psql only performs :name / :'name' variable interpolation when reading a
  # script (a -f file or, as here, stdin) — never for a -c/-c-style
  # argument, which is passed straight to the server unparsed. Shell-
  # splicing $filename directly into a SQL string literal is also unsafe on
  # its own terms (a filename containing a single quote, e.g.
  # 9999_o'brien.sql, breaks the literal and can alter the query). -v with a
  # quoted heredoc avoids both: psql substitutes and safely quotes the value
  # itself, so no raw filename ever reaches the SQL text directly.
  # ledger-lookup: begin (see infra/scripts/test-migrate-ledger-insert.sh)
  applied="$(
    psql \
      -X \
      -v ON_ERROR_STOP=1 \
      -v filename="$filename" \
      -At <<'SQL'
SELECT 1
FROM public.infrastructure_schema_migrations
WHERE filename = :'filename'
LIMIT 1;
SQL
  )"
  # ledger-lookup: end
  [[ "$applied" == "1" ]] && continue
  psql -v ON_ERROR_STOP=1 -f "$migration"
  # ledger-insert: begin (see infra/scripts/test-migrate-ledger-insert.sh)
  psql -v ON_ERROR_STOP=1 -v filename="$filename" <<'SQL'
insert into public.infrastructure_schema_migrations(filename) values (:'filename');
SQL
  # ledger-insert: end
done

psql -v ON_ERROR_STOP=1 -v app_password="$APP_DB_PASSWORD" <<'SQL'
select format('create role submitsense_runtime login password %L in role submitsense_app', :'app_password')
where not exists (select 1 from pg_roles where rolname = 'submitsense_runtime') \gexec
select format('alter role submitsense_runtime password %L', :'app_password') \gexec
SQL
