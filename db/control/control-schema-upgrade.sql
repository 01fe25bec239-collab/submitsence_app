-- PB-10 Step 3 control-schema upgrade.
--
-- Idempotent companion to control-schema.sql. Where control-schema.sql only
-- installs onto a bare database (and fails closed with 42P06 on an existing
-- schema), this file brings an existing migration_control installation up to
-- the current contract — including the PB-10 Step 3 Phase 2c role separation
-- and protected commit-proof path — without dropping the schema, either
-- ledger table, or any row.
--
-- ══════════════════════════════════════════════════════════════════════════
-- What this file must do, and why it previously did not.
--
-- The Phase 2c review added the whole proof path (the owner role, proof_key,
-- the four SECURITY DEFINER functions, commit_proof, xact_id,
-- attempt_token_sha256, the partial unique indexes and the entire privilege
-- remodel) to control-schema.sql alone. This file still only widened one
-- CHECK constraint. The consequences were concrete, not theoretical:
--
--   * an existing installation had no upgrade path to the new schema at all;
--   * and because its mr_metadata_ck sat at the intervening Phase 2b
--     definition, which was neither pinned fixture, even the constraint
--     widening failed closed.
--
-- Both are fixed here. The proof-path DDL is no longer restated: it lives in
-- db/control/control-proof-path.sql, which control-schema.sql includes too,
-- so a fresh schema and an upgraded schema cannot diverge again. The
-- recognised-definition set now spans every shipped generation.
--
-- The ownership transfer below is the part that cannot be skipped. A
-- pre-Phase-2c installation is owned by whatever role installed it — very
-- often the migration runner itself — and under that model no proof is
-- unforgeable, because a table owner can INSERT any row, DROP any trigger and
-- REPLACE any function. Creating the proof functions without moving ownership
-- would produce a schema that looks upgraded and protects nothing.
-- ══════════════════════════════════════════════════════════════════════════
--
-- Never invoked directly by operators; use
-- db/control/install-or-upgrade-control-schema.sh, which supplies the
-- required psql variables from the pinned fixtures and picks between this
-- file and control-schema.sql based on whether migration_control exists.
--
-- Required psql variables (pass via -v):
--   migration_execution_role  the role the migration runner logs in as
--   previous_metadata_ck_def  db/control/fixtures/mr_metadata_ck.previous.def
--   phase2b_metadata_ck_def   db/control/fixtures/mr_metadata_ck.phase2b.def
--   current_metadata_ck_def   db/control/fixtures/mr_metadata_ck.current.def
--
-- The live mr_metadata_ck definition, read with
-- pg_catalog.pg_get_constraintdef(oid, false), must equal one of those three
-- pinned strings exactly (normalized, single-argument-form deparse; no
-- substring or partial match). Anything else — unknown, malformed,
-- unrelated, or merely substring-compatible — fails closed inside the same
-- transaction, changing neither the constraint nor any row.
--
-- Note: psql variable interpolation (:name / :'name') does not reach inside
-- $$-quoted PL/pgSQL bodies, so the exact-match comparison and the constraint
-- replacement below are deliberately plain top-level SQL plus psql \gset/\if.
-- Everything needing the role name inside a body reads it from a
-- transaction-local GUC set at top level instead.

-- See the identical guard in control-schema.sql: `\quit 1` warns and exits 0
-- on every supported psql, so the refusal has to be a server-side error that
-- ON_ERROR_STOP turns into a non-zero exit.
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

-- Transaction-local and set before any lookup below. The classic
-- search_path-spoofing vector (CVE-2018-1058) is an ambient search_path —
-- role default, prior session state, or a misconfigured caller — that lists
-- an attacker-writable schema ahead of pg_catalog, so an unqualified call to
-- a catalog function resolves to the attacker's function instead. Every
-- catalog reference in this file is pg_catalog-qualified regardless, so it
-- does not depend on this setting to resolve correctly; it is set anyway as
-- defense in depth, and so any constraint body created below binds its own
-- unqualified built-ins to pg_catalog at creation time.
set local search_path = pg_catalog, pg_temp;

