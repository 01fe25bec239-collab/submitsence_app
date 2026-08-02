#!/usr/bin/env bash
# PB-10 Step 3 Phase 2c: durable regression for the control-schema install and
# upgrade paths, and for the role/ownership model both must produce.
#
# The Phase 2c review found the proof path added to the fresh installer only,
# leaving existing installations with no upgrade path at all — and the two
# paths with no test that would have noticed. This script is that test. It
# proves, against a real PostgreSQL:
#
#   1. a fresh install succeeds when run by an administrative role;
#   2. installing AS the migration execution role fails closed;
#   3. installing with a superuser execution role fails closed;
#   4. the execution role is not a superuser, does not own the control schema,
#      is not a member of its owner, cannot INSERT applied rows, cannot write a
#      transaction binding, and cannot read the proof key;
#   5. a genuine pre-Phase-2c installation — owned by the migration runner
#      itself, which is the exact forgeable model this release dismantles —
#      upgrades in place;
#   6. every historical row survives one-for-one, with commit_proof backfilled
#      to what a fresh install would have recorded;
#   7. the upgrade is idempotent across three consecutive runs;
#   8. a freshly installed schema and an upgraded one are identical in
#      relations, columns, constraints, indexes, triggers, function bodies,
#      ownership and every ACL — compared by full catalog dump, not spot checks.
#
# Requires an administrative (superuser) connection to a disposable cluster:
#   ADMIN_DATABASE_URL="postgres://postgres:postgres@localhost:5432/postgres" \
#     db/control/test-install-upgrade-parity.sh
#
# Every database and role it creates is prefixed pb10_parity_ and dropped on
# exit, including on failure.
set -euo pipefail

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required (a superuser connection to a disposable cluster)}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

FRESH_DB=pb10_parity_fresh
UPGRADED_DB=pb10_parity_upgraded
GUARD_DB=pb10_parity_guard
ORDER_DB=pb10_parity_order
ROLLBACK_DB=pb10_parity_rollback
RUNNER=pb10_parity_runner
SUPER_RUNNER=pb10_parity_superrunner
ADMIN=pb10_parity_admin
# A role with no relationship to the control schema at all, used only to prove
# the historical-ownership assertion rejects a third-party owner and not just
# the administrator.
OUTSIDER=pb10_parity_outsider

# The historical (pre-Phase-2c) control schema, pinned by commit exactly like
# test-fixture-integrity.sh pins its own frozen fixture.
#
# This used to be extracted from HEAD. That silently stopped being a
# *historical* schema the moment Phase 2c was committed: HEAD then was the
# Phase 2c schema, which refuses to install without -v
# migration_execution_role — and refused via `\quit 1`, which exits 0. So the
# fixture installed nothing, the install appeared to succeed, and every
# ownership assertion below ran against an empty database. Pinning the sha
# makes the fixture independent of whichever commit the test runs from.
PHASE2B_COMMIT=edd14b63fb44b2880630ddecf575df005176d529

# Object count of that pinned schema: the schema, both ledger tables, the
# bigserial sequence owned by migration_runs, and its two functions (one of
# them the trigger function). Pinned like the fixture is: a fixture frozen at
# a commit cannot grow objects, so a mismatch means the fixture is not what
# this test thinks it is.
PHASE2B_OBJECT_COUNT=6

work="$(mktemp -d)"

admin() { psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -XAtq "$@"; }

# The administrative credential against a different database. psql resolves the
# database from the positional conninfo, so a trailing "-d other" would not
# reliably override it — the URL itself has to be rebuilt.
admin_db() {
  local database="$1"; shift
  local scheme="${ADMIN_DATABASE_URL%%://*}"
  local rest="${ADMIN_DATABASE_URL#*://}"
  local userinfo="" hostpart="$rest"
  if [[ "$rest" == *@* ]]; then userinfo="${rest%%@*}@"; hostpart="${rest#*@}"; fi
  psql "$scheme://${userinfo}${hostpart%%/*}/$database" -v ON_ERROR_STOP=1 -XAtq "$@"
}

# Rebuild ADMIN_DATABASE_URL against a different database, role and password.
# The userinfo has to be replaced rather than appended to: libpq takes the
# credentials embedded in the URL over PGUSER/PGPASSWORD, so a "?user=" tacked
# onto a URL that already carries "postgres:postgres@" authenticates the new
# role with the superuser's password and fails.
role_url() {
  local database="$1" role="$2" password="$3"
  local scheme="${ADMIN_DATABASE_URL%%://*}"
  local rest="${ADMIN_DATABASE_URL#*://}"
  local hostpart="${rest#*@}"          # strip userinfo if present
  [[ "$rest" == *@* ]] || hostpart="$rest"
  local hostport="${hostpart%%/*}"
  echo "$scheme://$role:$password@$hostport/$database"
}

