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
for f in db/migrations/0*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

`0001`–`0014` build the schema, `0099_seed.sql` seeds roles/permissions/plans + a test fixture.
Run migrations as the **owner/superuser** role (it owns the tables and therefore bypasses RLS, which
is why seeding works). The runtime application connects as a different role — see below.

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
```

Proves the eight compliance guardrails fire (human-approval guard, cross-tenant match block,
append-only audit, RLS isolation, NATSPEC-copyright publish block). Prints `PASS n` lines; aborts on
any `FAIL`. The script rolls back, leaving the DB as seeded.

> Not executed in this environment (no local PostgreSQL). Run the two commands above against a live
> PG17 + pgvector instance to confirm end-to-end.

## Rollback strategy (req f30)

- **Failed apply** — every migration is wrapped in `BEGIN/COMMIT`; PostgreSQL DDL is transactional,
  so a failed file rolls itself back automatically. Fix and re-run.
- **Full baseline teardown** — `psql -f db/migrations/9999_teardown.down.sql` drops all tables, enum
  types, the `app` schema, and the two roles (extensions are left in place). Rebuild by re-running
  `0001`–`0099`.
- **Go-forward (post-baseline)** — once past this baseline, each new migration ships with a paired
  `NNNN_*.down.sql` that reverses only its own change. Baseline is treated as a single unit.

## Layout

```
db/
  migrations/   0001..0014 schema, 0099 seed, 9999 teardown
  test/         test_guardrails.sql — runnable compliance self-check
  docs/         ERD, table/enum docs, RLS, indexing, retention, queries, HANDOFF contract
```

Start with [docs/HANDOFF.md](docs/HANDOFF.md) for the contract handed to backend/auth/frontend/QA.