select set_config('migration_control.install_execution_role', :'migration_execution_role', true);

-- Fail closed rather than guess at an unrecognized installation. A missing
-- schema means control-schema.sql (fresh install) has never run here; this
-- script only ever upgrades an existing installation.
--
-- Only pg_namespace is read here, deliberately: to_regclass on a schema this
-- role has no USAGE on raises 42501, and on a pre-Phase-2c installation the
-- schema is owned by somebody else. The table-shape checks therefore move
-- below, after the membership that grants access.
do $schema_guard$
begin
  if not exists (select 1 from pg_catalog.pg_namespace where nspname = 'migration_control') then
    raise exception using
      errcode = '3F000',
      message = 'migration_control does not exist; run control-schema.sql for a fresh install before upgrading';
  end if;
end
$schema_guard$;

-- The same ownership preconditions the fresh install enforces. An upgrade run
-- by the migration execution role would leave that role able to reach the
-- owner it just created, reinstating exactly the forgery this separation
-- exists to prevent — so it is refused here as well as there.
do $install_guard$
declare
  execution_role constant text := current_setting('migration_control.install_execution_role');
begin
  if pg_catalog.to_regrole(execution_role) is null then
    raise exception using
      errcode = '42704',
      message = 'migration_execution_role does not exist; create the migration runner login role before upgrading the control schema';
  end if;
  if execution_role = current_user::text then
    raise exception using
      errcode = '42501',
      message = 'the control schema must not be upgraded by the migration execution role; run as a separate administrative role (see db/README.md)';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = execution_role and rolsuper) then
    raise exception using
      errcode = '42501',
      message = 'the migration execution role must not be a superuser; a superuser bypasses every privilege this schema relies on';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = current_user::text and (rolsuper or rolcreaterole)) then
    raise exception using
      errcode = '42501',
      message = 'upgrading the control schema requires CREATE ROLE; run it as an administrative role';
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

do $owner_create$
begin
  execute format('grant create on database %I to migration_control_owner', current_database());
end
$owner_create$;

-- SET ROLE requires membership with the SET option; a non-superuser
-- administrative installer does not get it from CREATEROLE alone. Taken here
-- and given back before COMMIT (see the release block at the end).
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

-- ══════════════════════════════════════════════════════════════════════════
-- Access to the *existing* owner.
--
-- A pre-Phase-2c installation is owned by whichever role installed it, very
-- often the migration runner. Reading its tables, and reassigning them below,
-- both require acting with that role's rights — so this upgrade must be run
-- either by a superuser or by a role that can administer the current owner.
-- Neither CREATEROLE by itself nor ownership of the database is sufficient:
-- PostgreSQL 16+ lets a CREATEROLE role administer only the roles it created.
--
-- This is a one-time privileged operation, and it is the honest precondition
-- for taking proof objects away from a role that currently owns them. It is
-- checked here, before anything is modified, and reported with the exact
-- remedy rather than surfacing later as a bare "permission denied".
select set_config(
  'migration_control.upgrade_prior_owner',
  (select pg_catalog.pg_get_userbyid(nspowner) from pg_catalog.pg_namespace
    where nspname = 'migration_control'),
  true);

select set_config(
  'migration_control.upgrade_took_prior_membership',
  case
    when current_setting('migration_control.upgrade_prior_owner') = current_user::text then 'f'
    when pg_catalog.pg_has_role(current_user, current_setting('migration_control.upgrade_prior_owner'), 'USAGE') then 'f'
    else 't'
  end,
  true);

do $prior_owner_membership$
declare
  prior_owner constant text := current_setting('migration_control.upgrade_prior_owner');
begin
  if current_setting('migration_control.upgrade_took_prior_membership') = 't' then
    begin
      execute format('grant %I to %I', prior_owner, current_user);
    exception when insufficient_privilege then
      raise exception using
        errcode = '42501',
        message = format(
          'migration_control is owned by %I and this role cannot administer it, so the ownership transfer this upgrade performs is impossible',
          prior_owner),
        hint = format(
          'run the upgrade as a superuser, or have one run: GRANT %I TO %I;',
          prior_owner, current_user);
    end;
  end if;
