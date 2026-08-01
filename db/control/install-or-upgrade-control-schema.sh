#!/usr/bin/env bash
# PB-10 control-schema provisioning entrypoint. Safe to run any number of
# times against the same target: installs fresh when migration_control is
# absent, upgrades mr_metadata_ck in place when it already exists. Never
# drops the control schema, either permanent ledger table, or a row.
#
# Connects exactly like psql/libpq do natively: if DATABASE_URL is set it is
# used as the connection target; otherwise psql falls back to the standard
# PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD (and PGSSLMODE, etc.)
# environment variables already exported by the caller (see
# infra/scripts/migrate.sh). DATABASE_URL is never required.
#
# Must be run as an ADMINISTRATIVE role — one that can CREATE ROLE and is not
# the migration execution role. MIGRATION_EXECUTION_ROLE names the role the
# migration runner logs in as; it is required, because both the fresh install
# and the upgrade build that role's privilege set explicitly and neither can
# guess it. See db/README.md.
#
#   MIGRATION_EXECUTION_ROLE=submitsense_migrate \
#   DATABASE_URL="postgres://admin@host:5432/db" \
#     db/control/install-or-upgrade-control-schema.sh
#
#   MIGRATION_EXECUTION_ROLE=submitsense_migrate \
#   PGHOST=host PGPORT=5432 PGDATABASE=db PGUSER=admin PGPASSWORD=*** \
#     db/control/install-or-upgrade-control-schema.sh
set -euo pipefail

: "${MIGRATION_EXECUTION_ROLE:?MIGRATION_EXECUTION_ROLE is required (the role the migration runner logs in as); see db/README.md}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# psql's own convention: a bare "psql" with no positional/-d argument reads
# PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD from the environment. Building
# this array lets every invocation below share the same connection target
# without forcing a DATABASE_URL.
psql_target=()
if [[ -n "${DATABASE_URL:-}" ]]; then
  psql_target=("$DATABASE_URL")
fi

exists="$(psql ${psql_target[@]+"${psql_target[@]}"} -XAtq -v ON_ERROR_STOP=1 \
  -c "select (pg_catalog.to_regnamespace('migration_control') is not null)")"

if [[ "$exists" == "t" ]]; then
  echo "migration_control already present; applying idempotent upgrade" >&2
  psql ${psql_target[@]+"${psql_target[@]}"} -v ON_ERROR_STOP=1 \
    -v migration_execution_role="$MIGRATION_EXECUTION_ROLE" \
    -v previous_metadata_ck_def="$(cat "$script_dir/fixtures/mr_metadata_ck.previous.def")" \
    -v phase2b_metadata_ck_def="$(cat "$script_dir/fixtures/mr_metadata_ck.phase2b.def")" \
    -v current_metadata_ck_def="$(cat "$script_dir/fixtures/mr_metadata_ck.current.def")" \
    -f "$script_dir/control-schema-upgrade.sql"
else
  echo "migration_control absent; installing fresh" >&2
  psql ${psql_target[@]+"${psql_target[@]}"} -v ON_ERROR_STOP=1 \
    -v migration_execution_role="$MIGRATION_EXECUTION_ROLE" \
    -f "$script_dir/control-schema.sql"
fi
