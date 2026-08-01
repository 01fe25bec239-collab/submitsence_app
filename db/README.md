# SubmitSense — Database Layer

Canonical PostgreSQL data model for SubmitSense (NATSPEC submittal co-pilot). Persistence layer
only — no application code. Compliance guardrails are enforced **in the schema**, not just in app code.

## Tech decisions (System Contract)

| Item | Decision |
|------|----------|
| Engine | PostgreSQL **17+** (assumed per brief §j) |
| Extensions | `vector` (pgvector ≥ 0.5 for HNSW), `citext`, `pg_trgm` |
| Migration tool | **Plain SQL files** — repo is greenfield, no backend/ORM chosen yet. Zero lock-in; a later backend agent can wrap or baseline these into any ORM. |
| IDs / time | UUID PKs (`gen_random_uuid()`, core in PG13+), `timestamptz` in UTC |
| Storage | S3 object refs only; no binaries in PG (Australian region default `ap-southeast-2`) |
| Retention | **UNKNOWN — made configurable** (soft-delete/archive columns + per-tenant policy hooks). See [docs/retention.md](docs/retention.md). |

## Apply

Run migrations in ascending filename order on a blank database:

```bash
export DATABASE_URL="postgres://owner@localhost:5432/submitsense"
# apply forward migrations in order, skipping paired *.down.sql rollback files
for f in $(ls db/migrations/0*.sql | grep -v '\.down\.'); do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

`0001`-`0023` build the schema (`0016` adds the original `app.claim_next_job()` worker-queue claimer;
`0017` adds package versions, package document selection, branding, register auto-population, and
physical-deliverable tracking fields; `0018` adds versioned risk scoring, rule provenance,
structured RFI drafts, source-risk links, and generated-checklist idempotency; `0021` adds self-serve
onboarding, trial enforcement, Stripe/GST billing records, and reviewed public content; `0022` adds
processing-job leases, fencing, heartbeats, and delayed retries; `0023` adds queue metrics),
`0099_seed.sql` seeds roles/permissions/plans + a test fixture.
Run migrations as the dedicated **migration execution role** — a non-superuser that owns the
application tables (and therefore bypasses RLS, which is why seeding works) but owns nothing in
`migration_control`. See "Roles" below: as of PB-10 Step 3 Phase 2c the migration runner must not be
a superuser and must not own the control schema, and the runner refuses to execute if it does. The
runtime application connects as a different role again.

## Migration integrity

Historical migration SQL is immutable. `db/migrations/manifest.json` records the production forward
set (`0001`-`0023` and `0099`) in numeric order with SHA-256 checksums over each file's exact raw
bytes. `.gitattributes` marks migration SQL as `-text` so Git does not convert line endings before
those bytes are hashed.

After adding a future forward migration, add its reviewed lifecycle/category/mode/timeout metadata
to the manifest with a 64-character placeholder checksum, then run:

```bash
npm run manifest:generate --prefix backend
npm run manifest:check --prefix backend
```

Generation atomically refreshes derived IDs, filenames, order, and checksums; check mode is
read-only. Production discovery and the manifest exclude every `*.down.sql` file. The current
legacy checksums are go-forward integrity anchors from PB-10 onward: they do not prove which
historical byte revisions an existing environment executed. The current SQL execution procedure
above remains in place until the later PB-10 runner step.

## PB-10 read-only migration plan

PB-10 Step 2 adds the `migration_control` control schema with exactly two permanent ledger tables:

- `schema_migrations` is the immutable applied set. Presence means applied; UPDATE and DELETE are
  rejected by an always-enabled trigger.
- `migration_runs` is an INSERT-only event stream. Each heartbeat or terminal outcome is a new
  event; previous events are never updated or deleted.

Both tables reject UPDATE and DELETE with row-level triggers and TRUNCATE with statement-level
triggers, all `ENABLE ALWAYS`. `operation_categories` must use the canonical manifest order
(`schema`, `data-correction`, `security-policy`, `function-replacement`, `index`, `seed-reference`),
enforced at INSERT time by `sm_categories_order_ck`: because applied rows are immutable, a row that
disagrees with the manifest could never be repaired.

PUBLIC and the `submitsense_app` runtime role have no control-schema access. Schema work is
serialized with the session advisory lock `(1398096461, 1)`: the runner uses a dedicated pinned
connection, polls `pg_try_advisory_lock` every five seconds for at most sixty seconds, reports only
redacted holder diagnostics, and explicitly verifies unlock before releasing the connection. Before
the first probe it sets `statement_timeout` (30 s) and `lock_timeout` (5 s) on that connection, so a
plan blocked behind concurrent DDL cannot hold the schema lock indefinitely.

### Roles

PB-10 Step 3 Phase 2c makes the control schema a **two-role** deployment. This is a deployment-model
change, not merely a schema change, and every unforgeability property below depends on it holding in
the actual installation — `runner.ts` re-verifies it at runtime, on the connection migrations will
run on, and refuses to execute anything if it does not.

| Role | What it is | What it may do |
|------|------------|----------------|
| Administrative installer | The role that runs `db/control/install-or-upgrade-control-schema.sh`. Must be able to `CREATE ROLE`, and must not be the migration execution role. | Creates `migration_control_owner`, installs or upgrades the control schema, and grants the execution role its privilege set. It holds no standing ability to act as the owner: the membership it needs is taken and given back inside the install transaction. |
| `migration_control_owner` | `NOLOGIN NOINHERIT NOSUPERUSER`, created by the installer. Nothing ever logs in as it. | Owns the `migration_control` schema, both ledger tables, the proof key, the sequence and every function. |
| Migration execution role | The role the migration runner connects as, and the role **every byte of migration SQL executes as**. Named by `-v migration_execution_role` / `MIGRATION_EXECUTION_ROLE`. Must not be a superuser. | `USAGE` on the schema; `SELECT` on both ledgers; *column-level* `INSERT` on `migration_runs` **excluding `xact_id`**; `USAGE` on the event-id sequence; `EXECUTE` on exactly three functions; `EXECUTE` on `pg_catalog.pg_xact_status(xid8)`. |
| Application role (`submitsense_app`) | The runtime login role. | Nothing at all in `migration_control` — every privilege is explicitly revoked, and `runner.ts` verifies the absence. |

The execution role deliberately has **no** `INSERT` on `schema_migrations`, **no** privilege of any
kind on `proof_key`, and **no** `UPDATE`/`DELETE`/`TRUNCATE` anywhere. It is not a member of
`migration_control_owner` and does not own the schema.

**Why.** Before Phase 2c, the schema was installed *by* the migration owner and this document told
operators to run migrations as "the owner/superuser role". A table owner can `INSERT` any row, `DROP`
any trigger, `ALTER` any table and `REPLACE` any function — and migration SQL runs as that same role.
Under that model no database mechanism can make a proof unforgeable: an accepted `schema_migrations`
row could be inserted by hand with perfectly matching provenance without the migration transaction
ever committing, and an accepted transaction binding could be inserted by any connection for any
attempt. INSERT-only tables, primary keys and mutation-rejection triggers do not make inserted data
authoritative when the relevant ordinary role can insert an arbitrary matching row.

**Failure modes when the privileges are wrong.** `verifyControlSchema` runs before any migration SQL
and fails closed, naming the remedy, if the connected role is a superuser, owns (or is a member of the
owner of) `migration_control`, can `INSERT` into `schema_migrations`, can write
`migration_runs.xact_id`, can read `proof_key`, or holds `UPDATE`/`DELETE`/`TRUNCATE` on a ledger.
An installation upgraded the old single-owner way, or a runner connected as a superuser, therefore
stops the run rather than silently producing forgeable proof.

### Deployment prerequisites

Because the execution role is not a superuser, two things must be provisioned alongside the database
rather than by a migration:

- **Untrusted extensions.** `0001_extensions_helpers.sql` needs `vector`, which is not a trusted
  extension, so `CREATE EXTENSION` for it requires a superuser. Create it (and `citext`, `pg_trgm`)
  as part of database provisioning; the migration's own `create extension if not exists` then
  succeeds as a no-op. Managed PostgreSQL (RDS, Cloud SQL) already expects this shape.
- **`pg_xact_status`.** On a stock cluster this is already executable (its default ACL grants
  `EXECUTE` to `PUBLIC`) and the installer grants nothing. On a hardened cluster where `PUBLIC`'s
  `EXECUTE` has been revoked, the grant is genuinely required and is a superuser operation; a
  non-superuser installer fails closed naming the exact `GRANT` a superuser must run. Without it
  every uncertain attempt simply stays blocked — safe, but it needs an operator for every ordinary
  failed migration.

- **`CREATE` on the database.** `0001_extensions_helpers.sql` issues
  `create schema if not exists app`, and `CREATE SCHEMA` is authorized by `CREATE` on the
  *database* — there is no narrower grant that permits it. So the provisioning that creates the
  database must also run:

  ```sql
  grant create on database <database> to <migration execution role>;
  ```

  This is the **only** database-level privilege the role is given. It conveys nothing over
  `migration_control`, whose schema, both ledgers, the proof key and every function are owned by
  `migration_control_owner` and reachable only through the four granted entry points, and it does not
  make the role a superuser. Omitting it makes the canonical migration suite fail at that exact
  statement with SQLSTATE 42501 — loudly, never as a silent skip;
  `backend/test/migration-control-proof.pg.test.ts` carries the negative control that proves so, and
  `backend/test/helpers/control-schema-install.ts` (`REQUIRED_DATABASE_PRIVILEGE`) and `.github/
  workflows/ci.yml` both provision it.

The migration execution role also needs whatever privileges the migrations themselves require on the
*target* schemas (this repository's baseline migrations create roles, so it needs `CREATEROLE`). None
of that reaches `migration_control`: `CREATEROLE` in PostgreSQL 16+ is scoped to roles its holder
created, so it conveys nothing over `migration_control_owner`.

### Installing or upgrading the control schema

The SQL lives at `db/control/control-schema.sql` (fresh install) and
`db/control/control-schema-upgrade.sql` (idempotent upgrade of an existing installation). Both
`\ir`-include the same two files — `db/control/control-proof-path.sql` (the proof objects) and
`db/control/control-grants.sql` (the execution role's complete privilege set) — so a freshly
installed schema and an upgraded one cannot drift apart. They sit under `db/`, so the existing
migration image (`backend/Dockerfile.migrations`, which already does `COPY db ./db`) carries them
with no new deployment mechanism and no Dockerfile change. The supported command, from the repository
root or inside that image, is the wrapper:

```bash
MIGRATION_EXECUTION_ROLE=submitsense_migrate \
DATABASE_URL="$ADMIN_DATABASE_URL" \
  db/control/install-or-upgrade-control-schema.sh
