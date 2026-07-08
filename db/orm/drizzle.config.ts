import type { Config } from "drizzle-kit";

// Database-FIRST. The SQL migrations in db/migrations/*.sql are the source of truth
// (RLS, triggers, functions, pgvector, composite-FK tenant pinning). Drizzle is used
// only to INTROSPECT the applied database into typed models for the NestJS query layer:
//
//   DATABASE_URL=postgres://... npx drizzle-kit pull --config db/orm/drizzle.config.ts
//
// This writes db/orm/generated/schema.ts. Never run `drizzle-kit push`/`generate` against
// this DB — it cannot express the compliance layer and would drift from the SQL.
export default {
  dialect: "postgresql",
  out: "./db/orm/generated",
  schemaFilter: ["public"],
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
