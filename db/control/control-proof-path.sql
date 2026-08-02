-- ══════════════════════════════════════════════════════════════════════════
-- PB-10 Step 3 Phase 2c: the protected commit-proof path.
--
-- Included by BOTH db/control/control-schema.sql (fresh install) and
-- db/control/control-schema-upgrade.sql (existing install), with `\ir`, so
-- there is exactly one definition of the proof objects and a fresh schema and
-- an upgraded schema cannot drift apart. That drift is not hypothetical: this
-- file exists because the proof path was added to the fresh installer only,
-- leaving every existing installation unable to upgrade at all.
--
-- Every statement here is idempotent, because the upgrade path re-runs it on
-- an installation that may already have some or all of these objects, and
-- must be safe across repeated runs.
--
-- Preconditions, guaranteed by both callers before including this file:
--   * migration_control exists, with schema_migrations and migration_runs;
--   * the session is acting as migration_control_owner (SET ROLE), so every
--     object created here is owned by the proof owner and never by the
--     installing role;
--   * a single enclosing transaction is open.
-- ══════════════════════════════════════════════════════════════════════════

-- ── columns ───────────────────────────────────────────────────────────────
-- Additive and metadata-only: a nullable ADD COLUMN with no default rewrites
-- no rows and reads none, so this is safe on a large historical ledger.
alter table migration_control.migration_runs
  add column if not exists xact_id xid8;
alter table migration_control.migration_runs
  add column if not exists attempt_token_sha256 bytea;
alter table migration_control.schema_migrations
  add column if not exists commit_proof text;

-- Backfill for an upgraded installation, and a no-op on a fresh empty table.
-- The classification mirrors exactly what record_applied_migration would have
-- recorded for each historical row, so a fresh and an upgraded ledger describe
-- the same facts the same way:
--
--   baselined rows    -> 'baseline'. Recorded history with no byte evidence
--                        and no outcome evidence; they never claimed either.
--   transactional     -> 'transaction_atomic'. The pre-Phase-2c executor
--                        wrote the applied row on the execution connection
--                        inside the migration transaction, so the row really
--                        was atomic with that COMMIT. What Phase 2c added is
--                        unforgeability, not atomicity, and rewriting history
--                        to claim otherwise would be false.
--   every other mode  -> 'post_hoc_verified'. No single migration transaction
--                        existed, so no atomic claim was ever available.
--
-- The mutation-rejection triggers make the ledger immutable, including to the
-- owner, so they are momentarily disabled for this one backfill and restored
-- immediately. Both happen inside the caller's single transaction, so no other
-- session ever observes the ledger unprotected, and a failure anywhere in this
-- file rolls the whole thing back including the trigger state.
do $backfill$
begin
  if exists (select 1 from migration_control.schema_migrations where commit_proof is null) then
    alter table migration_control.schema_migrations disable trigger schema_migrations_reject_mutation;
    update migration_control.schema_migrations
       set commit_proof = case
             when baselined then 'baseline'
             when execution_mode = 'transactional' then 'transaction_atomic'
             else 'post_hoc_verified'
           end
     where commit_proof is null;
    alter table migration_control.schema_migrations enable always trigger schema_migrations_reject_mutation;
  end if;
end
$backfill$;

alter table migration_control.schema_migrations
  alter column commit_proof set not null;

