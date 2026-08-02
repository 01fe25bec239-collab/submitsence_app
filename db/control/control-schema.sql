-- PB-10 Step 2 migration control schema.
--
-- Install (disposable or approved target only). The migration image already
-- carries this file at /workspace/db/control/control-schema.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v migration_execution_role=<role the migration runner logs in as> \
--     -f db/control/control-schema.sql
--
-- Runs as a single transaction, so re-application fails closed with SQLSTATE
-- 42P06 and changes nothing. See db/README.md for ownership and prerequisites.
--
-- ══════════════════════════════════════════════════════════════════════════
-- PB-10 Step 3 Phase 2c final review, CRITICAL 1 + CRITICAL 2: role
-- separation. This is a deployment-model change, not merely a schema change.
--
-- What was wrong. Until now this schema was installed *by* the migration
-- owner, and db/README.md instructed operators to run migrations as "the
-- owner/superuser role". That single role owned the schema, both ledger
-- tables and every function, and was "the only role able to INSERT". A table
-- owner can INSERT any row, DROP any trigger, ALTER any table and REPLACE any
-- function — and migration SQL itself executes as that same role, so a
-- migration file could issue arbitrary statements against the proof tables.
-- Under that model *no* database mechanism can make a proof unforgeable:
--
--   * an accepted `schema_migrations` row could be INSERTed by hand, with
--     perfectly matching provenance, without the migration transaction ever
--     committing (CRITICAL 1); and
--   * an accepted transaction binding (`migration_runs.xact_id`) could be
--     INSERTed by any connection for any attempt, so an unrelated aborted
--     transaction's id could be bound to a victim attempt and clear it
--     (CRITICAL 2).
--
-- INSERT-only tables, primary keys and UPDATE/DELETE/TRUNCATE triggers do not
-- make INSERTed data authoritative when the relevant ordinary role can insert
-- an arbitrary matching row.
--
-- What replaces it. Two roles, and a proof path the execution role cannot
-- reproduce:
--
--   migration_control_owner  NOLOGIN NOINHERIT NOSUPERUSER. Owns the schema,
--                            both ledger tables, the proof key, the sequence
--                            and every function. Nothing logs in as it.
--   <migration_execution_role>  The role the migration runner connects as and
--                            the role every byte of migration SQL executes
--                            as. It receives USAGE, SELECT, *column-level*
--                            INSERT on migration_runs excluding xact_id, the
--                            sequence, and EXECUTE on exactly three
--                            functions. It receives no INSERT on
--                            schema_migrations, no access at all to the proof
--                            key, and no UPDATE/DELETE/TRUNCATE anywhere.
--
-- Consequently the execution role — and therefore any migration file, and
-- therefore anything an attacker can reach through the supported execution
-- path — can write ordinary event rows and nothing else. Commit proof and
-- transaction bindings exist only as the return value of a SECURITY DEFINER
-- function that reads pg_current_xact_id() itself and never accepts a
-- caller-supplied transaction id. See record_applied_migration and
-- claim_transaction/record_transaction_binding below.
--
-- Install requirement (fails closed below if unmet): this file must be
-- applied by a role that can CREATE ROLE and that is *not*
-- :migration_execution_role, and :migration_execution_role must be neither a
-- superuser nor a member of migration_control_owner. Installing as the
-- migration execution role would leave that role able to SET ROLE to the
-- owner it just created (PostgreSQL grants a CREATEROLE creator ADMIN OPTION
-- on roles it creates), which reinstates exactly the forgery this separation
-- exists to prevent.
-- ══════════════════════════════════════════════════════════════════════════

-- `\quit 1` looks like it exits 1; it does not. psql's \quit has never taken
-- an argument in any supported version — it warns "extra argument \"1\"
-- ignored" and exits **0**. A caller that forgot -v migration_execution_role
-- therefore saw a successful exit and an uninstalled schema. The failure has
-- to come from the server, which ON_ERROR_STOP turns into a non-zero exit on
-- every psql version; ON_ERROR_STOP is forced here so the guard holds even if
-- the caller omitted it.
\if :{?migration_execution_role}
\else
\set ON_ERROR_STOP on
do $missing_execution_role$
begin
  raise exception using
    errcode = '22023',
    message = '-v migration_execution_role=<role> is required; see db/README.md';