```

`MIGRATION_EXECUTION_ROLE` is required by both paths. `DATABASE_URL` must be the **administrative**
credential, not the runner's. The wrapper checks whether `migration_control` already exists and picks
the right file: `control-schema.sql` on a bare database, `control-schema-upgrade.sql` otherwise. Both
are transactional, so a failure of either leaves the target exactly as it was before the run.

- **Fresh install (`control-schema.sql`).** Not idempotent by itself: it runs as one transaction, so
  applying it directly a second time fails closed with SQLSTATE `42P06`
  (`schema "migration_control" already exists`) and changes nothing. The wrapper never applies it
  twice — it only runs this file when `migration_control` is absent. It fails closed *before creating
  anything* if the execution role does not exist, is a superuser, or is the role running the install,
  or if the installer cannot `CREATE ROLE`.
- **Upgrade (`control-schema-upgrade.sql`).** Idempotent and safe to rerun any number of times; CI
  runs it three times consecutively and compares. It never drops the control schema, either permanent
  ledger table, or a row. It:
  1. verifies the same ownership preconditions as the fresh install;
  2. creates `migration_control_owner` if absent;
  3. **transfers ownership** of the schema, both ledgers, the sequence and every function to that
     role — the load-bearing half, because a pre-Phase-2c installation is owned by whoever installed
     it, very often the migration runner itself. The transfer runs in four explicit,
     dependency-ordered phases — schema, then tables, then sequences, then functions — and never on
     whatever order a catalog scan happens to return. That ordering is load-bearing:
     `migration_runs.event_id` is a `bigserial`, so `migration_runs_event_id_seq` is an `OWNED BY`
     sequence and PostgreSQL refuses `ALTER SEQUENCE … OWNER TO` on it before its table
     ("sequence … is linked to table"). `ALTER TABLE … OWNER TO` carries a table's owned sequences
     with it, which is exactly why tables precede sequences. Every phase is `ORDER BY`'d on a stable
     key, so re-running the upgrade performs the same statements in the same sequence, and the block
     ends by refusing to continue if anything in the schema is still owned by another role;
  4. adds the proof path (`proof_key`, the four `SECURITY DEFINER` functions, `commit_proof`,
     `xact_id`, `attempt_token_sha256`, their constraints and the three partial unique indexes) from
     the shared include;
  5. backfills `commit_proof` on existing rows — `baseline` for baselined rows,
     `transaction_atomic` for transactional ones (the pre-Phase-2c executor really did write the
     applied row inside the migration transaction; what Phase 2c added is unforgeability, not
     atomicity), `post_hoc_verified` for every other mode;
  6. revokes everything the old model granted the runner and re-grants exactly the current set;
  7. widens `mr_metadata_ck` to the current contract.
- **Upgrade privilege requirement.** Step 3 requires acting with the *existing* owner's rights, so
  the upgrade must be run **by a superuser, or by a role that can administer the current owner**.
  `CREATEROLE` alone is not sufficient — PostgreSQL 16+ scopes it to roles its holder created. This
  is checked up front and reported with the exact `GRANT` remedy, so an installer that could not
  finish the transfer is refused rather than leaving a half-transferred schema.
- **Atomicity.** The whole upgrade — guards, ownership transfer, proof path, grants and the
  `mr_metadata_ck` replacement — runs inside one transaction in a single `psql -f`, so a failure at
  any point rolls back every ownership and schema change and leaves no partially transferred
  installation. `db/control/test-install-upgrade-parity.sh` proves this against a real failure from
  the upgrade's own fail-closed path (an unrecognized `mr_metadata_ck`), and separately proves the
  transfer is independent of catalog object order on a fixture whose extra linked sequence sorts
  ahead of every table.
- **Recognized `mr_metadata_ck` generations.** The live definition must exactly equal one of three
  pinned fixtures — `mr_metadata_ck.previous.def`, `mr_metadata_ck.phase2b.def`, or
  `mr_metadata_ck.current.def` — compared as normalized full strings, never substrings. Anything else
  fails closed and changes nothing. (`phase2b` was missing before this release, which is precisely why
  real deployments sitting at that generation matched neither pinned fixture and could not upgrade.)
- **`submitsense_app` prerequisite.** Not required. The role is normally created by
  `0001_extensions_helpers.sql`, but the installer skips its `REVOKE` statements when the role does
  not yet exist, so a bare database works. When the role is created later it receives no
  control-schema privileges, because nothing grants any. `runner.ts` verifies the absence either way
  via `to_regrole`.
- **To re-check an existing installation** beyond the metadata constraint, run the plan — its
  verifier fails closed on any other catalog drift rather than repairing it.
- **Not a migration.** None of these files is inside `db/migrations/`, so all are absent from the
  manifest and never applied by `migrate.sh`.
- **Regression coverage.** `db/control/test-install-upgrade-parity.sh` proves the whole of the above
  against a real PostgreSQL: fresh install, every fail-closed install case, a genuine pre-Phase-2c
  installation owned by the runner, three consecutive upgrades, one-for-one row preservation, and a
  full catalog comparison (relations, columns, constraints, indexes, triggers, function bodies,
  ownership and every ACL) between a fresh and an upgraded schema.

### Rendering the plan

After installing on a disposable or approved target, render the deterministic JSON plan with:

```bash
npm run migrate:plan --prefix backend
```

The command validates the committed manifest, verifies the control-schema catalog, validates the
applied set as a manifest prefix, and reports pending migrations. It is read-only: it executes no
migration SQL and inserts no ledger or run-event rows. Current legacy checksums cannot prove which
historical bytes a persistent environment executed, and persistent environments have not been
baselined. PB-10 Step 3 execution is implemented separately; this command remains a read-only view.

The plan also refuses to guess. `migrate.sh` records applied migrations in
`public.infrastructure_schema_migrations`, a ledger the control schema knows nothing about. If that
legacy ledger exists, the planner reads its filenames and timestamps and validates that it exactly
matches the control ledger's ordered filenames. Divergent rows and tied, malformed, null, invalid or
otherwise unorderable timestamps fail closed for manual reconciliation. The planner never copies
legacy rows into the control ledger; baseline adoption is not implemented.

## PB-10 migration execution

Step 3 adds execution to the same runner. `migrate:plan` is unchanged and still read-only.

```bash
MIGRATION_SOURCE_GIT_SHA=<commit sha> \
MIGRATION_EXECUTOR_IMAGE_DIGEST=sha256:<64 hex> \
npm run migrate:execute --prefix backend
```

Both identity variables are mandatory and must match the syntax `schema_migrations` enforces. The
runner additionally rejects explicit placeholder forms (all-zero/all-`f` values and repeated
`deadbeef`, `cafebabe`, `feedface`, or `decafbad` patterns); other syntactically valid periodic
digests are accepted. The runner never invents *build* identity — neither variable is ever defaulted,
derived or guessed. Runner identity is different: `MIGRATION_RUNNER_ID` is optional to *supply* but
never absent from the ledger, because a replay-blocking attempt with no runner identity could never be
recovered exactly. when it is unset the runner generates one
(`pb10-runner-<32 hex>`) for the invocation and persists it on every event that invocation writes, so
an attempt can never be recorded without the identity manual recovery correlates against (see
"Unresolved attempts and manual recovery" below). Supply it when you want runs attributable to a
named operator, CI job or host; leave it unset and read the generated value back out of the ledger.
Output
is a deterministic JSON report containing no SQL and no connection details.

The production `executeMigrations` API accepts exactly one `Pool`. It always verifies and executes
the canonical committed manifest; callers cannot inject a manifest, repository root, identity,
handler registry, run id or clock.

### Two connections

| Connection | Owns |
|------------|------|
| Control | The advisory lock, control-schema and manifest verification, and `migration_runs` events in autocommit. Held until execution *and* verification finish. |
| Execution | Migration SQL and its transactions. Cancelled, or destroyed, the moment execution becomes unsafe. |

Nothing executes until the advisory lock `(1398096461, 1)` is held, `migration_control` verifies
exactly, the canonical committed manifest verifies, every applied row matches manifest ordering/
filename/mode/categories/checksum, and any legacy ledger has been read and reconciled against the
control ledger.

### Modes

- **legacy-verbatim** (at or below `0099`) — the file's exact raw bytes are sent as one unchanged
  multi-statement payload, supervised under the migration's whole wall-clock budget (see below). Its
  own `BEGIN`/`COMMIT` is the only transaction; the runner never wraps, parses, splits or normalises
  it, and only session-level timeouts are set beforehand. The applied row, carrying the observed
  checksum, is written afterwards on the control connection. The commit-to-ledger crash window is
  accepted for legacy only. Legacy-verbatim has **no retry evaluator of its own and no automatic
  retry at all**: it goes through the same canonical fence as every other mode
  (`assertNoUnresolvedCommitAmbiguity`), and because the payload owns its own `BEGIN`/`COMMIT` there
  is no transaction the runner can bind for PostgreSQL to rule on and no artifact written atomically
  with it. Nothing in the database can prove what a failed legacy payload did, so *any* prior
  attempt — confirmed-rollback history included — blocks replay until an operator records a
  resolution. A wall-clock cancellation is equally opaque: no rollback is ever claimed, and the
  connection is always discarded rather than reused.
- **transactional** — `BEGIN`, `SET LOCAL` timeouts, migration SQL, the `schema_migrations` insert,
  `COMMIT`, all on the execution connection, so SQL and ledger row are atomic. Each of those
  operations receives only what remains of the migration's shared wall-clock budget, never a fresh
  allowance. A wall-clock timeout while still executing the migration statement is supervised the
  same way as nontransactional mode (see below): a confirmed cancellation is followed by an attempted
  `ROLLBACK`, and only a *proven* rollback records `transaction_rolled_back`/`execution_failed` and
  produces the wall-clock failure; an unproven rollback (it fails, or the cancellation itself was
  never confirmed) destroys the connection, never claims rollback, and is recorded durably as
  `commit_outcome_unknown` — not the narrower `cancellation_unverified` — because a transaction whose
  final state is unknown is exactly as unreplayable as an unconfirmed `COMMIT`, and only the
  `commit_outcome_unknown` class arms the replay fence. A genuine (non-wall-clock) SQL failure keeps
  its pre-Phase-2b behaviour unchanged.

  Immediately after `BEGIN`, and before any migration SQL, the runner reads the migration
  transaction's full 64-bit id with `pg_current_xact_id()` from *inside* that transaction and commits
  it to the ledger on the control connection as this attempt's single **transaction binding** (a
  `heartbeat` row whose `xact_id` column is set — the only row type `mr_xact_ck` permits one on).
  That binding is what later lets `pg_xact_status()` — PostgreSQL's own verdict, not a ledger
  label — decide whether the transaction aborted. If the binding cannot be written the migration
  fails before any SQL runs, rather than executing an attempt whose outcome could never be proven.

  Once `COMMIT` has actually been sent, its outcome is not resolved by guessing in either direction:
  a rejection carrying a genuine PostgreSQL SQLSTATE is authoritative proof of non-commit and follows
  the ordinary rollback path, while a transport-level rejection with no SQLSTATE triggers
  reconciliation against the exact canonical identity
  (`migration_id` + `ordinal` + `run_id` + applied checksum) in `schema_migrations` — the row that
  commits inside the migration's own transaction. A proven row completes the migration normally;
  absence, or a reconciliation query that itself fails, records `commit_outcome_unknown` durably and
  blocks every future attempt until an operator resolves it. Connection liveness is never treated as
  evidence either way.
- **nontransactional** — one independently retry-safe operation, never wrapped in a transaction, with
  a migration-specific verifier that distinguishes absent / valid / invalid before and after.
  Absent executes; valid-but-unrecorded is adopted; invalid or partial requires explicit
  verifier-led recovery and is never blindly replayed. `inspectConcurrentIndex` provides that
  distinction for `CREATE INDEX CONCURRENTLY`. This is the mode the cancellation-confirmation state
  machine (`superviseOperation`, module-private inside `backend/src/db/migrate/execute.ts`) was
  originally built for:
  `pg_cancel_backend` returning `true` means only that PostgreSQL accepted the cancellation request,
  never that it happened; only a rejection with SQLSTATE `57014` observed within a bounded grace
  period after that request counts as confirmed. Every other outcome — the request itself failing,
  the grace period elapsing with no settlement, or the operation completing anyway — is
  `cancellation_unverified` and destroys the execution connection rather than reusing it.
- **batched** — mode boundary only. The runner supplies a bounded per-batch transaction and demands
  an independent completion verifier; progress is owned by a reviewed migration-specific handler.
  There is deliberately no generic backfill executor and no `backfill_runs` table. With no registered
  handler, batched fails closed on an unsupported-handler error and never degrades to another mode.
  One aggregate wall-clock budget is shared across every batch — no batch, however quickly it
  individually finishes, ever receives a fresh allowance, and the total across every batch cannot
  exceed the declared budget merely because each batch stayed under its own transaction ceiling. If
  the budget is already exhausted between batches, the next batch never starts. A timeout during an
  active batch uses the same cancellation-confirmation supervision as the other modes, applied to
  that one active batch; earlier, already-committed batches are never described as rolled back.

Both handler registries in `backend/src/db/migrate/handlers.ts` are empty: no migration above `0099`
exists yet, so `executeMigrations(pool)` itself never reaches batched or nontransactional mode with a
real handler. The batched-mode orchestration, the cancellation-confirmation supervision core and the
execution context are all module-private declarations inside `backend/src/db/migrate/execute.ts` —
there is no `batched.ts`, `execution-context.ts` or `supervision.ts`, and nothing but
`executeMigrations(pool)` is callable from the emitted build. Every suite therefore drives the real
entry point: `backend/test/migration-batched.pg.test.ts` (batched mode, real PostgreSQL, a
test-supplied handler substituted only for `execute.ts`'s own `./handlers` import),
`backend/test/migration-execute-supervision.pg.test.ts` and
`backend/test/migration-execute-wallclock.pg.test.ts` (cancellation confirmation and wall-clock
supervision, real PostgreSQL), and `backend/test/migration-execute.test.ts` (deterministic, against an
in-memory fake pool).

### Events and timeouts

`migration_runs` stays INSERT-only. One run id per invocation, with `event_sequence` starting at 1 and
increasing. Events carry a SQLSTATE, a bounded error class and whitelisted metadata only — never SQL
bodies, query parameters, secrets, customer data or tenant identifiers. `RunLog` stamps
`migration_filename`, `migration_ordinal` and `checksum_sha256` on every event it writes, from the
verified manifest, so those are never per-call-site decisions.

The one non-metadata column is `xact_id` (type `xid8`, nullable): the transaction-outcome binding
described under *Unresolved attempts and manual recovery* below. `mr_xact_ck` permits it only on a
`heartbeat` event, and the executor writes exactly one per bound attempt. Installations created
before it existed gain it through `db/control/install-or-upgrade-control-schema.sh`, which adds the
nullable column and its constraint idempotently, reading and rewriting no rows.

Manifest timeouts are capped at the approved limits (`lock_timeout` 5 s, `statement_timeout` 60 s,
`transaction_timeout` 5 min, `idle_in_transaction_session_timeout` 60 s, wall clock 15 min
transactional / 30 min nontransactional). Phase 1 validates those declarations and configures the
database-native timeouts.

**Wall-clock budget (Phase 2b).** Each migration derives exactly one absolute deadline from its
declared `wallClockMs`, using a monotonic clock (`process.hrtime.bigint()`), the moment that
migration's `started` event is recorded — never Date/calendar time, and never reset by a later
statement, batch, cancellation, inspection, transaction creation or COMMIT attempt. Before every
database operation the runner computes what remains of that budget and passes only that remainder
onward — an exhausted budget is never silently clamped back up to a positive timeout, and no further
statement, batch or inspection query is started once it reaches zero. The effective timeout for any
one operation is always the minimum of that remainder, the mode's own statement/transaction ceiling,
and the run-level ceiling. Nontransactional mode's existing cancellation-confirmation state machine
(`superviseOperation`) is reused unchanged for every mode's wall-clock enforcement — there is exactly
one `Promise.race`-based supervision core (`superviseOperation`/`superviseCallback`, module-private
inside `execute.ts`), never a second, independent implementation.

Ambiguous-`COMMIT` classification and reconciliation after `COMMIT` has been sent is implemented
(Phase 2c — see the transactional mode description above).

### Phase 2c implementation status

Implemented and covered by durable regressions:

- **Protected commit proof (C1).** `schema_migrations` has exactly one writer,
  `migration_control.record_applied_migration`, and the execution role holds no `INSERT` on the
  table. The function decides `commit_proof` itself and never accepts it; for a transactional
  attempt it refuses unless `pg_current_xact_id()` equals that attempt's already-durable binding, so
  the row is written inside the exact transaction it describes and exists only if that transaction
  committed. Proven against real PostgreSQL as the non-superuser runner in
  `backend/test/migration-control-proof.pg.test.ts`.
- **Transaction claim and binding (C2).** `claim_transaction` reads the transaction id from inside
  the caller's own transaction — it is not a parameter at any layer — and returns a receipt keyed by
  `migration_control.proof_key`, which is granted to no role. `record_transaction_binding` verifies
  that receipt and writes the binding on the control connection in autocommit, before any risky
  migration SQL, so it survives both `COMMIT` and `ROLLBACK`. Three partial unique indexes make a
  duplicate, replacement or cross-attempt binding *impossible* rather than merely detectable.
- **Role separation, fresh install and upgrade.** See "Roles" and "Installing or upgrading the
  control schema" above. `db/control/test-install-upgrade-parity.sh` is the regression.
- **`stale_legacy_attempt` compatibility.** The class remains in `ERROR_CLASSES` and in the exported
  `ErrorClass` union, because `migration_runs` is INSERT-only and real installations still carry rows
  that use it. No current execution path emits it, and it is never accepted as proof that a
  transaction rolled back, so an attempt whose only terminal evidence carries it stays blocked.
  `backend/test/migration-error-class-compatibility.test.ts` asserts all of that, including against
  the emitted `execute.d.ts`.

- **Mode-specific safe recovery (H2).** A two-stage decision system: one central safety gate that is
  the only thing able to *block*, plus one authoritative evaluator per execution mode that is the
  only thing able to permit a *replay*. See "Mode-specific safe recovery (H2)" below.
  `backend/test/migration-h2-recovery.pg.test.ts` is the real-PostgreSQL regression, driven entirely
  through `executeMigrations(pool)`.

Not implemented, and deliberately not claimed:

- pooled-session reset after a destroyed/discarded connection — Phase 2d;
- broader error and diagnostic sanitization beyond the fixed error-class vocabulary already
  enforced — Phase 2e.

### Unresolved attempts and manual recovery

**All four modes** — legacy-verbatim, transactional, nontransactional and batched — go through one
decision path (`applyExecutionDecision`, module-private in `execute.ts`) before a single byte of
migration SQL can run. There is no second, weaker evaluator for any mode. Its first stage — the
central safety gate described in "Mode-specific safe recovery (H2)" below — is the only thing that
can block a replay, and it blocks on *any* previous attempt it cannot account for; its second stage
is the only thing that can permit one, and only for an attempt the gate explicitly released. It walks the complete history and tracks every attempt independently under
one canonical **immutable attempt identity**, established once by that attempt's `started` row and
never altered by a later event:

| Field | Source |
|-------|--------|
| started `event_id` | the `bigserial` primary key of the attempt's own `started` row |
| `run_id` | the invocation that made the attempt |
| `runner_id` | the runner identity that invocation persisted |
| `migration_id`, `migration_filename`, `migration_ordinal` | stamped from the verified manifest at write time |
| `execution_mode` | the mode that attempt ran under |
| `checksum_sha256` | the exact migration bytes that attempt executed |
| `source_git_sha`, `executor_image_digest` | the build that ran it |

`checksum_sha256` is stamped by `RunLog` on **every** event of **every** mode, from the verified
manifest, so it is a required correlation field rather than an optional one: a later event that omits
it, or carries a different one, is not a later event of that attempt. (A `started` row written before
checksum metadata existed has none; such an attempt is `legacy_*`, never `complete_modern`, and can
never be cleared by a terminal event.)

**Batch identity is deliberately not part of this identity.** The top-level migration attempt is the
unit of replay blocking. A batched migration's batches commit on independent transaction boundaries,
so no single batch's outcome can speak for the migration: `batch_number` is a *within-attempt*
operation identifier carried by batch-scoped events only. It is rejected on a `started` row (batches
begin after it), rejected on a non-batched attempt, must be a positive integer where present, and is
not a permitted key on a `stale_reclaimed` resolution at all — a resolution names the attempt, never
a batch. No batch event can resolve the attempt.

One correlation function is used for every decision — terminal correlation, ambiguity correlation,
replay blocking, manual resolution, duplicate validation and legacy classification, in every one of
the four modes. Every field the ledger stamps on every event must match exactly; a missing required
field and a contradicting field both fail closed identically. Matching only `run_id`, or only the
migration name, is never sufficient.

**Ordering.** `event_id` is the authoritative order. `event_sequence` is per **run**, not per
migration: one `executeMigrations(pool)` invocation uses one run id across every migration it touches,
`RunLog` is its only writer and advances the counter only once an INSERT is confirmed, `migration_runs`
is INSERT-only (UPDATE/DELETE are rejected by an always-enabled trigger) and carries
`unique (run_id, event_sequence)`. A run's rows are therefore contiguous `1..N` — a guarantee of the
schema and the writer, not an assumption. The evaluator reads every row of every run that touched the
migration (not just that migration's own rows, since a run legitimately interleaves several
migrations) and fails closed on a gap, a duplicate or reused sequence, a decreasing sequence,
non-increasing event ids, an event whose required predecessor is absent, or a second `started` row for
an attempt that already has one.

**Attempt categories.** Each unresolved attempt is reported with its category:

- **`complete_modern`** — every immutable field is present. Everything written under the documented
  configuration is complete. Normal terminal proof and normal manual resolution both apply.
- **`legacy_provable`** — a historical row missing `checksum_sha256`, where the one
  provenance-qualified artifact proves the bytes that run executed (see below). Normal manual
  resolution applies, against the proven checksum. Note that this category is not reachable while a
  migration is pending — see the provenance section below — so in practice a pre-checksum attempt
  reports as `legacy_unprovable`.
- **`legacy_unprovable`** — a historical row whose missing field cannot be proven from the database:
  no checksum evidence, or no `runner_id` (nothing can prove an identity that was never written).
  Replay stays blocked and normal `stale_reclaimed` resolution is refused. Requires the out-of-band
  procedure below.
- **`malformed_or_conflicting`** — contradictory duplicate rows, a broken sequence, an event that
  contradicts its attempt's identity, contradictory historical evidence, or a `started` row that
  cannot establish an identity at all. Replay stays blocked and nothing clears it.

**Terminal events must carry proof, and one ledger row is never proof of another.** `migration_runs`
is INSERT-only, but it is not insert-*proof*: anything with INSERT access can write
`applied_committed`, `succeeded`, `transaction_rolled_back`, `execution_failed`, a matching
`error_class` and a matching SQLSTATE. Two rows agreeing on their fields prove only that their fields
agree — never that PostgreSQL committed or rolled anything back. So clearing an attempt requires the
writer's own event shape **plus** evidence that lives outside the ledger's label vocabulary:

| Terminal event | Required durable evidence |
|----------------|---------------------------|
| `succeeded` | an `applied_committed` row for the same attempt, **and** the immutable applied-ledger row in `schema_migrations` whose `run_id`, `ordinal`, `filename`, `execution_mode`, `source_git_sha`, `executor_image_digest` and `applied_checksum_sha256` are all this attempt's own. That table is INSERT-only *and* UPDATE/DELETE/TRUNCATE-proof, `migration_id` is its primary key, and in transactional mode the row commits inside the migration's own transaction — so its existence is a database-enforced consequence of `COMMIT`, not a claim about one. (A migration that has such a row is applied, not pending, so this branch is defence in depth: a `succeeded` label reaching the evaluator without it contradicts the database and blocks.) |
| `execution_failed` | a `transaction_rolled_back` row for the same attempt carrying the **same** `error_class` and the **same** SQLSTATE, **and** this attempt's single transaction binding, written before that rollback, whose `xact_id` PostgreSQL's own `pg_xact_status()` reports as `aborted`, **and** no applied-ledger row for the attempt. The class must additionally be one that can be rolled back at all: `sql_failed` or `wall_clock_exceeded`. Zero bindings, two bindings, a binding whose `xact_id` any other event anywhere also binds, a binding written after the rollback, a status of `committed`/`in progress`/`NULL`, or an unreadable `pg_xact_status` all leave the attempt blocking. |
| `verification_failed` | none accepted. A batched completion verifier runs *after* batches have already committed on their own transaction boundaries, so it proves nothing about what landed; it never clears an attempt. |

Only **transactional** mode has a transaction this runner can bind, so only transactional mode
retries automatically after a failure. Legacy-verbatim (the payload owns its own `BEGIN`/`COMMIT`),
nontransactional (no transaction exists; recovery is verifier-led) and batched (batches commit
independently, so an aborted batch says nothing about the batches that landed) have no rollback proof
available and fail closed to operator resolution. That is deliberate: where PostgreSQL cannot be
asked, the runner refuses rather than trusting a label.

Nothing else is terminal. `commit_outcome_unknown`, `cancellation_unverified`, a failed rollback,
`control_connection_lost`, `ledger_insert_failed`, `checksum_drift`, `run_budget_exceeded`, an unknown
or null class, and any allowed label inserted without its evidence all leave the attempt blocking.
A `commit_outcome_unknown` strengthens its attempt's state without altering its identity: from that
point only an operator resolution can clear it, never a later terminal event.

**Required privilege.** The runner needs `EXECUTE` on `pg_catalog.pg_xact_status(xid8)`. On a stock
PostgreSQL cluster it already has it — the function's default ACL grants `EXECUTE` to `PUBLIC` — and
the installer grants nothing. On a hardened cluster where that has been revoked, a superuser must
supply it:

```sql
grant execute on function pg_catalog.pg_xact_status(xid8) to <the migration execution role>;
```

The installer detects the gap and fails closed naming exactly this command rather than producing an
installation that looks complete and is not. Without the privilege the lookup fails closed, so a
failed transactional migration blocks replay and needs an operator resolution instead of retrying
automatically. Nothing becomes *less* safe without the grant.

**Historical bytes are never assumed.** The current migration file's checksum is *never* accepted as
proof of the bytes a historical run executed — and neither is a `checksum_sha256` appearing on a
later ledger event. Correlation makes a row *addressed to* an attempt; it never makes it
*provenance for* one, and a later event is exactly what an untrusted writer can insert. (This was
previously accepted, which let a hand-written row retroactively become proof of historical bytes.)

Exactly one provenance-qualified source is accepted: the committed `schema_migrations` row for this
migration, and only when every field it carries is this attempt's own — `run_id`, `ordinal`,
`filename`, `execution_mode`, `source_git_sha`, `executor_image_digest` — using its
`applied_checksum_sha256`. More than one candidate row, a baselined row with no applied checksum, a
provenance mismatch, or an unreadable source all fail closed.

In practice this means a `started` row written before `checksum_sha256` existed is **permanently**
`legacy_unprovable`: a migration that has an applied-ledger row is applied rather than pending, so
the qualified source and a pending evaluation never coexist. Such an attempt is not resolvable by the
normal procedure and needs the out-of-band decision described below. That is the intended
fail-closed outcome, not an oversight.

**Retrieving the recovery identifiers.** Everything a resolution must state is in the ledger. The
target is the attempt's **`started`** row (its `event_id` is the attempt's identity), not the failure
row:

```sql
select event_id, run_id, runner_id, event_type, error_class, sqlstate, event_sequence,
       source_git_sha, executor_image_digest,
       metadata ->> 'checksum_sha256' as checksum_sha256
  from migration_control.migration_runs
 where migration_id = '0100'
 order by event_id;
