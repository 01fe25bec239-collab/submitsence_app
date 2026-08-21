import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Pool } from "pg";
import { executeMigrations } from "../src/db/migrate/execute";
import { SCHEMA_ADVISORY_LOCK, runMigrationPlan, type LockDiagnostic } from "../src/db/migrate/runner";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("MIGRATION_TEST_DATABASE_URL is required for the Phase 2e PostgreSQL sanitization suite in CI");

test("phase2e pg: a real PostgreSQL ErrorResponse is sanitized at executeMigrations", { skip: databaseUrl ? false : "MIGRATION_TEST_DATABASE_URL is not set" }, async () => {
  const target = new URL(databaseUrl!);
  const databaseCanary = "phase2e_missing_database_canary";
  target.pathname = `/${databaseCanary}`;
  const pool = new Pool({ connectionString: target.toString(), connectionTimeoutMillis: 2_000 });
  const previous = {
    source: process.env.MIGRATION_SOURCE_GIT_SHA,
    digest: process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST,
    runner: process.env.MIGRATION_RUNNER_ID,
  };
  process.env.MIGRATION_SOURCE_GIT_SHA = "5324116250977b5e8ac24bc83b6cae89ebcbd990";
  process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
  process.env.MIGRATION_RUNNER_ID = "pb10-phase2e-pg";
  try {
    await assert.rejects(executeMigrations(pool), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Migration execution failed");
      assert.equal((error as Error & { code?: string }).code, "PB10_MIGRATION_EXECUTION_FAILED");
      assert.equal(error.stack, undefined);
      assert.doesNotMatch(`${error.name}: ${error.message}`, new RegExp(databaseCanary));
      assert.doesNotMatch(`${error.name}: ${error.message}`, /postgres(?:ql)?:\/\/|password|host|certificate|\n\s*at /i);
      return true;
    });
  } finally {
    await pool.end();
    if (previous.source === undefined) delete process.env.MIGRATION_SOURCE_GIT_SHA; else process.env.MIGRATION_SOURCE_GIT_SHA = previous.source;
    if (previous.digest === undefined) delete process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST; else process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = previous.digest;
    if (previous.runner === undefined) delete process.env.MIGRATION_RUNNER_ID; else process.env.MIGRATION_RUNNER_ID = previous.runner;
  }
});

test("phase2e pg: real PostgreSQL query text and driver fields never cross the application boundary", { skip: databaseUrl ? false : "MIGRATION_TEST_DATABASE_URL is not set" }, async () => {
  const sqlCanary = "select phase2e_sql_canary from phase2e_secret_relation";
  const realPool = new Pool({ connectionString: databaseUrl!, application_name: "pb10-phase2e-pg" });
  class QueryFailingPool extends EventEmitter {
    async connect(): Promise<never> {
      const client = await realPool.connect();
      try {
        await client.query(sqlCanary);
        throw new Error("the canary query unexpectedly succeeded");
      } finally {
        client.release();
      }
    }
  }
  process.env.MIGRATION_SOURCE_GIT_SHA = "5324116250977b5e8ac24bc83b6cae89ebcbd990";
  process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
  process.env.MIGRATION_RUNNER_ID = "pb10-phase2e-pg";
  try {
    await assert.rejects(executeMigrations(new QueryFailingPool() as unknown as Pool), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Migration execution failed");
      assert.equal((error as Error & { code?: string }).code, "PB10_MIGRATION_EXECUTION_FAILED");
      assert.equal(error.stack, undefined);
      assert.doesNotMatch(`${error.name}: ${error.message}`, /phase2e_sql_canary|phase2e_secret_relation|query|detail|schema|table|\n\s*at /i);
      return true;
    });
  } finally {
    await realPool.end();
  }
});

test("phase2e pg: a real PostgreSQL ErrorResponse is sanitized at public runMigrationPlan", { skip: databaseUrl ? false : "MIGRATION_TEST_DATABASE_URL is not set" }, async () => {
  const target = new URL(databaseUrl!);
  const databaseCanary = "phase2e_plan_missing_database_canary";
  target.pathname = `/${databaseCanary}`;
  const pool = new Pool({ connectionString: target.toString(), connectionTimeoutMillis: 2_000 });
  try {
    await assert.rejects(runMigrationPlan(pool, { manifest: { schemaVersion: 1, legacyBoundary: "0099", migrations: [] } }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Migration plan failed");
      assert.equal((error as Error & { code?: string }).code, "PB10_MIGRATION_PLAN_FAILED");
      assert.equal(error.stack, undefined);
      assert.doesNotMatch(`${error.name}: ${error.message}`, new RegExp(databaseCanary));
      assert.doesNotMatch(`${error.name}: ${error.message}`, /postgres(?:ql)?:\/\/|password|host|certificate|\n\s*at /i);
      return true;
    });
  } finally {
    await pool.end();
  }
});

/**
 * PB-10 Step 3 Phase 2e, A4 round 2, MEDIUM. The fake-pool contention tests
 * hand the sanitizer strings; real node-postgres decodes a PostgreSQL interval
 * into an object, which the allowlist refuses — so against a real database
 * both ages were silently null and the operator lost the only bounded,
 * non-sensitive duration signal contention diagnostics carry. This holds the
 * schema advisory lock on a genuinely idle-in-transaction backend and proves
 * the ages arrive as short text, through the real driver, without widening
 * the allowlist by a single field.
 */
test("phase2e pg: advisory-lock contention ages cross the diagnostic allowlist as bounded text", { skip: databaseUrl ? false : "MIGRATION_TEST_DATABASE_URL is not set" }, async () => {
  const holderPool = new Pool({ connectionString: databaseUrl!, application_name: "pb10-phase2e-lock-holder" });
  const planPool = new Pool({ connectionString: databaseUrl!, max: 1, application_name: "pb10-phase2e-plan" });
  const holder = await holderPool.connect();
  try {
    // An open transaction, deliberately: xact_start is null outside one, and
    // a null transaction_age would make this test pass for the wrong reason.
    await holder.query("begin");
    const holderPid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    // Last, so pg_stat_activity.query is the lock statement itself and the
    // command_summary classification below is exercised rather than defaulted.
    await holder.query("select pg_advisory_lock($1, $2)", [...SCHEMA_ADVISORY_LOCK]);

    const seen: LockDiagnostic[] = [];
    await assert.rejects(runMigrationPlan(planPool, {
      manifest: { schemaVersion: 1, legacyBoundary: "0099", migrations: [] },
      pollMs: 10,
      budgetMs: 10,
      diagnose: (holders) => { seen.push(...holders); },
    }), (error: unknown) => error instanceof Error && error.message === "Migration plan failed");

    const observed = seen.filter((entry) => entry.holder_pid === holderPid);
    assert.ok(observed.length > 0, "the contention query never saw the real lock holder");
    for (const entry of observed) {
      for (const age of [entry.transaction_age, entry.query_age]) {
        assert.equal(typeof age, "string");
        assert.match(age!, /^[0-9: .+-]{1,40}$/);
      }
      assert.equal(entry.application_name, null);
      assert.equal(entry.client_identity, null);
      assert.equal(entry.command_summary, "advisory-lock command");
      assert.doesNotMatch(JSON.stringify(entry), /pg_advisory_lock|pb10-phase2e-lock-holder|postgres(?:ql)?:\/\//);
    }
  } finally {
    await holder.query("rollback").catch(() => undefined);
    holder.release();
    await holderPool.end();
    await planPool.end();
  }
});