end
$missing_execution_role$;
\endif

begin;

-- psql variable interpolation (:name / :'name') does not reach inside
-- $$-quoted PL/pgSQL bodies — the same constraint control-schema-upgrade.sql
-- documents — so the role name is carried into every block below through a
-- transaction-local GUC set here, at top level, where interpolation does
-- apply. `true` makes it SET LOCAL: it disappears with this transaction and
-- can never leak into a later session.
select set_config('migration_control.install_execution_role', :'migration_execution_role', true);

-- Fail closed before creating anything if the ownership model cannot hold.
do $install_guard$
declare
  execution_role constant text := current_setting('migration_control.install_execution_role');
begin
  if pg_catalog.to_regrole(execution_role) is null then
    raise exception using
      errcode = '42704',
      message = 'migration_execution_role does not exist; create the migration runner login role before installing the control schema';
  end if;
  if execution_role = current_user::text then
    raise exception using
      errcode = '42501',
      message = 'the control schema must not be installed by the migration execution role; install as a separate administrative role (see db/README.md)';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = execution_role and rolsuper) then
    raise exception using
      errcode = '42501',
      message = 'the migration execution role must not be a superuser; a superuser bypasses every privilege this schema relies on';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = current_user::text and (rolsuper or rolcreaterole)) then
    raise exception using
      errcode = '42501',
      message = 'installing the control schema requires CREATE ROLE; run it as an administrative role';
  end if;
end
$install_guard$;

do $owner_role$
begin
  if pg_catalog.to_regrole('migration_control_owner') is null then
    create role migration_control_owner nologin noinherit nosuperuser
      nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end
$owner_role$;

-- CREATE on the database is the one database-level privilege the owner needs,
-- and only to create its own schema. It is deliberately not granted anything
-- else, cannot log in, and inherits nothing.
do $owner_create$
begin
  execute format('grant create on database %I to migration_control_owner', current_database());
end
$owner_create$;

-- SET ROLE below requires membership in migration_control_owner *with the SET
-- option*. A superuser always has it implicitly. A non-superuser
-- administrative installer does not — PostgreSQL 16+ gives the creator of a
-- role ADMIN OPTION on it, which conveys the right to grant the role but not
-- the right to become it — so the membership is taken here explicitly and
-- given back at the end of this transaction (see the matching block after
-- `reset role`), leaving no standing ability to act as the proof owner.
--
-- If the owner role pre-exists and this installer has no ADMIN OPTION on it,
-- the GRANT below raises 42501 and the whole install rolls back: an installer
-- that cannot legitimately act as the owner must not install proof objects.
select set_config(
  'migration_control.install_took_owner_membership',
  case when pg_catalog.pg_has_role(current_user, 'migration_control_owner', 'SET') then 'f' else 't' end,
  true);

do $owner_membership$
begin
  if current_setting('migration_control.install_took_owner_membership') = 't' then
    execute format('grant migration_control_owner to %I', current_user);
  end if;
end
$owner_membership$;

-- Every object below is created while acting as the owner role, so ownership
-- never has to be transferred afterwards (and no window exists in which the
-- installing role owns a proof object).
set local role migration_control_owner;

create schema migration_control;
revoke all on schema migration_control from public;

-- Canonical manifest category order, mirroring OPERATION_CATEGORIES in
-- backend/src/db/migrate/manifest.ts. Used by sm_categories_order_ck so a
-- semantically equivalent but differently ordered array is rejected at INSERT
-- time, rather than permanently wedging the read-only plan against a row that
-- can never be updated or deleted.
create function migration_control.canonical_operation_categories(categories text[])
returns text[]
language sql
immutable
returns null on null input
set search_path = pg_catalog, pg_temp
as $$
  select array(
    select category
      from unnest(categories) as category
     order by array_position(
       array[
         'schema',
         'data-correction',
         'security-policy',
         'function-replacement',
         'index',
         'seed-reference'
       ]::text[],
       category
     )
  )