```

The unresolved attempt is the `started` row with no proof-carrying terminal outcome under the same
`run_id`. The blocked-replay error itself names each one as
`event_id=<n> run_id=<uuid> category=<category> reason=<token>`.

**Recording the resolution.** Prove independently what actually happened first — this is the only way
past the guard, and it is deliberately data-only: no code path in the runner ever writes a
`stale_reclaimed` row.

```sql
insert into migration_control.migration_runs
  (run_id, migration_id, event_sequence, event_type, runner_id,
   source_git_sha, executor_image_digest, metadata)
values (gen_random_uuid(), '0100', 1, 'stale_reclaimed', '<your own operator id>',
        '<the started row''s source_git_sha>', '<the started row''s executor_image_digest>',
        jsonb_build_object(
          'execution_mode', 'transactional',
          'migration_filename', '0100_expand_demo.sql',
          'migration_ordinal', 1,
          'reclaim_reason', 'heartbeat_expired',       -- or connection_lost / operator_approved
          'checksum_sha256', '<the attempt''s proven checksum>',
          'resolved_event_id', <the started row's event_id>,
          'resolved_run_id', '<the started row''s run_id>',
          'resolved_runner_id', '<the started row''s runner_id>',
          'resolved_checksum_sha256', '<the attempt''s proven checksum>'));