-- ── column constraints ────────────────────────────────────────────────────
-- ADD CONSTRAINT has no IF NOT EXISTS, so each is guarded by name. The
-- constraint bodies are the single source of truth for both install paths.
do $constraints$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'migration_control.migration_runs'::regclass
                    and conname = 'mr_xact_ck') then
    alter table migration_control.migration_runs
      add constraint mr_xact_ck check (xact_id is null or event_type = 'heartbeat');
  end if;

  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'migration_control.migration_runs'::regclass
                    and conname = 'mr_attempt_token_ck') then
    alter table migration_control.migration_runs
      add constraint mr_attempt_token_ck check (
        attempt_token_sha256 is null
        or (event_type = 'started' and octet_length(attempt_token_sha256) = 32)
      );
  end if;

  -- PB-10 Step 3 Phase 2c final review, CRITICAL: the shape of a progress
  -- marker. A marker is a `heartbeat` row carrying statement_ordinal 1 or 2 and
  -- no transaction binding; nothing else in the ledger may look like one.
  --
  -- Written to validate against every shipped generation: historical rows put
  -- statement_ordinal = 1 on transaction_rolled_back/execution_failed rows and
  -- never on a heartbeat, so this constraint adds no retroactive claim about
  -- them, and ADD CONSTRAINT's validation scan passes on an existing ledger.
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'migration_control.migration_runs'::regclass
                    and conname = 'mr_marker_ck') then
    alter table migration_control.migration_runs
      add constraint mr_marker_ck check (
        event_type <> 'heartbeat'
        or statement_ordinal is null
        or (statement_ordinal in (1, 2) and xact_id is null)
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'migration_control.schema_migrations'::regclass
                    and conname = 'sm_commit_proof_ck') then
    alter table migration_control.schema_migrations
      add constraint sm_commit_proof_ck check (
        commit_proof in ('transaction_atomic', 'post_hoc_verified', 'baseline')
      );
  end if;

  -- Only a mode that genuinely owns one migration transaction can claim
  -- atomic proof, and a baselined row can claim none.
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'migration_control.schema_migrations'::regclass
                    and conname = 'sm_commit_proof_mode_ck') then
    alter table migration_control.schema_migrations
      add constraint sm_commit_proof_mode_ck check (
        (commit_proof = 'transaction_atomic' and not baselined and execution_mode = 'transactional')
        or (commit_proof = 'post_hoc_verified' and not baselined
            and execution_mode in ('nontransactional', 'batched', 'legacy-verbatim'))
        or (commit_proof = 'baseline' and baselined)
      );
  end if;
end
$constraints$;

-- ══════════════════════════════════════════════════════════════════════════
-- CRITICAL 1 / CRITICAL 2: the protected proof path.
-- ══════════════════════════════════════════════════════════════════════════

-- One binding per attempt, one attempt per transaction, one token per
-- attempt — enforced by PostgreSQL, not by the reader. A reused or duplicated
-- binding is impossible rather than merely detected after the fact.
create unique index if not exists mr_one_binding_per_attempt
  on migration_control.migration_runs (run_id, migration_id)
  where xact_id is not null;
create unique index if not exists mr_one_attempt_per_xact
  on migration_control.migration_runs (xact_id)
  where xact_id is not null;
create unique index if not exists mr_one_token_per_attempt
  on migration_control.migration_runs (attempt_token_sha256)
  where attempt_token_sha256 is not null;

-- One marker of each ordinal per attempt. A duplicate, replacement or
-- retrospectively re-inserted marker is a unique violation rather than a second
-- opinion the evaluator has to adjudicate.
create unique index if not exists mr_one_marker_per_attempt
  on migration_control.migration_runs (run_id, migration_id, statement_ordinal)
  where event_type = 'heartbeat' and statement_ordinal is not null;