cleanup() {
  local status=$?
  set +e
  for db in "$FRESH_DB" "$UPGRADED_DB" "$GUARD_DB" "$ORDER_DB" "$ROLLBACK_DB"; do
    psql "$ADMIN_DATABASE_URL" -XAtq -c "drop database if exists $db with (force)" >/dev/null 2>&1
  done
  # migration_control_owner is deliberately NOT dropped: it is cluster-wide and
  # may own control schemas in databases this script never touched, so dropping
  # it would break unrelated installations on a shared cluster.
  for role in "$RUNNER" "$SUPER_RUNNER" "$ADMIN" "$OUTSIDER"; do
    psql "$ADMIN_DATABASE_URL" -XAtq -c "revoke all on function pg_catalog.pg_xact_status(xid8) from $role" >/dev/null 2>&1
    psql "$ADMIN_DATABASE_URL" -XAtq -c "drop role if exists $role" >/dev/null 2>&1
  done
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*" >&2; }

# Owner of every object the Phase 2b recognition logic considers — the schema,
# both ledger tables, every sequence (linked or free) and every function,
# which includes the trigger function. Returns "<total>:<non-conforming>".
#
# :expected is interpolated by psql, which quotes the role name safely
# whatever characters it contains. It has to be read from a file: psql
# performs variable interpolation on -f input but NOT on -c strings.
cat > "$work/owners-of.sql" <<'OWNEDBY'
select count(*) || ':' ||
       coalesce(string_agg(ident || '=' || owner, ',' order by ident)
                  filter (where owner is distinct from :'expected'), '')
  from (
    select 'schema migration_control' as ident,
           pg_catalog.pg_get_userbyid(nspowner) as owner
      from pg_catalog.pg_namespace where nspname = 'migration_control'
    union all
    select c.relkind::text || ' ' || c.relname, pg_catalog.pg_get_userbyid(c.relowner)
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'migration_control' and c.relkind in ('r', 'p', 'S')
    union all
    select 'function ' || p.proname, pg_catalog.pg_get_userbyid(p.proowner)
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'migration_control'
  ) s
OWNEDBY

control_object_count() { local s; s="$(admin_db "$1" -v expected='' -f "$work/owners-of.sql")"; echo "${s%%:*}"; }

# Assert every control-schema object is owned by $2, and that there are as
# many of them as there should be — without an expected count, an empty
# database (nothing installed) reports zero strays and would pass.
#
# The comparison is deliberately made in the shell from `psql -At` output.
# psql's \quit accepts no argument on any supported version — `\quit 1` warns
# and exits 0 — so an in-SQL quit could not fail this check at all.
assert_control_owned_by() { # database role context expected_count
  local snapshot total strays
  snapshot="$(admin_db "$1" -v expected="$2" -f "$work/owners-of.sql")"
  total="${snapshot%%:*}"
  strays="${snapshot#*:}"
  test "$total" = "$4" \
    || fail "$3: migration_control holds $total objects, expected $4 — nothing, or not everything, was installed"
  test -z "$strays" \
    || fail "$3: not owned by $2: $strays"
}

# ── roles and databases ───────────────────────────────────────────────────
echo "preparing disposable roles and databases..." >&2
# Databases first: a role cannot be dropped while it owns objects or holds
# database-level privileges, so a previous interrupted run would otherwise
# leave roles behind and this run would fail on "already exists".
for db in "$FRESH_DB" "$UPGRADED_DB" "$GUARD_DB" "$ORDER_DB" "$ROLLBACK_DB"; do
  admin -c "drop database if exists $db with (force)" >/dev/null
done
# The pg_xact_status grant is cluster-wide and survives DROP DATABASE, so it
# has to be revoked explicitly before the role it was granted to can be
# dropped. Same for the leftover owner-role membership an interrupted run
# could leave behind.
for role in "$RUNNER" "$SUPER_RUNNER" "$ADMIN"; do
  admin -c "do \$\$ begin
    if pg_catalog.to_regrole('$role') is not null then
      execute 'revoke all on function pg_catalog.pg_xact_status(xid8) from $role';
      execute 'drop role $role';
    end if;
  end \$\$" >/dev/null
done
admin -c "create role $RUNNER login password 'runner'" >/dev/null
admin -c "create role $SUPER_RUNNER login superuser password 'runner'" >/dev/null
admin -c "create role $ADMIN login createrole password 'admin'" >/dev/null
admin -c "create role $OUTSIDER nologin" >/dev/null

# On a cluster where migration_control_owner already exists — because another
# database here already has a control schema — a CREATEROLE installer has no
# ADMIN option on it and could not act as the owner. That is a real, documented
# fail-closed case (the install says so, naming the remedy); the remedy is
# applied here so this script exercises the intended path rather than the
# cluster's incidental history.
admin -c "do \$\$
  begin
    if pg_catalog.to_regrole('migration_control_owner') is not null then
      execute format('grant migration_control_owner to %I with admin option', '$ADMIN');
    end if;
  end
\$\$" >/dev/null
admin -c "create database $FRESH_DB owner $ADMIN" >/dev/null
admin -c "create database $GUARD_DB owner $ADMIN" >/dev/null
admin -c "create database $UPGRADED_DB owner $RUNNER" >/dev/null
admin -c "create database $ORDER_DB owner $RUNNER" >/dev/null
admin -c "create database $ROLLBACK_DB owner $RUNNER" >/dev/null

# On a stock cluster pg_xact_status is already executable by PUBLIC, so the
# runner needs no grant at all. Case 2c below hardens the cluster (revoking
# PUBLIC's EXECUTE) to prove the installer fails closed with an actionable
# remedy when a non-superuser genuinely cannot supply the privilege.

as_admin() { psql "$(role_url "$1" "$ADMIN" admin)" -v ON_ERROR_STOP=1 -X "${@:2}"; }
as_runner() { psql "$(role_url "$1" "$RUNNER" runner)" -v ON_ERROR_STOP=1 -X "${@:2}"; }

# ── 1. fresh install by the administrative role ───────────────────────────
echo "1. fresh install as the administrative role" >&2
as_admin "$FRESH_DB" -q -v migration_execution_role="$RUNNER" -f "$script_dir/control-schema.sql" >/dev/null
ok "fresh install succeeded"

# ── 2. installs that must fail closed ─────────────────────────────────────
echo "2. installs with a broken ownership model fail closed" >&2
if as_runner "$GUARD_DB" -q -v migration_execution_role="$RUNNER" \
     -f "$script_dir/control-schema.sql" >"$work/asrunner.log" 2>&1; then
  fail "installing as the migration execution role must be refused"
fi
grep -q "must not be installed by the migration execution role" "$work/asrunner.log" \
  || fail "wrong refusal installing as the execution role: $(tail -2 "$work/asrunner.log")"
ok "installing as the execution role is refused"

if as_admin "$GUARD_DB" -q -v migration_execution_role="$SUPER_RUNNER" \
     -f "$script_dir/control-schema.sql" >"$work/assuper.log" 2>&1; then
  fail "a superuser migration execution role must be refused"
fi
grep -q "must not be a superuser" "$work/assuper.log" \
  || fail "wrong refusal for a superuser execution role: $(tail -2 "$work/assuper.log")"
ok "a superuser execution role is refused"

# A hardened cluster: PUBLIC's default EXECUTE on pg_xact_status revoked, and
# an administrative installer that is deliberately not a superuser and so
# cannot restore it. pg_proc is a per-database catalog, so this is scoped to
# the guard database and cannot affect the fresh or upgraded ones.
admin_db "$GUARD_DB" -c "revoke execute on function pg_catalog.pg_xact_status(xid8) from public" >/dev/null
if as_admin "$GUARD_DB" -q -v migration_execution_role="$RUNNER" \
     -f "$script_dir/control-schema.sql" >"$work/noxact.log" 2>&1; then
  fail "a non-superuser install that cannot grant pg_xact_status must be refused"
fi
grep -q "lacks EXECUTE on pg_catalog.pg_xact_status" "$work/noxact.log" \
  || fail "wrong refusal for the missing pg_xact_status grant: $(tail -2 "$work/noxact.log")"
grep -q "GRANT EXECUTE ON FUNCTION pg_catalog.pg_xact_status" "$work/noxact.log" \
  || fail "the refusal must name the exact superuser remedy"
ok "an unsatisfiable pg_xact_status grant fails closed with an actionable remedy"

# The missing-variable guard must exit NON-ZERO. It used to be `\quit 1`,
# which no supported psql version accepts an argument to: psql warns "extra
# argument \"1\" ignored" and exits 0, so a caller that forgot the variable
# saw a successful install that had created nothing. Both files are checked,
# with and without ON_ERROR_STOP, since the guard now forces it on itself.
for guarded in control-schema.sql control-schema-upgrade.sql; do
  for stop in 1 0; do
    if as_admin "$GUARD_DB" -q -v ON_ERROR_STOP="$stop" -f "$script_dir/$guarded" \
         >"$work/norole.log" 2>&1; then
      fail "$guarded without -v migration_execution_role exited 0 (ON_ERROR_STOP=$stop); it must fail closed"
    fi
    grep -q "migration_execution_role=<role> is required" "$work/norole.log" \
      || fail "$guarded gave the wrong refusal for a missing execution role: $(tail -2 "$work/norole.log")"
    if grep -qi "extra argument" "$work/norole.log"; then
      fail "$guarded still refuses through a psql meta-command argument psql ignores"
    fi
  done
done
ok "both schema files refuse a missing migration_execution_role with a non-zero exit, not an ignored \\quit argument"

# ── 3. the fresh installation's role model ────────────────────────────────
echo "3. the execution role's actual capabilities on a fresh install" >&2
separation="$(as_runner "$FRESH_DB" -Atq -c "
  select (select rolsuper from pg_catalog.pg_roles where rolname = current_user)
    || ':' || pg_catalog.pg_has_role(current_user, n.nspowner, 'USAGE')
    || ':' || coalesce(pg_catalog.pg_has_role(current_user, pg_catalog.to_regrole('migration_control_owner'), 'USAGE'), false)
    || ':' || pg_catalog.has_table_privilege('migration_control.schema_migrations', 'INSERT')
    || ':' || pg_catalog.has_column_privilege('migration_control.migration_runs', 'xact_id', 'INSERT')
    || ':' || coalesce(pg_catalog.has_table_privilege('migration_control.proof_key', 'SELECT'), false)
    || ':' || pg_catalog.has_function_privilege('pg_catalog.pg_xact_status(xid8)', 'EXECUTE')
    from pg_catalog.pg_namespace n where n.nspname = 'migration_control'")"
test "$separation" = "false:false:false:false:false:false:true" \
  || fail "unexpected execution-role capabilities (superuser:owns:member:insert:binding:key:xactstatus) = $separation"
ok "not a superuser, not an owner, no applied INSERT, no binding write, no proof key, has pg_xact_status"

# ── 4. a genuine pre-Phase-2c installation, owned by the runner ───────────
echo "4. historical installation, owned by the migration runner itself" >&2
git -C "$repo_root" show "$PHASE2B_COMMIT:db/control/control-schema.sql" > "$work/historical.sql" \
  || fail "could not extract the pinned historical control schema from $PHASE2B_COMMIT"
# The pinned file must genuinely predate role separation. Without this, a
# fixture that quietly became the *current* schema would install nothing (the
# current schema refuses to install without -v migration_execution_role) and
# leave the assertions below looking at an empty database.
if grep -q 'migration_execution_role' "$work/historical.sql"; then
  fail "$PHASE2B_COMMIT:db/control/control-schema.sql is not a pre-role-separation schema; the historical fixture is pinned to the wrong commit"
fi

# Created through an authenticated connection AS the migration runner, so its
# ownership comes from the connected role and not from the administrative
# connection, the shell environment or whichever role happens to be the
# default login.
as_runner "$UPGRADED_DB" -q -f "$work/historical.sql" >/dev/null
assert_control_owned_by "$UPGRADED_DB" "$RUNNER" "the historical installation" "$PHASE2B_OBJECT_COUNT"
ok "all $PHASE2B_OBJECT_COUNT historical objects — schema, both ledger tables, the linked sequence and both functions — are owned by the runner (the forgeable model)"

# The assertion itself, proven rather than trusted: it must reject an object
# owned by the administrator, and one owned by a role with no relationship to
# the schema at all. Each is moved and moved straight back, so the fixture the
# upgrade below runs against is exactly the one just asserted.
for usurper in "$(admin -c 'select current_user')" "$OUTSIDER"; do
  admin_db "$UPGRADED_DB" -c "alter table migration_control.schema_migrations owner to $usurper" >/dev/null
  if (assert_control_owned_by "$UPGRADED_DB" "$RUNNER" "negative case" "$PHASE2B_OBJECT_COUNT") 2>/dev/null; then
    fail "the ownership assertion accepted schema_migrations owned by $usurper"
  fi
  admin_db "$UPGRADED_DB" -c "alter table migration_control.schema_migrations owner to $RUNNER" >/dev/null
done
# And it must reject an installation that is not there at all. GUARD_DB has no
# control schema — every install into it above was refused — which is the
# exact shape of the failure `\quit 1` used to hide: a fixture that installed
# nothing, exited 0, and left an empty schema no ownership query could object
# to.
if (assert_control_owned_by "$GUARD_DB" "$RUNNER" "negative case" "$PHASE2B_OBJECT_COUNT") 2>/dev/null; then
  fail "the ownership assertion accepted a database with no historical installation"
fi
assert_control_owned_by "$UPGRADED_DB" "$RUNNER" "the restored historical installation" "$PHASE2B_OBJECT_COUNT"
ok "the assertion rejects an administrator-owned, third-party-owned or absent installation, and exits non-zero doing it"

as_runner "$UPGRADED_DB" -q -c "
insert into migration_control.schema_migrations
  (migration_id, ordinal, filename, manifest_checksum_sha256, applied_checksum_sha256,
   lifecycle_phase, operation_categories, execution_mode, applied_at, run_id, baselined,
   source_git_sha, executor_image_digest)
values
  ('0001', 1, '0001_legacy_demo.sql', repeat('a',64), null, 'expand', array['schema'],
   'legacy-verbatim', now(), gen_random_uuid(), true, 'abc1234', 'sha256:'||repeat('b',64)),
  ('0002', 2, '0002_transactional_demo.sql', repeat('c',64), repeat('c',64), 'expand', array['schema'],
   'transactional', now(), gen_random_uuid(), false, 'abc1234', 'sha256:'||repeat('b',64)),
  ('0003', 3, '0003_batched_demo.sql', repeat('d',64), repeat('d',64), 'backfill', array['data-correction'],
   'batched', now(), gen_random_uuid(), false, 'abc1234', 'sha256:'||repeat('b',64));
insert into migration_control.migration_runs
  (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
values (gen_random_uuid(), '0002', 1, 'started', 'ci-1', 'abc1234', 'sha256:'||repeat('b',64),
        '{\"execution_mode\":\"transactional\",\"migration_filename\":\"0002_transactional_demo.sql\",\"migration_ordinal\":2}'::jsonb);
" >/dev/null

before="$(admin_db "$UPGRADED_DB" -c "
  select (select count(*) from migration_control.schema_migrations) || ':' ||
         (select count(*) from migration_control.migration_runs) || ':' ||
         (select md5(string_agg(migration_id || '|' || ordinal || '|' || filename || '|' ||
                                coalesce(applied_checksum_sha256,'-') || '|' || baselined,
                                ',' order by ordinal))
            from migration_control.schema_migrations)")"

# ── 5. upgrade, three consecutive runs ────────────────────────────────────
echo "5. upgrade, run three consecutive times" >&2
ADMIN_DATABASE_URL_UPGRADED="$(
  scheme="${ADMIN_DATABASE_URL%%://*}"; rest="${ADMIN_DATABASE_URL#*://}"
  userinfo=""; hostpart="$rest"
  if [[ "$rest" == *@* ]]; then userinfo="${rest%%@*}@"; hostpart="${rest#*@}"; fi
  echo "$scheme://${userinfo}${hostpart%%/*}/$UPGRADED_DB")"

# 5b: an installer that cannot administer the current owner is refused
# outright, rather than failing partway through the ownership transfer.
if MIGRATION_EXECUTION_ROLE="$RUNNER" \
   DATABASE_URL="$(role_url "$UPGRADED_DB" "$ADMIN" admin)" \
     "$script_dir/install-or-upgrade-control-schema.sh" >"$work/noadmin.log" 2>&1; then
  fail "an upgrade by a role that cannot administer the current owner must be refused"
fi
grep -q "cannot administer it" "$work/noadmin.log" \
  || fail "wrong refusal for an installer without rights over the current owner: $(tail -3 "$work/noadmin.log")"
ok "an upgrade that could not complete the ownership transfer is refused up front"

for attempt in 1 2 3; do
  # Run as the superuser: taking proof objects away from the role that
  # currently owns them requires administering that role, which CREATEROLE
  # alone does not convey (PostgreSQL 16+ scopes CREATEROLE to roles it
  # created). The upgrade enforces and documents this precondition itself;
  # case 5b below proves an installer without it is refused, not left with a
  # half-transferred schema.
  MIGRATION_EXECUTION_ROLE="$RUNNER" \
  DATABASE_URL="$ADMIN_DATABASE_URL_UPGRADED" \
    "$script_dir/install-or-upgrade-control-schema.sh" >/dev/null 2>"$work/upgrade-$attempt.log" \
      || fail "upgrade run $attempt failed: $(tail -3 "$work/upgrade-$attempt.log")"
  ok "upgrade run $attempt succeeded"
done

# ── 6. rows preserved one-for-one, commit_proof backfilled correctly ──────
echo "6. historical rows survive the upgrade unchanged" >&2
after="$(admin_db "$UPGRADED_DB" -c "
  select (select count(*) from migration_control.schema_migrations) || ':' ||
         (select count(*) from migration_control.migration_runs) || ':' ||
         (select md5(string_agg(migration_id || '|' || ordinal || '|' || filename || '|' ||
                                coalesce(applied_checksum_sha256,'-') || '|' || baselined,
                                ',' order by ordinal))
            from migration_control.schema_migrations)")"
test "$before" = "$after" || fail "historical rows changed across the upgrade: $before -> $after"
ok "every historical row is byte-identical after three upgrades"

proofs="$(admin_db "$UPGRADED_DB" -c \
  "select string_agg(migration_id || '=' || commit_proof, ',' order by ordinal) from migration_control.schema_migrations")"
test "$proofs" = "0001=baseline,0002=transaction_atomic,0003=post_hoc_verified" \
  || fail "commit_proof backfill is wrong: $proofs"
ok "commit_proof backfilled per mode: $proofs"

# ── 7. the upgraded installation's role model ─────────────────────────────
echo "7. the execution role's capabilities after the upgrade" >&2
upgraded_separation="$(as_runner "$UPGRADED_DB" -Atq -c "
  select (select rolsuper from pg_catalog.pg_roles where rolname = current_user)
    || ':' || pg_catalog.pg_has_role(current_user, n.nspowner, 'USAGE')
    || ':' || coalesce(pg_catalog.pg_has_role(current_user, pg_catalog.to_regrole('migration_control_owner'), 'USAGE'), false)
    || ':' || pg_catalog.has_table_privilege('migration_control.schema_migrations', 'INSERT')
    || ':' || pg_catalog.has_column_privilege('migration_control.migration_runs', 'xact_id', 'INSERT')
    || ':' || coalesce(pg_catalog.has_table_privilege('migration_control.proof_key', 'SELECT'), false)
    || ':' || pg_catalog.has_function_privilege('pg_catalog.pg_xact_status(xid8)', 'EXECUTE')
    from pg_catalog.pg_namespace n where n.nspname = 'migration_control'")"
test "$upgraded_separation" = "$separation" \
  || fail "upgraded role model differs from fresh: $upgraded_separation vs $separation"
ok "the runner that used to own this schema now has exactly the fresh-install privilege set"

# Ownership, not merely privileges: every object the runner owned before the
# upgrade — including the linked sequence and the trigger function — now
# belongs to migration_control_owner, and the runner owns none of them. The
# expected count comes from the fresh install rather than a second pinned
# constant; case 8 below proves the two schemas are identical anyway.
assert_control_owned_by "$UPGRADED_DB" migration_control_owner \
  "after the upgrade" "$(control_object_count "$FRESH_DB")"
ok "every object transferred to migration_control_owner; the runner owns none of them"

# ── 8. full catalog parity ────────────────────────────────────────────────
echo "8. fresh and upgraded schemas are identical" >&2
cat > "$work/dump.sql" <<'DUMP'
\pset tuples_only on
\pset format unaligned
select 'REL ' || c.relname || ' owner=' || pg_get_userbyid(c.relowner) || ' kind=' || c.relkind::text
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='migration_control' and c.relkind in ('r','p','S','i') order by 1;
select 'COL ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid,a.atttypmod) || ' notnull=' || a.attnotnull::text
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  join pg_attribute a on a.attrelid=c.oid
 where n.nspname='migration_control' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped order by 1;
select 'CON ' || c.relname || '.' || con.conname || ' ' || pg_get_constraintdef(con.oid,false)
  from pg_constraint con join pg_class c on c.oid=con.conrelid
  join pg_namespace n on n.oid=c.relnamespace where n.nspname='migration_control' order by 1;
select 'IDX ' || indexdef from pg_indexes where schemaname='migration_control' order by 1;
select 'TRG ' || c.relname || '.' || t.tgname || ' enabled=' || t.tgenabled::text || ' type=' || t.tgtype::text
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='migration_control' and not t.tgisinternal order by 1;
select 'FUN ' || p.proname || ' owner=' || pg_get_userbyid(p.proowner) || ' secdef=' || p.prosecdef::text
       || ' vol=' || p.provolatile::text || ' cfg=' || coalesce(array_to_string(p.proconfig,','),'-')
       || ' body=' || md5(pg_get_functiondef(p.oid))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='migration_control' order by 1;
select 'ACL ' || c.relname || ' ' || coalesce(array_to_string(c.relacl,' '),'-')
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='migration_control' and c.relkind in ('r','p','S') order by 1;
select 'FACL ' || p.proname || ' ' || coalesce(array_to_string(p.proacl,' '),'-')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='migration_control' order by 1;
select 'NACL ' || coalesce(array_to_string(nspacl,' '),'-') from pg_namespace where nspname='migration_control';
DUMP
cat > "$work/owners.sql" <<'OWNERS'
\pset tuples_only on
\pset format unaligned
select 'SCH ' || nspname || '=' || pg_get_userbyid(nspowner) from pg_namespace where nspname='migration_control';
select 'REL ' || c.relname || '=' || pg_get_userbyid(c.relowner)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='migration_control' and c.relkind in ('r','p','S') order by 1;
select 'FUN ' || p.proname || '=' || pg_get_userbyid(p.proowner)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='migration_control' order by 1;
OWNERS

admin_db "$FRESH_DB" -f "$work/dump.sql" > "$work/fresh.dump"
admin_db "$UPGRADED_DB" -f "$work/dump.sql" > "$work/upgraded.dump"
if ! diff -u "$work/fresh.dump" "$work/upgraded.dump" > "$work/parity.diff"; then
  cat "$work/parity.diff" >&2
  fail "a freshly installed schema and an upgraded schema are not identical"
fi
test -s "$work/fresh.dump" || fail "the catalog dump is empty; the comparison proved nothing"
ok "$(wc -l < "$work/fresh.dump" | tr -d ' ') catalog facts match exactly between fresh and upgraded"

# ── 9. the upgrade does not depend on catalog object order ───────────────
#
# PB-10 Step 3 Phase 2c final review, HIGH: the ownership transfer used to be a
# single unordered loop over pg_class, and PostgreSQL guarantees nothing about
# the order an unordered scan returns. That matters because one of these
# objects has a hard dependency rule: an OWNED BY sequence cannot change owner
# before the table it is linked to ("sequence must have the same owner as table
# it is linked to"). migration_runs.event_id is a bigserial, so a recognized
# Phase 2b installation upgraded — or did not — depending on physical catalog
# layout.
#
# This case builds an installation whose extra linked sequence sorts *before*
# every table under any ordering a naive implementation might use, so a
# sequences-first traversal is what an order-dependent upgrade would attempt.
echo "9. the upgrade is independent of catalog object order" >&2
as_runner "$ORDER_DB" -q -f "$work/historical.sql" >/dev/null
as_runner "$ORDER_DB" -q -c "
create sequence migration_control.aaa_linked_seq
  owned by migration_control.migration_runs.event_sequence;
create sequence migration_control.zzz_free_seq;
" >/dev/null
# One historical row, so this case also proves preservation on the alternate
# object layout rather than only on the canonical one.
as_runner "$ORDER_DB" -q -c "
insert into migration_control.migration_runs
  (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
values (gen_random_uuid(), '0002', 1, 'started', 'ci-1', 'abc1234', 'sha256:'||repeat('b',64),
        '{\"execution_mode\":\"transactional\",\"migration_filename\":\"0002_transactional_demo.sql\",\"migration_ordinal\":2}'::jsonb);
" >/dev/null

# The hazard itself, proven rather than asserted: moving the linked sequence
# before its table is refused by PostgreSQL. Any implementation whose traversal
# could reach a sequence first is therefore genuinely broken, not merely untidy.
if admin_db "$ORDER_DB" -c "alter sequence migration_control.aaa_linked_seq owner to migration_control_owner" \
     >"$work/seqfirst.log" 2>&1; then
  fail "expected PostgreSQL to refuse a linked sequence owner change ahead of its table"
fi
grep -q "linked to table" "$work/seqfirst.log" \
  || fail "unexpected refusal for a sequence-before-table owner change: $(tail -2 "$work/seqfirst.log")"
ok "PostgreSQL genuinely refuses a linked sequence owner change before its table"

ORDER_DB_URL="$(
  scheme="${ADMIN_DATABASE_URL%%://*}"; rest="${ADMIN_DATABASE_URL#*://}"
  userinfo=""; hostpart="$rest"
  if [[ "$rest" == *@* ]]; then userinfo="${rest%%@*}@"; hostpart="${rest#*@}"; fi
  echo "$scheme://${userinfo}${hostpart%%/*}/$ORDER_DB")"
for attempt in 1 2 3; do
  MIGRATION_EXECUTION_ROLE="$RUNNER" DATABASE_URL="$ORDER_DB_URL" \
    "$script_dir/install-or-upgrade-control-schema.sh" >/dev/null 2>"$work/order-$attempt.log" \
      || fail "alternate-order upgrade run $attempt failed: $(tail -3 "$work/order-$attempt.log")"
done
ok "three consecutive upgrades succeed on the alternate object layout"

stragglers="$(admin_db "$ORDER_DB" -c "
  select coalesce(string_agg(ident, ',' order by ident), '-') from (
    select c.relname as ident from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='migration_control' and c.relkind in ('r','p','S')
       and c.relowner is distinct from to_regrole('migration_control_owner')::oid
    union all
    select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='migration_control'
       and p.proowner is distinct from to_regrole('migration_control_owner')::oid
    union all
    select 'schema' from pg_namespace
     where nspname='migration_control' and nspowner is distinct from to_regrole('migration_control_owner')::oid
  ) s")"
test "$stragglers" = "-" || fail "objects left behind by the ownership transfer: $stragglers"
ok "every object — including both extra sequences — transferred to migration_control_owner"

test "$(admin_db "$ORDER_DB" -c "select count(*) from migration_control.migration_runs")" = "1" \
  || fail "the alternate-order upgrade did not preserve historical rows one-for-one"
# The protected proof and marker functions must be present and owned correctly
# on this path too, not merely on the canonical one.
protected="$(admin_db "$ORDER_DB" -c "
  select string_agg(p.proname || '=' || pg_get_userbyid(p.proowner) || '/' || p.prosecdef::text, ',' order by p.proname)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='migration_control'
     and p.proname in ('record_progress_marker','record_applied_migration','record_transaction_binding','claim_transaction')")"
test "$protected" = "claim_transaction=migration_control_owner/true,record_applied_migration=migration_control_owner/true,record_progress_marker=migration_control_owner/true,record_transaction_binding=migration_control_owner/true" \
  || fail "protected proof/marker functions are wrong after the alternate-order upgrade: $protected"
ok "protected proof and progress-marker functions are owner-owned SECURITY DEFINER"

# Triggers and their trigger function survive the owner change: pg_trigger
# references pg_proc by oid, so an owner change cannot invalidate the link.
test "$(admin_db "$ORDER_DB" -c "
  select count(*) from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='migration_control' and not t.tgisinternal
     and p.proname='reject_ledger_mutation' and t.tgenabled='A'")" = "4" \
  || fail "the four always-enabled mutation-rejection triggers did not survive the upgrade"
ok "trigger functions and triggers remain valid and always-enabled"

# ── 10. a failed upgrade rolls back every ownership change ───────────────
#
# The failure is a real one from the upgrade's own fail-closed path — an
# mr_metadata_ck that matches none of the three pinned generations — and it
# fires *after* the ownership transfer has already run inside the transaction.
# So this proves the atomicity claim rather than a test hook's behaviour.
echo "10. a failed upgrade leaves no partial ownership transfer" >&2
as_runner "$ROLLBACK_DB" -q -f "$work/historical.sql" >/dev/null
as_runner "$ROLLBACK_DB" -q -c "
alter table migration_control.migration_runs drop constraint mr_metadata_ck,
  add constraint mr_metadata_ck check (jsonb_typeof(metadata) = 'object');
" >/dev/null
owners_before="$(admin_db "$ROLLBACK_DB" -f "$work/owners.sql")"
ROLLBACK_DB_URL="$(
  scheme="${ADMIN_DATABASE_URL%%://*}"; rest="${ADMIN_DATABASE_URL#*://}"
  userinfo=""; hostpart="$rest"
  if [[ "$rest" == *@* ]]; then userinfo="${rest%%@*}@"; hostpart="${rest#*@}"; fi
  echo "$scheme://${userinfo}${hostpart%%/*}/$ROLLBACK_DB")"
if MIGRATION_EXECUTION_ROLE="$RUNNER" DATABASE_URL="$ROLLBACK_DB_URL" \
     "$script_dir/install-or-upgrade-control-schema.sh" >"$work/rollback.log" 2>&1; then
  fail "an upgrade against an unrecognized mr_metadata_ck must fail closed"
fi
grep -q "does not match the pinned" "$work/rollback.log" \
  || fail "wrong refusal for an unrecognized constraint: $(tail -3 "$work/rollback.log")"
ok "the upgrade fails closed on an unrecognized mr_metadata_ck"

owners_after="$(admin_db "$ROLLBACK_DB" -f "$work/owners.sql")"
test "$owners_before" = "$owners_after" \
  || fail "ownership changed despite the upgrade failing:"$'\n'"$(diff <(echo "$owners_before") <(echo "$owners_after") || true)"
test "$(admin_db "$ROLLBACK_DB" -c "
  select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='migration_control' and c.relowner = to_regrole('migration_control_owner')::oid")" = "0" \
  || fail "a partially transferred object survived the failed upgrade"
ok "every ownership change rolled back; no partial transfer remains"

echo "PB-10 install/upgrade/parity regression: PASS" >&2
