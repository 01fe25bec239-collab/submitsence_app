#!/usr/bin/env bash
# Regression test for PB-10 Phase 1 blocker: search_path spoofing.
#
# Proves control-schema-upgrade.sql cannot be tricked by a session-scoped
# pg_temp shadow of to_regnamespace/to_regclass/pg_get_constraintdef — the
# classic search_path-injection vector (pg_temp is always searched first for
# unqualified names, regardless of search_path content). The script fully
# qualifies every catalog reference with pg_catalog., so the hostile shadows
# must never be consulted and the real upgrade must still produce the real,
# correct result.
#
# Requires a disposable target:
#   PGDATABASE_URL="postgres://owner@host:5432/scratch_db" \
#     db/control/test-hostile-search-path.sh
set -euo pipefail

: "${PGDATABASE_URL:?PGDATABASE_URL is required (a disposable, superuser-owned scratch database)}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
previous_def="$(cat "$script_dir/fixtures/mr_metadata_ck.previous.def")"
current_def="$(cat "$script_dir/fixtures/mr_metadata_ck.current.def")"

echo "installing the previous PB-10 control schema..." >&2
psql "$PGDATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -f "$script_dir/fixtures/control-schema.pre-metadata-filename-ordinal.sql"

echo "running the real upgrade inside a session with hostile pg_temp shadows..." >&2
psql "$PGDATABASE_URL" -v ON_ERROR_STOP=1 \
  -v script_dir="$script_dir" \
  -v previous_metadata_ck_def="$previous_def" \
  -v current_metadata_ck_def="$current_def" \
  -f "$script_dir/test-hostile-search-path.inner.sql"

echo "verifying the real (correct) upgrade actually happened..." >&2
live_def="$(psql "$PGDATABASE_URL" -XAtq -c "
  select pg_catalog.pg_get_constraintdef(con.oid, false)
    from pg_catalog.pg_constraint con
   where con.conrelid = 'migration_control.migration_runs'::regclass
     and con.conname = 'mr_metadata_ck'
")"

if [[ "$live_def" != "$current_def" ]]; then
  echo "FAIL: mr_metadata_ck does not match the pinned current definition after upgrade under a hostile search_path" >&2
  echo "This means the hostile pg_temp shadow influenced the result (search_path spoofing succeeded)." >&2
  exit 1
fi

echo "PASS: hostile pg_temp shadows of to_regnamespace/to_regclass/pg_get_constraintdef had no effect" >&2
