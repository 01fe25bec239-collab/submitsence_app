-- PB-10 Step 3 control-schema upgrade.
--
-- Idempotent companion to control-schema.sql. Where control-schema.sql only
-- installs onto a bare database (and fails closed with 42P06 on an existing
-- schema), this file brings an existing migration_control installation's
-- mr_metadata_ck constraint up to the current metadata contract without
-- dropping the schema, either ledger table, or any row.
--
-- Never invoked directly by operators; use
-- db/control/install-or-upgrade-control-schema.sh, which supplies the two
-- required psql variables (below) from the pinned fixtures and picks
-- between this file and control-schema.sql based on whether
-- migration_control already exists.
--
-- Required psql variables (pass via -v, exact byte content of the fixtures):
--   previous_metadata_ck_def  db/control/fixtures/mr_metadata_ck.previous.def
--   current_metadata_ck_def   db/control/fixtures/mr_metadata_ck.current.def
--
-- The live mr_metadata_ck definition, read with
-- pg_catalog.pg_get_constraintdef(oid, false), must equal one of these two
-- pinned strings exactly (normalized, single-argument-form deparse; no
-- substring or partial match). Anything else — unknown, malformed,
-- unrelated, or merely substring-compatible — fails closed inside the same
-- transaction, changing neither the constraint nor any row.
--
-- Note: psql variable interpolation (:name / :'name') does not reach inside
-- $$-quoted PL/pgSQL bodies, so the exact-match comparison and the
-- constraint replacement below are deliberately plain top-level SQL plus
-- psql \gset/\if, not a do $$ ... $$ block. The existence guards that need
-- no variables stay in do $$ ... $$ blocks.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v previous_metadata_ck_def="$(cat db/control/fixtures/mr_metadata_ck.previous.def)" \
--     -v current_metadata_ck_def="$(cat db/control/fixtures/mr_metadata_ck.current.def)" \
--     -f db/control/control-schema-upgrade.sql

begin;

-- Transaction-local and set before any lookup below. The classic
-- search_path-spoofing vector (CVE-2018-1058) is an ambient search_path —
-- role default, prior session state, or a misconfigured caller — that
-- lists an attacker-writable schema ahead of pg_catalog, so an unqualified
-- call to a catalog function resolves to the attacker's function instead.
-- (pg_temp is not that vector for functions specifically: PostgreSQL only
-- gives the temporary-object schema implicit search priority for
-- relations, not functions.) Every catalog reference in this file is
-- pg_catalog-qualified regardless, so it does not depend on this setting to
-- resolve correctly; it is set anyway as defense in depth, and so the
-- constraint body created below binds its own unqualified built-ins
-- (jsonb_typeof, trunc, etc.) to pg_catalog at creation time even if a
-- future edit here ever adds an unqualified catalog call by mistake.
set local search_path = pg_catalog, pg_temp;

-- Fail closed rather than guess at an unrecognized installation. A missing
-- schema means control-schema.sql (fresh install) has never run here; this
-- script only ever upgrades an existing installation. No psql variables are
-- referenced here, so this can safely live inside do $$ ... $$.
do $$
begin
  if pg_catalog.to_regnamespace('migration_control') is null then
    raise exception using
      errcode = '3F000',
      message = 'migration_control does not exist; run control-schema.sql for a fresh install before upgrading';
  end if;

  if pg_catalog.to_regclass('migration_control.schema_migrations') is null
     or pg_catalog.to_regclass('migration_control.migration_runs') is null then
    raise exception using
      errcode = '42P01',
      message = 'migration_control is missing an expected permanent ledger table; refusing to guess at an unrecognized schema shape';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint con
     where con.conrelid = 'migration_control.migration_runs'::regclass
       and con.conname = 'mr_metadata_ck'
  ) then
    raise exception using
      errcode = '42704',
      message = 'migration_control.migration_runs is missing mr_metadata_ck; refusing to guess at an unrecognized schema shape';
  end if;
end
$$;

select pg_catalog.pg_get_constraintdef(con.oid, false) as current_definition
  from pg_catalog.pg_constraint con
 where con.conrelid = 'migration_control.migration_runs'::regclass
   and con.conname = 'mr_metadata_ck'
\gset

-- Exact, normalized (single-line deparse) string equality only — never a
-- substring or partial match. current_definition, previous_metadata_ck_def,
-- and current_metadata_ck_def are all psql variables at this point, so
-- interpolation works here even though it would not inside a $$ body.
select
  (:'current_definition' = :'current_metadata_ck_def') as is_current,
  (:'current_definition' = :'previous_metadata_ck_def') as is_previous
\gset upgrade_

\if :upgrade_is_current
  -- Already upgraded (or freshly installed at the current contract).
  -- Nothing to do; reruns of this script must remain no-ops.
\elif :upgrade_is_previous
  -- Single ALTER TABLE statement, both actions committing atomically, so no
  -- session (including this one) ever observes mr_metadata_ck absent, and
  -- no window exists where the metadata contract is unintentionally
  -- unrestricted.
  --
  -- This CHECK clause is deliberately the same literal SQL text as
  -- mr_metadata_ck in control-schema.sql's CREATE TABLE, not the
  -- pg_get_constraintdef-deparsed pinned fixture: PostgreSQL's deparser
  -- represents an AND-chain built from a fresh parse of "BETWEEN"/"AND"
  -- source text differently (more nested) than the same chain re-parsed
  -- from its own already-expanded deparse output (flatter), even though
  -- both are the exact same constraint semantically and reject the exact
  -- same rows. Reusing the original literal text here, instead of
  -- resubmitting pg_get_constraintdef's output, means a fresh install and
  -- an upgrade always produce byte-identical stored constraints, so
  -- upgrading twice — or upgrading a database that was actually a fresh
  -- install — both take the no-op branch above.
  -- db/control/test-check-clause-parity.sh enforces that this text and
  -- control-schema.sql's stay identical.
  alter table migration_control.migration_runs
    drop constraint mr_metadata_ck,
    add constraint mr_metadata_ck check (
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
    );
\else
  -- Neither exact pinned definition: unknown, malformed, substring-
  -- matching, unrelated, or partially compatible. Fail closed without
  -- touching the constraint or any row.
  do $$
  begin
    raise exception using
      errcode = '55000',
      message = 'migration_control.migration_runs.mr_metadata_ck does not match the pinned previous or current PB-10 definition; refusing to guess at an unrecognized constraint';
  end
  $$;
\endif

commit;