```

Two different runner identities appear here, deliberately:

- the **`runner_id` column** is the resolution's *author* — who performed the reconciliation. It is
  required (an unattributable resolution clears nothing) and never participates in correlation, so it
  may freely differ from the attempt's own runner.
- **`resolved_runner_id`** is the *target* — the runner identity persisted on the attempt being
  resolved. The author identity can never substitute for it.

Every `resolved_*` field, plus the migration filename/ordinal/mode, `source_git_sha` and
`executor_image_digest`, is compared for exact equality against the target attempt's own recorded
values, and the metadata key set must be exactly the one above. Resolution by migration name alone,
newest-row selection or wildcard matching does not exist. One resolution row clears exactly one
attempt: with several unresolved, each needs its own.

**When normal resolution is unavailable.** A `legacy_unprovable` or `malformed_or_conflicting` attempt
cannot be resolved by the procedure above, by design — the exact values a resolution must state either
never existed or contradict each other. Recovery is an explicit out-of-band decision, not a wildcard:
establish independently (from deployment records, backups, or the database's own current shape) what
that attempt actually did, then choose deliberately between adopting the migration as `baselined` in
`schema_migrations` and correcting the environment forward with a new migration. Both leave an
auditable immutable record. Nothing in the runner performs either step for you, and no ledger row
recorded after the fact can retroactively supply evidence the original attempt never wrote.

Nothing in this step adopts a baseline or installs the control schema anywhere new.

### Mode-specific safe recovery (H2)

Blocking every replay after every unresolved attempt is safe but wrong: it demands an operator for
cases the database can settle conclusively. H2 splits that one decision into **two stages with
separate authority**, both module-private inside `execute.ts` and both consumed only by
`executeMigrations(pool)`:

| Stage | Function | May say |
|-------|----------|---------|
| 1 | `loadCompleteAttemptHistory` → `evaluateCentralSafety` | *blocked*, or *already resolved*. **Never** *safe*. |
| 2 | `evaluateTransactionalOutcome` / `evaluateBatchedOutcome` / `evaluateVerifierLedOutcome` | *safe*, *already applied*, *manual*, *still active*, *malformed*. |

`applyExecutionDecision` runs Stage 1, then — only for attempts Stage 1 explicitly released — the one
evaluator matching the migration's declared mode, and returns `execute` or `adopt`. Anything else
raises the same fail-closed `commit_outcome_unknown` error as before, carrying a sanitized
per-attempt reason of the form
`event_id=… run_id=… category=… reason=<mode>:<outcome>:<why>`. Reasons are fixed tokens: never SQL,
row values, connection details or driver objects.

#### Stage 1 — the central safety gate

Unchanged from the pre-H2 fence, and still the only thing that can block. It walks the complete
history under the canonical immutable attempt identity documented above and refuses outright on:
malformed event ordering; sequence gaps, duplicates or decreasing sequences; conflicting immutable
attempt metadata; a duplicate or identity-incomplete `started` row; an unresolved
`commit_outcome_unknown`; control-connection loss with no authoritative reconciliation; uncorrelated
terminal events; a `legacy_unprovable` attempt; and an armed attempt belonging to *this* invocation's
own run id (still active). **A mode evaluator can never override any of these, and is never even
run when one is present** — the verifier is not consulted at all against malformed, ambiguous or
active history.

Cross-process liveness needs no separate probe: `executeMigrations(pool)` holds the session-scoped
schema advisory lock for the whole run, so a second live executor cannot be past it, and a dead
one's lock is released by PostgreSQL itself.

Stage 1's four conceptual verdicts are `DEFINITIVELY_BLOCKED`, `REQUIRES_MODE_EVALUATION`,
`DEFINITIVELY_APPLIED` (protected commit proof exists — see C1) and `DEFINITIVELY_NOT_COMMITTED`
(the protected binding protocol plus `pg_xact_status` prove the abort — see C2, or an exactly
correlated operator resolution).

An *invalid* `stale_reclaimed` row is deliberately **not** an extra blocking fact. It clears nothing,
so every attempt it failed to name stays blocked exactly as it was — which is already the required
outcome — while blocking on the row itself would make one mistyped operator `INSERT` into an
INSERT-only, UPDATE/DELETE-proof table permanently unrecoverable.

#### The durable progress markers

Three modes have no transaction this runner can bind, so nothing in the pre-H2 event stream could
distinguish "died before issuing anything" from "died halfway through". Legacy-verbatim,
nontransactional and batched therefore commit two `heartbeat` rows on the **control** connection, in
autocommit:

| `statement_ordinal` | Written | Means |
|---------------------|---------|-------|
| `1` | immediately after the `started` row | this attempt's writer records progress at all |
| `2` | immediately before the first durable operation (the payload, or a batched attempt's first `BEGIN`) | durable work really was issued |

Both are written **only** by `migration_control.record_progress_marker`, a `SECURITY DEFINER`
function owned by `migration_control_owner`. This is not decoration: a marker permits `SAFE_TO_RETRY`,
so it is replay-authorizing evidence and needs exactly the provenance commit proof and transaction
bindings have. The earlier generation reused ordinary `heartbeat` rows while the execution role held
column-level `INSERT` on `statement_ordinal` — which meant the role whose replay the markers
authorize could manufacture the evidence authorizing it, in one hand-written `INSERT`. A durable row
is not authoritative when the same ordinary role can independently produce it.

What makes a marker authoritative:

- **Provenance.** `control-grants.sql` grants the execution role no `INSERT` on `statement_ordinal`
  at all, exactly as it grants none on `xact_id`. PostgreSQL refuses any statement from that role
  that so much as *names* the column, even as `NULL`, so a marker can only be the output of the
  protected function. `mr_marker_ck` pins the shape (`heartbeat`, ordinal 1 or 2, no binding), so no
  other event type can impersonate one.
- **Attempt binding.** The caller names an attempt only by presenting that attempt's 256-bit claim
  token, which exists solely in the memory of the process that armed it — only `sha256(token)` is
  stored, and reading the ledger reveals the digest alone. Every identity column on the marker is
  then copied from that attempt's own `started` row, never accepted from the caller, so a marker can
  never carry an identity contradicting its attempt and one attempt's marker can never be minted for
  another.
- **Lifecycle position.** Enforced by the database, not by the reader: marker `1` only after the
  exact `started` row (`attempt_for_token` resolves it or raises), marker `2` only after marker `1`,
  and neither twice (`mr_one_marker_per_attempt`). Missing, duplicate, reordered or conflicting
  marker evidence is impossible to create, and the evaluator additionally fails closed on it
  (`conflicting_progress_marker_history`).
- **Durability ordering.** Autocommit on the control connection, awaited: the marker is on disk
  before the operation it describes is dispatched, and it survives the loss of the execution
  connection. If marker `2` cannot be persisted the call throws and payload SQL is never reached.

`runner.ts` verifies all of this against the live connection before a byte of migration SQL runs: a
runner that can write `statement_ordinal` directly fails closed with a named remedy. The transaction
binding is also a `heartbeat`, but the protected function writes it with `statement_ordinal` NULL, so
the three can never be confused.

Marker `1` exists specifically so that **an attempt written before H2 never claims the pre-work
retry**. Every historical attempt is silent about progress whether it ran nothing or ran everything;
reading that silence as "nothing was issued" would offer an automatic replay of a possibly
half-applied migration. Without marker `1`, an attempt is treated exactly as it was pre-H2.

Transactional mode writes no markers: the protected binding is its authoritative evidence.

#### Stage 2 — transactional

C1/C2 are the authority and nothing here weakens them. In order:

| Evidence | Outcome |
|----------|---------|
| protected commit proof for this exact attempt (`commit_proof = 'transaction_atomic'`) | `ALREADY_APPLIED` — never replayed |
| an applied row for this attempt that is *not* `transaction_atomic` | `MANUAL_RESOLUTION_REQUIRED` |
| zero, duplicate or cross-attempt-reused binding (also: ROLLBACK requested but never authoritatively confirmed) | `MANUAL_RESOLUTION_REQUIRED` |
| a binding that is not the attempt's second correlated row | `MANUAL_RESOLUTION_REQUIRED` |
| `pg_xact_status` = `aborted`, and the attempt recorded **no** terminal event | `STILL_ACTIVE` — the durable `started` row is the fence, not the advisory lock |
| `pg_xact_status` = `aborted`, plus any correlated `transaction_rolled_back`/`execution_failed`, and no contradicting applied row | `SAFE_TO_RETRY` |
| `pg_xact_status` = `committed` with no commit proof | `MANUAL_RESOLUTION_REQUIRED` |
| `pg_xact_status` = `in progress` | `STILL_ACTIVE` |
| status NULL, unreadable, ungranted or unrecognised | `MANUAL_RESOLUTION_REQUIRED` |

The only relaxation against pre-H2 is the *shape* of the terminal record: `terminalProof` demands the
writer's full `transaction_rolled_back` + `execution_failed` pair with matching error classes and
SQLSTATEs, in order, drawn from a fixed class set, so an attempt that aborted and then died before it
could finish describing itself stayed blocked despite PostgreSQL holding a conclusive answer. The
evidence accepted is identical; the retry licence still comes from `pg_xact_status`, never a label.

#### Stage 2 — batched

Batches commit on independent transaction boundaries and the protected protocol binds exactly one
transaction per attempt, so a batch that began has **no** abort proof available to it — and the
absence of a success event is never evidence that nothing committed (a process can die between a
batch's `COMMIT` and its `operation_completed` row).

| Evidence | Outcome |
|----------|---------|
| two `operation_completed` rows for the same `batch_number` | `MALFORMED_OR_CONFLICTING` |
| batch-scoped events on an attempt whose own writer recorded no durable work | `MALFORMED_OR_CONFLICTING` |
| any `operation_completed` carrying a `batch_number` | `MANUAL_RESOLUTION_REQUIRED` — a batch committed |
| no marker `1` (a pre-H2 attempt) | `MANUAL_RESOLUTION_REQUIRED` |
| marker `2` present | `MANUAL_RESOLUTION_REQUIRED` — a batch opened a transaction and its commit outcome is unprovable |
| marker `1`, no marker `2`, no batch events | `SAFE_TO_RETRY` — no batch work ever began |

`verification_failed` after committed batches lands in the "a batch committed" row above: durable
batch effects exist, so an operator decides. Pending, abandoned and unconsumed batch promises are
already latched as `commit_outcome_unknown` by the executor and blocked by Stage 1.

#### Stage 2 — nontransactional and legacy-verbatim

One implementation, because their recovery question is identical: no transaction this runner can bind
exists, so the *migration-specific verifier* — not the ledger — is the authority on what landed. Both
modes take that verifier from the same reviewed registry (`src/db/migrate/handlers.ts`).

| Evidence | Outcome |
|----------|---------|
| marker `1`, no marker `2` | `SAFE_TO_RETRY` — no statement was ever issued |
| no marker `1` (a pre-H2 attempt), no registered verifier | `MANUAL_RESOLUTION_REQUIRED` |
| verifier returns `valid` | `ALREADY_APPLIED` — recorded, never re-executed |
| verifier returns `absent` | `SAFE_TO_RETRY` |
| verifier returns `invalid` | `MANUAL_RESOLUTION_REQUIRED` — a durable partial effect exists |
| verifier returns `unknown` | `MANUAL_RESOLUTION_REQUIRED` — inconclusive |
| verifier throws, or none is registered | `MANUAL_RESOLUTION_REQUIRED` |

A handler exception is never treated as proof that no SQL completed, and its own error text is never
surfaced — only the fixed reason token. `NontransactionalState` gained `unknown` for exactly this:
"I could not classify" is a different fact from `invalid`'s "I looked, and what is there is partial".
Both block; only `invalid` asserts a durable partial effect exists.

**Legacy-verbatim in practice.** No legacy migration registers a recovery verifier today, so a legacy
attempt that actually issued its payload stays exactly as fail-closed as it was pre-H2. What H2
restores is the *safe* half that the Phase 2c rewrite had removed along with the old weaker
evaluator: an attempt that never reached its payload now retries automatically, and a reviewed
verifier — when one is written — can prove non-application or prior application. The old
label-shaped legacy evaluator is not restored: legacy-verbatim uses the same canonical attempt
identity, full-history ordering, correlation rules, ambiguity classification, protected-proof
handling, manual-resolution correlation and malformed-history blocking as every other mode.

#### `stale_legacy_attempt` compatibility

Unchanged by H2. The class stays in `ERROR_CLASSES` and in the exported `ErrorClass` union because
`migration_runs` is INSERT-only and real installations still carry rows using it. No execution path
emits it, and it is never accepted as proof that a transaction rolled back, so an attempt whose only
terminal evidence carries it stays blocked.

#### What H2 requires of an installation

No new event type and no new metadata key. The markers do add protected objects, all of them in
`db/control/control-proof-path.sql`, which both install paths `\ir`-include: the
`record_progress_marker` function, the `mr_marker_ck` constraint and the `mr_one_marker_per_attempt`
partial unique index, plus the removal of `statement_ordinal` from the execution role's column-level
`INSERT` grant. Existing installations pick all of this up through the ordinary
`db/control/install-or-upgrade-control-schema.sh` run; `mr_marker_ck` validates against every shipped
generation (historical rows carry `statement_ordinal` only on failure rows, never on a `heartbeat`),
so no historical row is rewritten or rejected. Fresh/upgraded parity is verified at 191 identical
catalog facts by `db/control/test-install-upgrade-parity.sh`. The existing
`pg_xact_status` `EXECUTE` grant to the migration execution role (see "Deployment prerequisites") is
still what the transactional evaluator depends on; without it, that evaluator reports
`bound_transaction_status_unavailable` and blocks rather than guessing.

## Runtime connection (required for RLS to work)

The app must **not** connect as the table owner. Create a login role that inherits `submitsense_app`:

```sql
create role app_login login password '***' in role submitsense_app;
```

Then, per request/transaction, set the tenant context GUCs before any query:

```sql
set local app.tenant_id  = '<tenant-uuid>';
set local app.user_id    = '<user-uuid>';
set local app.actor_type = 'human';   -- or 'system' for background jobs
```

RLS (`tenant_id = app.current_tenant_id()`) isolates every tenant table. `app.actor_type` gates the
human-sign-off guard (a `system` actor can never set `human_approved`). Read-only audit export uses
the `submitsense_auditor` role.

## Verify

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_guardrails.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_package_assembly.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_risk_rfi_agent.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_security_hardening.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_commercial_content.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/test_queue_ledger.sql
```