$$;

revoke execute on function migration_control.canonical_operation_categories(text[]) from public;

create table migration_control.schema_migrations (
  migration_id text primary key,
  ordinal integer unique not null,
  filename text unique not null,
  manifest_checksum_sha256 character(64) not null,
  applied_checksum_sha256 character(64),
  lifecycle_phase text not null,
  operation_categories text[] not null,
  execution_mode text not null,
  applied_at timestamptz not null,
  run_id uuid not null,
  baselined boolean not null,
  source_git_sha text not null,
  executor_image_digest text not null,
  -- CRITICAL 1: how this row came to exist, written by
  -- migration_control.record_applied_migration and by nothing else (the
  -- execution role has no INSERT privilege on this table at all, so there is
  -- no other writer). The history evaluator treats only 'transaction_atomic'
  -- as authoritative proof that a migration transaction committed:
  --
  --   transaction_atomic  the row was inserted from *inside* the migration's
  --                       own transaction, by a call whose
  --                       pg_current_xact_id() matched this attempt's already
  --                       durable transaction binding. Its existence is a
  --                       PostgreSQL-enforced consequence of that exact
  --                       transaction committing — a rollback leaves nothing.
  --   post_hoc_verified   nontransactional and batched modes have no single
  --                       migration transaction to commit with, so their
  --                       applied row is written afterwards on the control
  --                       connection once a mode-specific verifier passed. It
  --                       records that the runner accepted the migration; it
  --                       is never evidence about a transaction outcome.
  --   baseline            a baselined legacy row: recorded history, no byte
  --                       evidence and no outcome evidence at all.
  -- commit_proof and its two CHECK constraints are added by
  -- control-proof-path.sql, the single definition shared with the upgrade
  -- path. Appending them there rather than declaring them here is what makes
  -- a fresh table and an upgraded one identical down to column order.
  constraint sm_id_ck check (migration_id ~ '^[0-9]{4}$'),
  constraint sm_ordinal_ck check (ordinal > 0),
  constraint sm_filename_ck check (
    filename ~ '^[0-9]{4}_[a-z0-9]+(_[a-z0-9]+)*[.]sql$'
    and left(filename, 4) = migration_id
  ),
  constraint sm_manifest_sha_ck check (manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  constraint sm_applied_sha_ck check (
    applied_checksum_sha256 is null
    or applied_checksum_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint sm_phase_ck check (lifecycle_phase in ('expand', 'backfill', 'contract')),
  constraint sm_categories_ck check (
    cardinality(operation_categories) > 0
    and operation_categories <@ array[
      'schema',
      'data-correction',
      'security-policy',
      'function-replacement',
      'index',
      'seed-reference'
    ]::text[]
    and cardinality(operation_categories) =
      (case when 'schema' = any(operation_categories) then 1 else 0 end)
      + (case when 'data-correction' = any(operation_categories) then 1 else 0 end)
      + (case when 'security-policy' = any(operation_categories) then 1 else 0 end)
      + (case when 'function-replacement' = any(operation_categories) then 1 else 0 end)
      + (case when 'index' = any(operation_categories) then 1 else 0 end)
      + (case when 'seed-reference' = any(operation_categories) then 1 else 0 end)
  ),
  constraint sm_categories_order_ck check (
    operation_categories
      = migration_control.canonical_operation_categories(operation_categories)
  ),
  constraint sm_mode_ck check (
    execution_mode in ('legacy-verbatim', 'transactional', 'nontransactional', 'batched')
  ),
  constraint sm_baseline_ck check (
    (baselined and applied_checksum_sha256 is null and execution_mode = 'legacy-verbatim')
    or (not baselined and applied_checksum_sha256 is not null)
  ),
  constraint sm_source_sha_ck check (source_git_sha ~ '^[0-9a-f]{7,64}$'),
  constraint sm_image_digest_ck check (executor_image_digest ~ '^sha256:[0-9a-f]{64}$')
);

create table migration_control.migration_runs (
  event_id bigserial primary key,
  run_id uuid not null,
  migration_id text not null,
  event_sequence integer not null,
  event_type text not null,
  occurred_at timestamptz not null default clock_timestamp(),
  runner_id text,
  heartbeat_deadline timestamptz,
  statement_ordinal integer,
  source_git_sha text,
  executor_image_digest text,
  sqlstate text,
  error_class text,
  metadata jsonb not null,
  -- PB-10 Step 3 Phase 2c final review, CRITICAL 1: the transaction-outcome
  -- binding. An event name is not proof that PostgreSQL committed or rolled
  -- back — any row here can be inserted by hand. This column instead records
  -- the full 64-bit id of the *actual* migration transaction, captured with
  -- pg_current_xact_id() from inside that transaction and committed here
  -- (autocommit, control connection) before COMMIT is ever sent. The
  -- authoritative verdict on that transaction is then PostgreSQL's own
  -- pg_xact_status(), which no ledger insertion can alter: a forged
  -- transaction_rolled_back/execution_failed pair cannot make an xid that
  -- committed report 'aborted'. xid8 (never xid) so the value can never be
  -- reinterpreted across a wraparound epoch.
  --
  -- Only the binding event carries it, and the executor writes exactly one
  -- binding per attempt; the evaluator refuses (fails closed) on zero,
  -- duplicate, or cross-attempt reused bindings. Every mode that has no
  -- single migration transaction to bind (legacy-verbatim's self-committing
  -- payload, nontransactional, batched) therefore has no rollback proof and
  -- can only be cleared by an operator resolution — deliberately fail
  -- closed rather than trusting a label.
  -- xact_id, attempt_token_sha256, mr_xact_ck and mr_attempt_token_ck are all
  -- added by control-proof-path.sql, the single definition shared with the
  -- upgrade path, so a fresh table and an upgraded one cannot differ.
  --
  -- CRITICAL 2: the attempt's single-use claim token, as sha256(token). The
  -- 256-bit token itself is generated by the executor, written here only as
  -- this digest, and never stored anywhere readable — so possessing SELECT on
  -- this table (which the execution role has, to evaluate history) does not
  -- let anyone produce the token. claim_transaction and
  -- record_transaction_binding both demand it, which is what stops an
  -- unrelated process — even one holding the execution role's own
  -- credentials — from binding a transaction to somebody else's attempt.
  --
  -- Carried by the `started` row and by nothing else: it identifies the
  -- attempt, not an event.
  unique (run_id, event_sequence),
  constraint mr_id_ck check (migration_id ~ '^[0-9]{4}$'),
  constraint mr_sequence_ck check (event_sequence > 0),
  constraint mr_type_ck check (event_type in (
    'started',
    'heartbeat',
    'transaction_rolled_back',
    'operation_completed',
    'execution_failed',
    'applied_committed',
    'verification_failed',
    'succeeded',
    'stale_reclaimed'
  )),
  constraint mr_heartbeat_ck check (
    heartbeat_deadline is null or event_type in ('started', 'heartbeat')
  ),
  constraint mr_statement_ck check (statement_ordinal is null or statement_ordinal > 0),
  constraint mr_runner_ck check (
    runner_id is null or runner_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  constraint mr_source_sha_ck check (
    source_git_sha is null or source_git_sha ~ '^[0-9a-f]{7,64}$'
  ),
  constraint mr_image_digest_ck check (
    executor_image_digest is null or executor_image_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint mr_sqlstate_ck check (sqlstate is null or sqlstate ~ '^[0-9A-Z]{5}$'),
  constraint mr_error_class_ck check (
    error_class is null or error_class ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  -- The body below is kept byte-identical (modulo indentation — see
  -- db/control/test-check-clause-parity.sh) to the ALTER TABLE ... ADD
  -- CONSTRAINT body in db/control/control-schema-upgrade.sql, so a fresh
  -- install and an upgraded install always produce the same stored
  -- constraint (PostgreSQL deparses a reparsed AND-chain differently
  -- depending on how it was originally parsed, even when semantically
  -- identical, so the two DDL statements must share literal source text).
  constraint mr_metadata_ck check (
    -- mr_metadata_ck-body: begin
    jsonb_typeof(metadata) = 'object'
    and metadata - array[
      'duration_ms',
      'elapsed_ms',
      'rows_affected',
      'statement_count',
      'batch_number',
      'retry_count',
      'operation_category',
      'execution_mode',
      'migration_filename',
      'migration_ordinal',
      'verification',
      'reclaim_reason',
      'checksum_sha256',
      'resolved_event_id',
      'resolved_run_id',
      'resolved_runner_id',
      'resolved_checksum_sha256'
    ]::text[] = '{}'::jsonb
    and (
      not (metadata ? 'duration_ms')
      or case when jsonb_typeof(metadata -> 'duration_ms') = 'number' then
        (metadata ->> 'duration_ms')::numeric between 0 and 9007199254740991
        and (metadata ->> 'duration_ms')::numeric = trunc((metadata ->> 'duration_ms')::numeric)
      else false end
    )
    and (
      not (metadata ? 'elapsed_ms')
      or case when jsonb_typeof(metadata -> 'elapsed_ms') = 'number' then
        (metadata ->> 'elapsed_ms')::numeric between 0 and 9007199254740991
        and (metadata ->> 'elapsed_ms')::numeric = trunc((metadata ->> 'elapsed_ms')::numeric)
      else false end
    )
    and (
      not (metadata ? 'rows_affected')
      or case when jsonb_typeof(metadata -> 'rows_affected') = 'number' then
        (metadata ->> 'rows_affected')::numeric between 0 and 9007199254740991
        and (metadata ->> 'rows_affected')::numeric = trunc((metadata ->> 'rows_affected')::numeric)
      else false end
    )
    and (
      not (metadata ? 'statement_count')
      or case when jsonb_typeof(metadata -> 'statement_count') = 'number' then
        (metadata ->> 'statement_count')::numeric between 0 and 9007199254740991
        and (metadata ->> 'statement_count')::numeric = trunc((metadata ->> 'statement_count')::numeric)
      else false end
    )
    and (
      not (metadata ? 'batch_number')
      or case when jsonb_typeof(metadata -> 'batch_number') = 'number' then
        (metadata ->> 'batch_number')::numeric between 0 and 9007199254740991
        and (metadata ->> 'batch_number')::numeric = trunc((metadata ->> 'batch_number')::numeric)
      else false end
    )
    and (
      not (metadata ? 'retry_count')
      or case when jsonb_typeof(metadata -> 'retry_count') = 'number' then
        (metadata ->> 'retry_count')::numeric between 0 and 9007199254740991
        and (metadata ->> 'retry_count')::numeric = trunc((metadata ->> 'retry_count')::numeric)
      else false end
    )
    and (
      not (metadata ? 'operation_category')
      or metadata ->> 'operation_category' in (
        'schema',
        'data-correction',
        'security-policy',
        'function-replacement',
        'index',
        'seed-reference'
      )
    )
    and (
      not (metadata ? 'execution_mode')
      or metadata ->> 'execution_mode' in (
        'legacy-verbatim',
        'transactional',
        'nontransactional',
        'batched'
      )
    )
    and (
      not (metadata ? 'migration_filename')
      or case when jsonb_typeof(metadata -> 'migration_filename') = 'string' then
        metadata ->> 'migration_filename' ~ '^[0-9]{4}_[a-z0-9]+(_[a-z0-9]+)*[.]sql$'
      else false end
    )
    and (
      not (metadata ? 'migration_ordinal')
      or case when jsonb_typeof(metadata -> 'migration_ordinal') = 'number' then
        (metadata ->> 'migration_ordinal')::numeric between 1 and 9007199254740991
        and (metadata ->> 'migration_ordinal')::numeric = trunc((metadata ->> 'migration_ordinal')::numeric)
      else false end
    )
    and (
      not (metadata ? 'verification')
      or metadata ->> 'verification' in ('passed', 'failed')
    )
    and (
      not (metadata ? 'reclaim_reason')
      or metadata ->> 'reclaim_reason' in (
        'heartbeat_expired',
        'connection_lost',
        'operator_approved'
      )
    )
    and (
      not (metadata ? 'checksum_sha256')
      or case when jsonb_typeof(metadata -> 'checksum_sha256') = 'string' then
        metadata ->> 'checksum_sha256' ~ '^[0-9a-f]{64}$'
      else false end
    )
    and (
      not (metadata ? 'resolved_event_id')
      or case when jsonb_typeof(metadata -> 'resolved_event_id') = 'number' then
        (metadata ->> 'resolved_event_id')::numeric between 1 and 9007199254740991
        and (metadata ->> 'resolved_event_id')::numeric = trunc((metadata ->> 'resolved_event_id')::numeric)
      else false end
    )
    and (
      not (metadata ? 'resolved_run_id')
      or case when jsonb_typeof(metadata -> 'resolved_run_id') = 'string' then
        metadata ->> 'resolved_run_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      else false end
    )
    and (
      not (metadata ? 'resolved_runner_id')
      or case when jsonb_typeof(metadata -> 'resolved_runner_id') = 'string' then
        metadata ->> 'resolved_runner_id' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
      else false end
    )
    and (
      not (metadata ? 'resolved_checksum_sha256')
      or case when jsonb_typeof(metadata -> 'resolved_checksum_sha256') = 'string' then
        metadata ->> 'resolved_checksum_sha256' ~ '^[0-9a-f]{64}$'
      else false end
    )
    -- mr_metadata_ck-body: end
  )
);

-- ══════════════════════════════════════════════════════════════════════════
-- CRITICAL 1 / CRITICAL 2: the protected proof path.
--
-- Shared verbatim with db/control/control-schema-upgrade.sql. Keeping it in
-- one file is what guarantees a freshly installed schema and an upgraded one
-- are identical rather than merely intended to be: the Phase 2c review found
-- the proof path present in this file and entirely absent from the upgrade,
-- which left every existing installation unable to upgrade at all.
--
-- `\ir` resolves relative to THIS file, so the include works regardless of
-- the caller's working directory.
-- ══════════════════════════════════════════════════════════════════════════
\ir control-proof-path.sql
revoke execute on function migration_control.record_applied_migration(
  text, character(64), text, text[]
) from public;

create function migration_control.reject_ledger_mutation()
returns trigger
language plpgsql
volatile
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'migration control rows are immutable';
end
$$;

revoke execute on function migration_control.reject_ledger_mutation() from public;

create trigger schema_migrations_reject_mutation
before update or delete on migration_control.schema_migrations
for each row execute function migration_control.reject_ledger_mutation();

create trigger migration_runs_reject_mutation
before update or delete on migration_control.migration_runs
for each row execute function migration_control.reject_ledger_mutation();

-- TRUNCATE does not fire row-level triggers, so the immutable applied set and
-- the insert-only event stream need statement-level protection as well.
create trigger schema_migrations_reject_truncate
before truncate on migration_control.schema_migrations
for each statement execute function migration_control.reject_ledger_mutation();

create trigger migration_runs_reject_truncate
before truncate on migration_control.migration_runs
for each statement execute function migration_control.reject_ledger_mutation();

alter table migration_control.schema_migrations
  enable always trigger schema_migrations_reject_mutation;
alter table migration_control.migration_runs
  enable always trigger migration_runs_reject_mutation;
alter table migration_control.schema_migrations
  enable always trigger schema_migrations_reject_truncate;
alter table migration_control.migration_runs
  enable always trigger migration_runs_reject_truncate;

-- ══════════════════════════════════════════════════════════════════════════
-- CRITICAL 1 / CRITICAL 2: the migration execution role's complete privilege
-- set. Shared verbatim with db/control/control-schema-upgrade.sql so a fresh
-- and an upgraded installation cannot end up with different grants.
-- ══════════════════════════════════════════════════════════════════════════
reset role;

\ir control-grants.sql
-- Give back the temporary owner membership taken above, so no login role is
-- left able to SET ROLE to the proof owner once the install finishes. A
-- membership that already existed is left exactly as it was found.
do $owner_membership_release$
begin
  if current_setting('migration_control.install_took_owner_membership') = 't' then
    execute format('revoke migration_control_owner from %I', current_user);
  end if;
end
$owner_membership_release$;

commit;
