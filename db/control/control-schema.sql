-- PB-10 Step 2 migration control schema.
--
-- Install (disposable or approved target only). The migration image already
-- carries this file at /workspace/db/control/control-schema.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/control/control-schema.sql
--
-- Runs as a single transaction, so re-application fails closed with SQLSTATE
-- 42P06 and changes nothing. See db/README.md for ownership and prerequisites.

begin;

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
      'reclaim_reason'
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
    -- mr_metadata_ck-body: end
  )
);

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

revoke all on all tables in schema migration_control from public;
revoke all on all sequences in schema migration_control from public;

-- submitsense_app is created by db/migrations/0001_extensions_helpers.sql. The
-- control schema installs on a bare database too, so these revokes are skipped
-- when the runtime role does not exist yet; runner.ts verifies the same
-- properties with to_regrole() and reports them either way.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'submitsense_app') then
    revoke all on schema migration_control from submitsense_app;
    revoke execute on function migration_control.reject_ledger_mutation() from submitsense_app;
    revoke execute on function migration_control.canonical_operation_categories(text[]) from submitsense_app;
    revoke all on all tables in schema migration_control from submitsense_app;
    revoke all on all sequences in schema migration_control from submitsense_app;
  end if;
end
$$;

commit;