-- The key behind the binding receipt below. Owned by migration_control_owner
-- and granted to nobody: the execution role cannot SELECT it, so it cannot
-- compute a receipt for any (attempt, transaction) pair the protected
-- function did not itself produce. gen_random_uuid() is PostgreSQL's own
-- strong RNG (pg_strong_random), so no extension is required.
create table if not exists migration_control.proof_key (
  singleton boolean primary key,
  key bytea not null,
  constraint pk_singleton_ck check (singleton),
  constraint pk_key_ck check (octet_length(key) = 32)
);
-- ON CONFLICT DO NOTHING, not a fresh key: rotating the key on every upgrade
-- would invalidate nothing durable (receipts are transient values, never
-- stored) but would silently break an execution already in flight against
-- this database during the upgrade.
insert into migration_control.proof_key (singleton, key)
values (true, sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')))
on conflict (singleton) do nothing;

-- Resolves a claim token to the one `started` row it was issued for, or
-- raises. Never returns a token, a digest or the key.
create or replace function migration_control.attempt_for_token(attempt_token text)
returns migration_control.migration_runs
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  started migration_control.migration_runs;
begin
  if attempt_token is null or attempt_token !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '42501',
      message = 'migration attempt token is malformed';
  end if;
  select * into started
    from migration_control.migration_runs
   where attempt_token_sha256 = sha256(convert_to(attempt_token, 'UTF8'));
  if not found then
    raise exception using
      errcode = '42501',
      message = 'migration attempt token does not identify a started attempt';
  end if;
  return started;
end
$$;

revoke execute on function migration_control.attempt_for_token(text) from public;

/*
 * CRITICAL 2, half one — authentic ownership.
 *
 * Called on the *execution* connection, from inside the migration's own
 * transaction. It reads pg_current_xact_id() itself: the transaction id is
 * never a parameter, so there is no way for any caller — on any connection,
 * in any process — to name a transaction other than the one it is actually
 * running in. That is the ownership property a control connection inserting
 * an xid value could never establish.
 *
 * It returns '<xid>:<receipt>', where the receipt is a keyed digest over the
 * attempt's token digest and that exact transaction id. The execution role
 * cannot read proof_key, so it cannot manufacture a receipt for any other
 * pair; and it cannot obtain a receipt for somebody else's attempt without
 * that attempt's token, which exists only in the memory of the process that
 * armed it.
 *
 * The receipt is a value, not a row, so it survives ROLLBACK of the very
 * transaction that produced it — which is precisely what makes half two
 * possible.
 */
create or replace function migration_control.claim_transaction(attempt_token text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  started migration_control.migration_runs;
  claimed xid8;
begin
  started := migration_control.attempt_for_token(attempt_token);
  if exists (
    select 1 from migration_control.migration_runs
     where run_id = started.run_id and migration_id = started.migration_id and xact_id is not null
  ) then
    raise exception using
      errcode = '55000',
      message = 'this migration attempt already has a durable transaction binding';
  end if;
  claimed := pg_current_xact_id();
  return claimed::text || ':' || encode(
    sha256(
      (select key from migration_control.proof_key)
      || started.attempt_token_sha256
      || convert_to(claimed::text, 'UTF8')
    ),
    'hex'
  );
end
$$;

revoke execute on function migration_control.claim_transaction(text) from public;

/*
 * CRITICAL 2, half two — pre-execution durability.
 *
 * Called on the *control* connection, in autocommit, after claim_transaction
 * and strictly before any risky migration SQL runs. It verifies the receipt
 * against the key the caller cannot read, then writes the binding event.
 * Because this runs in its own transaction, the binding is durable
 * immediately and survives both COMMIT and ROLLBACK of the transaction it
 * describes.
 *
 * Precise PostgreSQL semantics, stated rather than hand-waved:
 *
 *   Durability — the binding row is written and committed by *this*
 *   transaction, which is not the migration transaction. A row written inside
 *   the migration transaction would be invisible until it committed and would
 *   disappear on rollback, so it could never be evidence of a rollback. That
 *   is why the durable write happens here and not in claim_transaction.
 *
 *   Ownership — a row this transaction writes proves nothing about who owned
 *   the xid, which is exactly the CRITICAL 2 defect. The receipt closes that
 *   gap: it can only have been produced by a call to claim_transaction, that
 *   call read pg_current_xact_id() rather than accepting it, and it did so
 *   while holding this attempt's token. So a verified receipt is proof that
 *   the transaction identified by `xid` really was a transaction that
 *   executed claim_transaction for *this* attempt.
 *
 * The identity columns are copied from the attempt's own `started` row rather
 * than taken from the caller, so a binding event can never carry an identity
 * that contradicts the attempt it binds.
 */
create or replace function migration_control.record_transaction_binding(
  attempt_token text,
  event_sequence integer,
  claim text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  started migration_control.migration_runs;
  claimed xid8;
  receipt text;
begin
  started := migration_control.attempt_for_token(attempt_token);
  if claim is null or claim !~ '^[0-9]{1,20}:[0-9a-f]{64}$' then
    raise exception using
      errcode = '42501',
      message = 'transaction binding claim is malformed';
  end if;
  claimed := split_part(claim, ':', 1)::xid8;
  receipt := split_part(claim, ':', 2);
  if receipt is distinct from encode(
    sha256(
      (select key from migration_control.proof_key)
      || started.attempt_token_sha256
      || convert_to(claimed::text, 'UTF8')
    ),
    'hex'
  ) then
    raise exception using
      errcode = '42501',
      message = 'transaction binding claim is not authentic for this migration attempt';
  end if;
  -- mr_one_binding_per_attempt and mr_one_attempt_per_xact make a duplicate,
  -- replacement or cross-attempt binding a unique violation rather than a
  -- silently accepted second opinion.
  insert into migration_control.migration_runs
    (run_id, migration_id, event_sequence, event_type, runner_id,
     source_git_sha, executor_image_digest, metadata, xact_id)
  values
    (started.run_id, started.migration_id, event_sequence, 'heartbeat', started.runner_id,
     started.source_git_sha, started.executor_image_digest, started.metadata, claimed);
end
$$;

revoke execute on function migration_control.record_transaction_binding(text, integer, text) from public;

/*
 * PB-10 Step 3 Phase 2c final review, CRITICAL — the only writer of an H2
 * progress marker.
 *
 * The defect this replaces: the two markers were ordinary `heartbeat` rows
 * carrying statement_ordinal 1 and 2, and the execution role held column-level
 * INSERT on statement_ordinal. So the role whose replay the markers authorize
 * could manufacture the very evidence that authorized it — one INSERT of a
 * marker-shaped row and a blocked attempt read as SAFE_TO_RETRY. A durable row
 * is not authoritative when the same ordinary role can independently produce
 * it, and correlating its fields only proves the fields correlate.
 *
 * What makes a marker authoritative now:
 *
 *   Provenance — control-grants.sql no longer grants the execution role INSERT
 *   on statement_ordinal at all, so PostgreSQL refuses any direct INSERT that
 *   so much as names the column. A row with a non-null statement_ordinal on a
 *   `heartbeat` can therefore only have been written by this function, which
 *   runs SECURITY DEFINER as migration_control_owner. mr_marker_ck pins the
 *   shape, so no other event type can impersonate one either.
 *
 *   Attempt binding — the caller names an attempt only by presenting that
 *   attempt's claim token, which exists solely in the memory of the process
 *   that armed it (only sha256(token) is stored, and reading the ledger reveals
 *   the digest alone). Every identity column is then copied from the attempt's
 *   own `started` row rather than accepted from the caller, so a marker can
 *   never carry an identity contradicting the attempt it marks, and one
 *   attempt's marker can never be minted for another.
 *
 *   Lifecycle position — enforced here and by mr_one_marker_per_attempt, not by
 *   the reader: marker 1 exists only after the exact `started` row it names
 *   (attempt_for_token resolves that row or raises), marker 2 exists only after
 *   marker 1, and neither can exist twice. Missing, duplicate, reordered or
 *   conflicting marker evidence is impossible to create rather than merely
 *   detected, and the evaluator additionally fails closed on it.
 *
 *   Durability — this is called on the *control* connection in autocommit, so
 *   the marker is on disk before the operation it describes is dispatched. The
 *   caller awaits it and throws on failure, so payload SQL cannot begin when
 *   marker 2 did not persist.
 */
create or replace function migration_control.record_progress_marker(
  attempt_token text,
  event_sequence integer,
  ordinal integer
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  started migration_control.migration_runs;
begin
  started := migration_control.attempt_for_token(attempt_token);
  if ordinal is null or ordinal not in (1, 2) then
    raise exception using
      errcode = '42501',
      message = 'unknown migration progress marker';
  end if;
  -- Ordering the unique index cannot express: the durable-work marker is only
  -- meaningful as "this attempt, already armed, is about to issue payload SQL".
  if ordinal = 2 and not exists (
    select 1 from migration_control.migration_runs
     where run_id = started.run_id and migration_id = started.migration_id
       and event_type = 'heartbeat' and statement_ordinal = 1
  ) then
    raise exception using
      errcode = '55000',
      message = 'the durable-work marker cannot precede the armed marker for this migration attempt';
  end if;
  insert into migration_control.migration_runs
    (run_id, migration_id, event_sequence, event_type, runner_id,
     source_git_sha, executor_image_digest, metadata, statement_ordinal)
  values
    (started.run_id, started.migration_id, event_sequence, 'heartbeat', started.runner_id,
     started.source_git_sha, started.executor_image_digest, started.metadata, ordinal);
end
$$;

revoke execute on function migration_control.record_progress_marker(text, integer, integer) from public;

/*
 * CRITICAL 1 — the only writer of migration_control.schema_migrations.
 *
 * The execution role has no INSERT privilege on that table, so an accepted
 * applied row cannot exist unless this function created it, and this function
 * demands the attempt's token. Every provenance field is copied from the
 * attempt's own `started` row rather than accepted from the caller, so a
 * caller cannot describe a migration other than the one it armed.
 *
 * commit_proof is decided here, never supplied:
 *
 *   transactional  — the attempt's durable binding must exist *and* its
 *                    xact_id must equal pg_current_xact_id() for this very
 *                    call. That can only hold when this call is executing
 *                    inside the exact transaction the binding names, so the
 *                    row is written atomically with that transaction:
 *                    it becomes visible only if that transaction commits, and
 *                    a rollback leaves no proof at all. Recorded as
 *                    'transaction_atomic'.
 *   every other mode — no single migration transaction exists to commit with,
 *                    so no atomic proof is possible and none is claimed. The
 *                    row is recorded as 'post_hoc_verified', which the history
 *                    evaluator never treats as transaction-outcome evidence.
 *
 * This deliberately writes no ledger *event*. In transactional mode the call
 * happens inside the migration transaction, so any event row it wrote would
 * consume a run event_sequence number that a subsequent ROLLBACK would
 * discard — leaving a permanent gap in the run's stream, which the history
 * evaluator correctly treats as malformed, unresolvable history. The
 * `applied_committed` label is appended by the caller afterwards through the
 * ordinary path; it is only a label, and the applied row above is the proof.
 */
create or replace function migration_control.record_applied_migration(
  attempt_token text,
  manifest_checksum_sha256 character(64),
  lifecycle_phase text,
  operation_categories text[]
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  started migration_control.migration_runs;
  bound xid8;
  proof text;
  applied_checksum text;
  filename text;
  migration_ordinal integer;
  execution_mode text;
begin
  started := migration_control.attempt_for_token(attempt_token);
  applied_checksum := started.metadata ->> 'checksum_sha256';
  filename := started.metadata ->> 'migration_filename';
  migration_ordinal := (started.metadata ->> 'migration_ordinal')::integer;
  execution_mode := started.metadata ->> 'execution_mode';
  if applied_checksum is null or filename is null or migration_ordinal is null or execution_mode is null then
    raise exception using
      errcode = '55000',
      message = 'the started attempt does not carry the identity required to record an applied migration';
  end if;

  select xact_id into bound
    from migration_control.migration_runs
   where run_id = started.run_id and migration_id = started.migration_id and xact_id is not null;

  if execution_mode = 'transactional' then
    if bound is null then
      raise exception using
        errcode = '55000',
        message = 'a transactional migration has no durable transaction binding; refusing to record unprovable commit proof';
    end if;
    if bound is distinct from pg_current_xact_id() then
      raise exception using
        errcode = '42501',
        message = 'commit proof must be recorded from inside the exact bound migration transaction';
    end if;
    proof := 'transaction_atomic';
  else
    proof := 'post_hoc_verified';
  end if;

  insert into migration_control.schema_migrations
    (migration_id, ordinal, filename, manifest_checksum_sha256, applied_checksum_sha256,
     lifecycle_phase, operation_categories, execution_mode, applied_at, run_id,
     baselined, source_git_sha, executor_image_digest, commit_proof)
  values
    (started.migration_id, migration_ordinal, filename, manifest_checksum_sha256, applied_checksum,
     lifecycle_phase, operation_categories, execution_mode, now(), started.run_id,
     false, started.source_git_sha, started.executor_image_digest, proof);

  return proof;
end
$$;

