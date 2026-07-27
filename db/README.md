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
Run migrations as the **owner/superuser** role (it owns the tables and therefore bypasses RLS, which
is why seeding works). The runtime application connects as a different role — see below.

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

### Installing or upgrading the control schema

The SQL lives at `db/control/control-schema.sql` (fresh install) and
`db/control/control-schema-upgrade.sql` (idempotent upgrade of an existing installation). Both sit
under `db/`, so the existing migration image (`backend/Dockerfile.migrations`, which already does
`COPY db ./db`) carries them with no new deployment mechanism and no Dockerfile change. The
supported command, from the repository root or inside that image, is the wrapper:

```bash
DATABASE_URL="$DATABASE_URL" db/control/install-or-upgrade-control-schema.sh
```

It checks whether `migration_control` already exists and picks the right file: `control-schema.sql`
on a bare database, `control-schema-upgrade.sql` otherwise. Both are transactional, so a failure of
either leaves the target exactly as it was before the run.

- **Ownership.** Run it as the migration owner — the same role `infra/scripts/migrate.sh` uses. That
  role owns the schema, both tables, both functions, and the sequence, and is the only role able to
  INSERT. Do not install it as `submitsense_runtime` or any application login role.
- **`submitsense_app` prerequisite.** Not required. The role is normally created by
  `0001_extensions_helpers.sql`, but the installer skips its `REVOKE` statements when the role does
  not yet exist, so a bare database works. When the role is created later it receives no
  control-schema privileges, because nothing grants any. `runner.ts` verifies the absence either way
  via `to_regrole`.
- **Fresh install (`control-schema.sql`).** Not idempotent by itself: it runs as one transaction, so
  applying it directly a second time fails closed with SQLSTATE `42P06`
  (`schema "migration_control" already exists`) and changes nothing. The wrapper never applies it
  twice — it only runs this file when `migration_control` is absent.
- **Upgrade (`control-schema-upgrade.sql`).** Idempotent and safe to rerun any number of times. It
  never drops the control schema, either permanent ledger table, or a row: it only replaces
  `mr_metadata_ck` with the current metadata contract, and only when the live constraint definition
  doesn't already match. The `DROP CONSTRAINT` / `ADD CONSTRAINT` pair is one atomic `ALTER TABLE`
  statement inside `BEGIN`/`COMMIT`, so no session — including concurrent ones — ever observes the
  metadata check absent or unintentionally unrestricted. It fails closed with a sanitized error, and
  changes nothing, if `migration_control` doesn't exist yet or its ledger tables aren't in a
  recognized shape (run `control-schema.sql` for a true fresh install first).
- **To re-check an existing installation** beyond the metadata constraint, run the plan — its
  verifier fails closed on any other catalog drift rather than repairing it.
- **Not a migration.** Neither file is inside `db/migrations/`, so both are absent from the manifest
  and never applied by `migrate.sh`.

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
digests are accepted. The runner never invents identity. `MIGRATION_RUNNER_ID` is optional. Output
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
  accepted for legacy only. One exact prior history may retry: confirmed SQL failure followed by
  confirmed rollback, where migration id, manifest ordinal, execution mode, canonical filename, run
  id, source SHA, image digest, SQLSTATE, complete metadata, event sequence and statement ordinal all
  agree. A renamed filename never inherits retry permission. Historical events without filename
  identity, ambiguous or incomplete histories, connection loss, an operation-completed event without
  an applied row, and unknown `COMMIT` outcomes remain blocked for manual reconciliation. A
  wall-clock cancellation (confirmed or unverified) is never one of those retryable histories either:
  the payload's own internal `BEGIN`/`COMMIT` is opaque to the runner, so a cancellation can never be
  proven to have landed before or after it — no rollback is ever claimed, and the connection is
  always discarded rather than reused.
- **transactional** — `BEGIN`, `SET LOCAL` timeouts, migration SQL, the `schema_migrations` insert,
  `COMMIT`, all on the execution connection, so SQL and ledger row are atomic. Each of those
  operations receives only what remains of the migration's shared wall-clock budget, never a fresh
  allowance. A wall-clock timeout while still executing the migration statement is supervised the
  same way as nontransactional mode (see below): a confirmed cancellation is followed by an attempted
  `ROLLBACK`, and only a *proven* rollback records `transaction_rolled_back`/`execution_failed` and
  produces the wall-clock failure; an unproven rollback (it fails, or the cancellation itself was
  never confirmed) destroys the connection and fails closed as `cancellation_unverified` instead,
  never claiming rollback and never eligible for retry. A genuine (non-wall-clock) SQL failure keeps
  its pre-Phase-2b behaviour unchanged. Once `COMMIT` has actually been sent, its outcome is no
  longer treated as something the runner can safely resolve in either direction: no `sql_failed`, no
  `transaction_rolled_back`, no retry eligibility — the connection is simply discarded and the run
  fails closed as `cancellation_unverified`. This is a deliberate, narrower placeholder for full
  ambiguous-`COMMIT` reconciliation, which remains future (Phase 2c) work.
- **nontransactional** — one independently retry-safe operation, never wrapped in a transaction, with
  a migration-specific verifier that distinguishes absent / valid / invalid before and after.
  Absent executes; valid-but-unrecorded is adopted; invalid or partial requires explicit
  verifier-led recovery and is never blindly replayed. `inspectConcurrentIndex` provides that
  distinction for `CREATE INDEX CONCURRENTLY`. This is the mode the cancellation-confirmation state
  machine (`superviseOperation`, `backend/src/db/migrate/supervision.ts`) was originally built for:
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

Both handler registries in `backend/src/db/migrate/execute.ts` are empty: no migration above `0099`
exists yet, so `executeMigrations(pool)` itself never reaches batched or nontransactional mode with a
real handler. The batched-mode orchestration (`executeBatched`) lives in its own narrowly scoped
internal module, `backend/src/db/migrate/batched.ts` — imported by `execute.ts` for its own internal
use and never re-exported, exactly like `supervision.ts` — so it can still be exercised directly, with
a real PostgreSQL connection and a test-authored handler, bypassing `executeMigrations` entirely; see
`backend/test/migration-batched.test.ts` (deterministic) and `backend/test/migration-batched.pg.test.ts`
(real PostgreSQL). Nontransactional wall-clock behaviour is proven the same way, directly against
`superviseOperation` in `supervision.ts`.

### Events and timeouts

`migration_runs` stays INSERT-only. One run id per invocation, with `event_sequence` starting at 1 and
increasing. Events carry a SQLSTATE, a bounded error class and whitelisted metadata only — never SQL
bodies, query parameters, secrets, customer data or tenant identifiers.

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
one `Promise.race`-based supervision core (`superviseOperation`/`superviseCallback` in
`supervision.ts`), never a second, independent implementation.

Phase 2b intentionally does not implement, and this repository does not yet claim:
- full ambiguous-`COMMIT` classification/reconciliation once a timeout or connection failure occurs
  after `COMMIT` has actually been sent (transactional mode fails closed as `cancellation_unverified`
  instead — see above) — Phase 2c;
- pooled-session reset after a destroyed/discarded connection — Phase 2d;
- broader error and diagnostic sanitization beyond the fixed error-class vocabulary already
  enforced — Phase 2e.

Nothing in this step adopts a baseline or installs the control schema anywhere new.

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
