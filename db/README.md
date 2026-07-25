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

### Installing the control schema

The SQL lives at `db/control/control-schema.sql`. It sits under `db/`, so the existing migration
image (`backend/Dockerfile.migrations`, which already does `COPY db ./db`) carries it at
`/workspace/db/control/control-schema.sql` with no new deployment mechanism and no Dockerfile
change. The supported command, from the repository root or inside that image, is:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/control/control-schema.sql
```

- **Ownership.** Run it as the migration owner — the same role `infra/scripts/migrate.sh` uses. That
  role owns the schema, both tables, both functions, and the sequence, and is the only role able to
  INSERT. Do not install it as `submitsense_runtime` or any application login role.
- **`submitsense_app` prerequisite.** Not required. The role is normally created by
  `0001_extensions_helpers.sql`, but the installer skips its `REVOKE` statements when the role does
  not yet exist, so a bare database works. When the role is created later it receives no
  control-schema privileges, because nothing grants any. `runner.ts` verifies the absence either way
  via `to_regrole`.
- **Re-application.** The file is not idempotent by design. It runs as one transaction, so a second
  application fails closed with SQLSTATE `42P06` (`schema "migration_control" already exists`) and
  changes nothing. To re-check an existing installation, run the plan — its verifier fails closed on
  any catalog drift rather than repairing it.
- **Not a migration.** It is deliberately outside `db/migrations/`, so it is absent from the manifest
  and is never applied by `migrate.sh`. No persistent environment has it installed today.

### Rendering the plan

After installing on a disposable or approved target, render the deterministic JSON plan with:

```bash
npm run migrate:plan --prefix backend
```

The command validates the committed manifest, verifies the control-schema catalog, validates the
applied set as a manifest prefix, and reports pending migrations. It is read-only: it executes no
migration SQL and inserts no ledger or run-event rows. Current legacy checksums cannot prove which
historical bytes a persistent environment executed, and persistent environments have not been
baselined. `infra/scripts/migrate.sh` remains the production executor; migration execution in
`runner.ts` is intentionally not implemented in Step 2.

The plan also refuses to guess. `migrate.sh` records applied migrations in
`public.infrastructure_schema_migrations`, a ledger the control schema knows nothing about. If that
table exists with rows while `migration_control.schema_migrations` is empty, the environment was
migrated but never baselined, so the applied set is unknown rather than empty — the plan fails
closed instead of reporting all 24 migrations as pending. It never reads those rows, and never
copies them into the new ledger; baseline adoption is not implemented in Step 2.

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