end
$prior_owner_membership$;

-- Now that access to the existing owner is established, the table-shape
-- guards can run.
do $shape_guard_tables$
begin
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
$shape_guard_tables$;

-- ══════════════════════════════════════════════════════════════════════════
-- Ownership transfer. This is the load-bearing half of the upgrade.
--
-- A pre-Phase-2c installation is owned by whoever installed it. Moving the
-- schema, both ledger tables, the sequence and every function to
-- migration_control_owner is what makes the execution role an ordinary,
-- privilege-limited caller instead of an owner who can rewrite anything.
--
-- ALTER ... OWNER TO requires membership in the *target* role, which the
-- block above just ensured, and ownership of (or membership in the owner of)
-- the object, which holds for the role that installed it and for a superuser.
-- Anything else raises 42501 and the whole upgrade rolls back.
--
-- ── PB-10 Step 3 Phase 2c final review, HIGH: the transfer order is explicit
-- ── and dependency-safe, never whatever order the catalog happens to return.
--
-- The defect this replaces: a single loop over pg_class with relkind in
-- ('r','p','S') and no ORDER BY. PostgreSQL guarantees nothing about the order
-- of an unordered scan, and one of these objects has a hard dependency-ordering
-- rule: migration_runs.event_id is a `bigserial`, so
-- migration_runs_event_id_seq is an OWNED BY sequence, and PostgreSQL rejects
-- `ALTER SEQUENCE ... OWNER TO` with "sequence must have the same owner as
-- table it is linked to" whenever the sequence would move before its table. A
-- recognized Phase 2b installation therefore upgraded or failed depending on
-- physical catalog layout — a heap page order, a VACUUM, or a syscache hit.
--
-- The dependency-safe order, derived from this repository's actual objects:
--
--   1. schema        — the container. Moved first so no later step depends on
--                      an owner the schema itself contradicts.
--   2. tables        — including both ledgers. ALTER TABLE ... OWNER TO
--                      *cascades to the table's owned sequences*, which is
--                      precisely why they must precede step 3.
--   3. sequences     — any sequence not already carried by step 2 (a free
--                      standing one, or a linked one whose table was already
--                      owned). Ordered, and by this point always a no-op for
--                      migration_runs_event_id_seq.
--   4. functions     — no ownership dependency on tables or on one another
--                      (a trigger function's owner is independent of the
--                      triggering table's), but ordered by identity anyway so
--                      a failure is reproducible rather than layout-dependent.
--                      Trigger functions and their triggers are unaffected by
--                      an owner change: pg_trigger references the function by
--                      oid, so reject_ledger_mutation's four triggers stay
--                      valid throughout.
--
-- Each phase is ORDER BY'd on a stable key, so re-running this upgrade against
-- the same installation performs the same statements in the same sequence. The
-- whole thing is inside this file's single transaction, so a failure at any
-- point rolls back every ownership change made here and leaves no partially
-- transferred installation.
-- ══════════════════════════════════════════════════════════════════════════
do $reassign$
declare
  target record;
  owner_oid constant oid := pg_catalog.to_regrole('migration_control_owner')::oid;
begin
  -- Phase 1: the schema.
  if (select nspowner from pg_catalog.pg_namespace where nspname = 'migration_control')
     is distinct from owner_oid then
    alter schema migration_control owner to migration_control_owner;
  end if;

  -- Phase 2: tables and partitioned tables, before any sequence.
  for target in
    select c.oid::regclass::text as ident
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'migration_control'
       and c.relkind in ('r', 'p')
       and c.relowner is distinct from owner_oid
     order by c.relname
  loop
    execute format('alter table %s owner to migration_control_owner', target.ident);
  end loop;

  -- Phase 3: sequences. Re-read after phase 2, so a sequence ALTER TABLE
  -- already carried is simply absent here rather than altered a second time.
  for target in
    select c.oid::regclass::text as ident
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'migration_control'
       and c.relkind = 'S'
       and c.relowner is distinct from owner_oid
     order by c.relname
  loop
    execute format('alter sequence %s owner to migration_control_owner', target.ident);
  end loop;

  -- Phase 4: functions.
  for target in
    select p.oid::regprocedure::text as ident
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'migration_control'
       and p.proowner is distinct from owner_oid
     order by p.oid::regprocedure::text
  loop
    execute format('alter function %s owner to migration_control_owner', target.ident);
  end loop;

  -- Fail closed rather than proceed on a partial transfer: after the four
  -- phases nothing in this schema may still be owned by anyone else.
  if exists (
    select 1 from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'migration_control' and c.relkind in ('r', 'p', 'S')
       and c.relowner is distinct from owner_oid
    union all
    select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'migration_control' and p.proowner is distinct from owner_oid
    union all
    select 1 from pg_catalog.pg_namespace
     where nspname = 'migration_control' and nspowner is distinct from owner_oid
  ) then
    raise exception using
      errcode = '55000',
      message = 'the migration_control ownership transfer did not complete; refusing to leave a partially transferred installation';
  end if;
end
$reassign$;

-- Everything below is created while acting as the owner, so no object is ever
-- owned, even momentarily, by the installing role.
set local role migration_control_owner;

-- The proof path itself: one definition, shared verbatim with
-- control-schema.sql. `\ir` resolves relative to THIS file, so the include
-- works regardless of the caller's working directory.
\ir control-proof-path.sql

reset role;

-- ══════════════════════════════════════════════════════════════════════════
-- The execution role's complete privilege set, rebuilt from zero.
--
-- REVOKE ALL first, deliberately: a pre-Phase-2c installation granted the
-- runner far more than this (frequently ownership itself, and at minimum
-- INSERT on schema_migrations), and an upgrade that only added grants would
-- leave every one of those in place. The GRANTs that follow are byte-for-byte
-- the fresh installer's, so the two paths produce the same privilege set.
-- ══════════════════════════════════════════════════════════════════════════
\ir control-grants.sql

select pg_catalog.pg_get_constraintdef(con.oid, false) as current_definition
  from pg_catalog.pg_constraint con
 where con.conrelid = 'migration_control.migration_runs'::regclass
   and con.conname = 'mr_metadata_ck'
\gset

-- Exact, normalized (single-line deparse) string equality only — never a
-- substring or partial match. current_definition, previous_metadata_ck_def,
-- and current_metadata_ck_def are all psql variables at this point, so
-- interpolation works here even though it would not inside a $$ body.
-- Three recognised generations, not two. The Phase 2c review found the
-- upgrade accepting only the oldest ("previous") and the newest ("current")
-- definition — so a database sitting at the intervening Phase 2b definition,
-- which is what every real deployment was actually running, matched neither
-- and fell straight into the fail-closed branch. That is the concrete reason
-- existing installations could not upgrade. Any recognised historical
-- generation now upgrades to current; anything unrecognised still fails
-- closed, on exact normalized string equality and never a substring match.
select
  (:'current_definition' = :'current_metadata_ck_def') as is_current,
  (:'current_definition' = :'previous_metadata_ck_def'
   or :'current_definition' = :'phase2b_metadata_ck_def') as is_upgradable
\gset upgrade_

\if :upgrade_is_current
  -- Already upgraded (or freshly installed at the current contract).
  -- Nothing to do; reruns of this script must remain no-ops.
\elif :upgrade_is_upgradable
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
  -- Acting as the proof owner: after the ownership transfer above, the
  -- installing role is no longer the table owner and cannot alter it.
  set local role migration_control_owner;
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
    );
  reset role;
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

-- Give back the temporary owner membership taken above, so no login role is
-- left able to SET ROLE to the proof owner once the upgrade finishes.
do $owner_membership_release$
begin
  if current_setting('migration_control.install_took_owner_membership') = 't' then
    execute format('revoke migration_control_owner from %I', current_user);
  end if;
  if current_setting('migration_control.upgrade_took_prior_membership') = 't' then
    execute format('revoke %I from %I',
      current_setting('migration_control.upgrade_prior_owner'), current_user);
  end if;
end
$owner_membership_release$;

commit;
