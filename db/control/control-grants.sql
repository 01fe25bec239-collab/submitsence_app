-- ══════════════════════════════════════════════════════════════════════════
-- PB-10 Step 3 Phase 2c: the migration execution role's complete privilege
-- set, and every revoke that bounds it.
--
-- Included by BOTH db/control/control-schema.sql (fresh install) and
-- db/control/control-schema-upgrade.sql (existing install), with `\ir`, so a
-- freshly installed database and an upgraded one end up with byte-identical
-- grants rather than merely similar ones.
--
-- The whole set is additive from a base of zero: the REVOKE ALLs below run
-- first and strip anything a previous generation granted. That matters most
-- on the upgrade path, where a pre-Phase-2c installation typically granted
-- the runner INSERT on schema_migrations — or ownership outright — and an
-- upgrade that only added privileges would silently leave the forgeable model
-- in place.
--
-- There is deliberately no GRANT of INSERT on schema_migrations, no privilege
-- of any kind on proof_key, and no UPDATE/DELETE/TRUNCATE anywhere.
--
-- Preconditions, guaranteed by both callers:
--   * migration_control.install_execution_role is set as a transaction-local
--     GUC (psql interpolation does not reach inside $$-quoted bodies);
--   * the session is NOT acting as migration_control_owner — these are
--     grants the installing role makes on the owner's behalf, and the owner
--     role is NOLOGIN/NOINHERIT;
--   * a single enclosing transaction is open.
-- ══════════════════════════════════════════════════════════════════════════

-- Strip every privilege any earlier generation of this schema handed out,
-- including to the execution role itself, before granting the current set.
do $reset_execution_grants$
declare
  execution_role constant text := quote_ident(current_setting('migration_control.install_execution_role'));
begin
  execute format('revoke all on schema migration_control from %s', execution_role);
  execute format('revoke all on all tables in schema migration_control from %s', execution_role);
  execute format('revoke all on all sequences in schema migration_control from %s', execution_role);
  execute format('revoke all on all functions in schema migration_control from %s', execution_role);
end
$reset_execution_grants$;

revoke all on all tables in schema migration_control from public;
revoke all on all sequences in schema migration_control from public;
revoke all on all functions in schema migration_control from public;

do $grants$
declare
  execution_role constant text := quote_ident(current_setting('migration_control.install_execution_role'));
begin
  execute format('grant usage on schema migration_control to %s', execution_role);

  -- Reading the whole ledger is required to evaluate history. It reveals the
  -- attempt token *digest* only, never a token.
  execute format(
    'grant select on migration_control.schema_migrations, migration_control.migration_runs to %s',
    execution_role);

  -- CRITICAL 2: column-level INSERT, deliberately omitting xact_id. Ordinary
  -- event rows carry no proof (a label is not an outcome — see
  -- backend/src/db/migrate/execute.ts), so the executor writes them directly;
  -- a transaction binding is proof, so supplying xact_id in any INSERT —
  -- even as NULL — is refused by PostgreSQL and can only be produced by
  -- record_transaction_binding. attempt_token_sha256 is writable because the
  -- executor generates the token and only ever stores its digest.
  --
  -- PB-10 Step 3 Phase 2c final review, CRITICAL: statement_ordinal is omitted
  -- for exactly the same reason as xact_id. It is the H2 progress marker, and
  -- a marker is what authorizes SAFE_TO_RETRY — so while this role could write
  -- it directly, the role whose replay the markers authorize could manufacture
  -- the evidence authorizing it. PostgreSQL now refuses any INSERT from this
  -- role that names the column at all, even as NULL, and the only writer is
  -- migration_control.record_progress_marker.
  execute format(
    'grant insert (run_id, migration_id, event_sequence, event_type, occurred_at, runner_id,'
    || ' heartbeat_deadline, source_git_sha, executor_image_digest, sqlstate,'
    || ' error_class, metadata, attempt_token_sha256)'
    || ' on migration_control.migration_runs to %s',
    execution_role);
  execute format(
    'grant usage on sequence migration_control.migration_runs_event_id_seq to %s',
    execution_role);

  -- Exactly four entry points, and nothing else in this schema is callable.
  execute format(
    'grant execute on function migration_control.claim_transaction(text) to %s',
    execution_role);
  execute format(
    'grant execute on function migration_control.record_progress_marker(text, integer, integer) to %s',
    execution_role);
  execute format(
    'grant execute on function migration_control.record_transaction_binding(text, integer, text) to %s',
    execution_role);
  execute format(
    'grant execute on function migration_control.record_applied_migration('
    || 'text, character(64), text, text[]) to %s',
    execution_role);

  -- PostgreSQL's own verdict on a bound transaction. The runner needs it to
  -- clear a rolled-back attempt: without it every uncertain attempt simply
  -- stays blocked, which is safe but requires an operator for every ordinary
  -- failed migration.
  --
  -- On a stock cluster pg_xact_status is already executable — its default ACL
  -- grants EXECUTE to PUBLIC — so the common case takes neither branch below
  -- and no privilege is added. The branches exist for a hardened cluster where
  -- an operator has revoked PUBLIC's EXECUTE: there the GRANT is genuinely
  -- required, and it is a superuser operation, because pg_catalog functions
  -- are owned by the bootstrap superuser and neither CREATEROLE nor ADMIN
  -- conveys anything over them. A non-superuser installer must not silently
  -- produce an installation that looks complete and is not, so it fails closed
  -- naming the exact remedy instead.
  if not pg_catalog.has_function_privilege(
       pg_catalog.to_regrole(current_setting('migration_control.install_execution_role')),
       'pg_catalog.pg_xact_status(xid8)',
       'EXECUTE') then
    if exists (select 1 from pg_catalog.pg_roles where rolname = current_user::text and rolsuper) then
      execute format(
        'grant execute on function pg_catalog.pg_xact_status(xid8) to %s',
        execution_role);
    else
      raise exception using
        errcode = '42501',
        message = 'the migration execution role lacks EXECUTE on pg_catalog.pg_xact_status(xid8) and this installer is not a superuser',
        hint = format(
          'have a superuser run: GRANT EXECUTE ON FUNCTION pg_catalog.pg_xact_status(xid8) TO %s; then re-run this install',
          execution_role);
    end if;
  end if;
end
$grants$;

-- submitsense_app is created by db/migrations/0001_extensions_helpers.sql. The
-- control schema installs on a bare database too, so these revokes are skipped
-- when the runtime role does not exist yet; runner.ts verifies the same
-- properties with to_regrole() and reports them either way.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'submitsense_app') then
    revoke all on schema migration_control from submitsense_app;
    revoke all on all functions in schema migration_control from submitsense_app;
    revoke all on all tables in schema migration_control from submitsense_app;
    revoke all on all sequences in schema migration_control from submitsense_app;
  end if;
end
$$;

