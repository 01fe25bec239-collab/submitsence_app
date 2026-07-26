#!/usr/bin/env bash
# Regression test for the PB-10 Phase 1 production-wiring defects in
# migrate.sh's infrastructure-ledger lookup and insert:
#
#   - the lookup previously used `psql -Atqc "... where filename = '$filename'"`,
#     shell-splicing the filename directly into a SQL string literal (unsafe,
#     and broken outright by a filename containing a single quote);
#   - the insert previously used `psql -c` with `:'filename'`, and psql only
#     performs :name / :'name' variable interpolation when reading a script
#     (a -f file, or stdin as used now) — never for a -c argument. That sent
#     the literal text `:'filename'` to PostgreSQL, which rejected it with a
#     syntax error.
#
# This test extracts the exact lookup and insert snippets from migrate.sh
# (between their "ledger-lookup:" / "ledger-insert:" begin/end markers) and
# exercises them together, in the same order and with the same
# skip-if-already-applied logic as the real loop body, against a disposable
# database — so it always tracks the real production code rather than a
# hand-copied duplicate that could drift.
#
#   PGHOST=... PGPORT=... PGDATABASE=... PGUSER=... PGPASSWORD=... \
#     infra/scripts/test-migrate-ledger-insert.sh
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${PGDATABASE:?PGDATABASE is required (a disposable, superuser-owned scratch database)}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lookup_snippet="$(mktemp)"
insert_snippet="$(mktemp)"
trap 'rm -f "$lookup_snippet" "$insert_snippet"' EXIT

extract() {
  sed -n "/# $1: begin/,/# $1: end/p" "$script_dir/migrate.sh" | sed '1d;$d'
}
extract "ledger-lookup" > "$lookup_snippet"
extract "ledger-insert" > "$insert_snippet"

if [[ ! -s "$lookup_snippet" ]]; then
  echo "FAIL: could not extract the ledger-lookup snippet from migrate.sh (markers missing?)" >&2
  exit 1
fi
if [[ ! -s "$insert_snippet" ]]; then
  echo "FAIL: could not extract the ledger-insert snippet from migrate.sh (markers missing?)" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 -q -c "
  drop table if exists public.infrastructure_schema_migrations;
  create table public.infrastructure_schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  );
"

lookup() {
  # The extracted snippet only assigns the shell variable "applied" (exactly
  # as migrate.sh's own loop body does, immediately followed there by
  # `[[ "$applied" == "1" ]] && continue` in the same shell); it never
  # prints anything itself. Source it in an isolated subshell and echo the
  # result out, so this test can observe it via command substitution
  # without changing a single byte of the real production snippet.
  (
    filename="$1"
    # shellcheck disable=SC1090
    source "$lookup_snippet"
    echo "$applied"
  )
}

insert() {
  filename="$1" bash "$insert_snippet"
}

# Mirrors migrate.sh's own loop body exactly: look up, skip if already
# applied, otherwise insert. Returns via the "applied" global so callers can
# assert on it, same as the real script does.
lookup_then_insert() {
  applied="$(lookup "$1")"
  [[ "$applied" == "1" ]] && return
  insert "$1"
}

recorded_count() {
  psql -Atq -c "select count(*) from public.infrastructure_schema_migrations where filename = \$\$${1}\$\$"
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

filenames=(
  "0001_extensions_helpers.sql"
  "9999_o'brien.sql"
  "9999_has spaces.sql"
  "9999_has\$dollar.sql"
  "9999_semi;colon--.sql"
)

for name in "${filenames[@]}"; do
  echo "--- case: first execution records '$name' exactly once ---" >&2
  out="$(mktemp)"
  lookup_then_insert "$name" > "$out" 2>&1
  [[ "$(recorded_count "$name")" == "1" ]] || fail "'$name' was not recorded after first execution"
  if grep -qi "syntax error" "$out"; then
    fail "a syntax error was raised recording '$name':\n$(cat "$out")"
  fi
  if grep -F ":'filename'" "$out"; then
    fail "the literal token :'filename' appeared in output for '$name' — substitution did not happen"
  fi
  if grep -qF "$PGPASSWORD" "$out"; then
    fail "PGPASSWORD leaked into output for '$name'"
  fi
  echo "PASS: '$name' recorded exactly once, no literal :'filename', no credential leak" >&2

  echo "--- case: second execution for '$name' is idempotent (lookup reports already-applied, no duplicate insert) ---" >&2
  applied_second="$(lookup "$name")"
  [[ "$applied_second" == "1" ]] || fail "lookup did not report '$name' as already applied on the second pass"
  lookup_then_insert "$name" > "$out" 2>&1
  [[ "$(recorded_count "$name")" == "1" ]] || fail "'$name' was duplicated after a second execution"
  rm -f "$out"
  echo "PASS: '$name' idempotent — lookup returned applied, no duplicate row" >&2
done

echo "--- case: no direct shell-interpolated filename appears inside either heredoc's SQL body ---" >&2
# Restricted to the heredoc body (between <<'SQL' and the closing SQL line),
# not the whole snippet: the psql invocation itself legitimately contains
# `-v filename="$filename"`, which is the safe mechanism, not raw SQL
# interpolation.
sql_body() {
  sed -n "/<<'SQL'/,/^SQL$/p" "$1" | sed '1d;$d'
}
if grep -qE '\$\{?filename\}?' <(sql_body "$lookup_snippet") <(sql_body "$insert_snippet"); then
  fail "a shell-interpolated \$filename reference was found directly inside the SQL body itself"
fi
echo "PASS: no shell-interpolated filename inside either SQL body" >&2

echo "--- case: a ledger-insert failure (primary-key violation) stops execution clearly and changes nothing further ---" >&2
before_count="$(psql -Atq -c "select count(*) from public.infrastructure_schema_migrations")"
set +e
insert "0001_extensions_helpers.sql" > /tmp/failure-case.log 2>&1
failure_exit=$?
set -e
after_count="$(psql -Atq -c "select count(*) from public.infrastructure_schema_migrations")"
[[ "$failure_exit" -ne 0 ]] || fail "re-inserting a duplicate filename unexpectedly succeeded"
[[ "$before_count" == "$after_count" ]] || fail "row count changed after a failed insert ($before_count -> $after_count)"
grep -qi "duplicate key value" /tmp/failure-case.log || fail "expected a clear duplicate-key error, got: $(cat /tmp/failure-case.log)"
grep -qF "$PGPASSWORD" /tmp/failure-case.log && fail "PGPASSWORD leaked into the failure-case log"
echo "PASS: ledger-insert failure stopped clearly (exit $failure_exit), no row-count change, no credential leak" >&2
rm -f /tmp/failure-case.log

psql -v ON_ERROR_STOP=1 -q -c "drop table public.infrastructure_schema_migrations"

echo "PASS: all ledger lookup-plus-insert regression cases passed" >&2