The first script proves the eight compliance guardrails fire (human-approval guard, cross-tenant match block,
append-only audit, RLS isolation, NATSPEC-copyright publish block). Prints `PASS n` lines; aborts on
any `FAIL`. The package script adds nine checks for register auto-population, ready-version
integrity, cross-tenant attachment rejection, package-version RLS, nullable composite-reference
cleanup, retryable/exhausted/committed worker recovery, and Australian deadline boundaries. The
risk/RFI script adds six scoring, evidence, idempotency, and draft-structure checks. The queue script
checks concurrent claims, lease fencing, heartbeats, retry timing, exhaustion, reconciliation, RLS,
and index use. Transactional scripts roll back. All checks were executed successfully on PostgreSQL
17 with pgvector 0.8.4.

## Rollback strategy (req f30)

- **Failed apply** — every migration is wrapped in `BEGIN/COMMIT`; PostgreSQL DDL is transactional,
  so a failed file rolls itself back automatically. Fix and re-run.
- **Down files** — retained for disposable local/test recovery only and excluded from production
  execution and the production manifest.
- **Persistent environments** — recover forward with a corrective migration; production workflows
  must not invoke a down file.

## Layout

```
db/
  migrations/   0001..0023 schema, 0099 seed, manifest, local/test-only downs
  test/         runnable compliance and package-assembly checks
  docs/         ERD, table/enum docs, RLS, indexing, retention, queries, HANDOFF contract
```

Start with [docs/HANDOFF.md](docs/HANDOFF.md) for the contract handed to backend/auth/frontend/QA.
