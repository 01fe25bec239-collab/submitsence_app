# db/orm — Drizzle query layer (database-first)

The SQL migrations in `../migrations/*.sql` are the **source of truth**. Drizzle never
authors DDL for this project — it only introspects the applied database into typed models,
and provides the per-request tenant-context helper the NestJS API uses.

## Install (in the NestJS API package)

```
npm i drizzle-orm pg
npm i -D drizzle-kit @types/pg
```

## Generate typed models from the live DB

Apply the SQL migrations first (see `../README.md`), then introspect:

```
DATABASE_URL=postgres://user:pass@host:5432/submitsense \
  npx drizzle-kit pull --config db/orm/drizzle.config.ts
```

Output lands in `db/orm/generated/`. Re-run after every SQL migration. `vector` columns
surface as a custom type; import `pgvector` types in queries as needed.

**Never** run `drizzle-kit push` or `generate` — they can't express RLS/triggers/functions
and would silently drift from the SQL migrations.

## Per-request usage

Connect the pool as the non-owner `submitsense_app` role (table owners bypass RLS), then wrap
every request/job in `withTenant`:

```ts
import { Pool } from "pg";
import { withTenant } from "./tenant-db";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// resolve Cognito sub -> users.cognito_sub -> user row (id, kind) upstream, then:
await withTenant(pool, { tenantId, userId, actorType: "human" }, async (db) => {
  // ...typed Drizzle queries; RLS scopes them to tenantId automatically
});
```

Moves into the NestJS app when it exists; kept here so the DB layer is self-contained.
