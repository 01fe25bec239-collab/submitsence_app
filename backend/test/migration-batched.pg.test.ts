import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after, before, beforeEach } from "node:test";
import { Client, Pool, type PoolClient } from "pg";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import { MigrationExecutionError, type BatchedContext, type BatchedHandler } from "../src/db/migrate/execute";
import { assertDistinctDatabases } from "../src/db/migrate/database-identity";
import { executeBatched } from "../src/db/migrate/batched";
import { RunLog, type MigrationContext } from "../src/db/migrate/execution-context";

/**
 * PB-10 Step 3 Phase 2b: real-PostgreSQL contract for the batched-mode wall-
 * clock supervision — the required case migration-execute-wallclock.pg.test.ts
 * deliberately could not cover, since batched mode needs a registered
 * BatchedHandler and registeredHandlers in execute.ts is hardcoded empty
 * until a real migration above the legacy boundary exists.
 *
 * This suite calls executeBatched (backend/src/db/migrate/batched.ts) — the
 * exact function execute.ts imports and calls — directly, with a real
 * PostgreSQL Pool and a test-authored BatchedHandler, the same way
 * migration-execute-supervision.pg.test.ts calls superviseOperation
 * directly. It still installs the real migration_control schema, because
 * executeBatched writes real migration_runs/schema_migrations rows on the
 * control connection exactly as it does in production.
 *
 *   MIGRATION_TEST_DATABASE_URL=postgres://... TEST_DATABASE_URL=postgres://... \
 *     node --import tsx --test test/migration-batched.pg.test.ts
 *
 * Wide deterministic timing margins throughout — real pg_sleep durations
 * always much larger than the declared budgets, budgets always much larger
 * than local round-trip time — never a race decided by which of two close
 * timings wins.
 */
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required for the destructive PB-10 Phase 2b batched PostgreSQL suite in CI");
}

if (!databaseUrl) {
  test("pg: batched wall-clock supervision suite requires a dedicated disposable database", {
    skip: "MIGRATION_TEST_DATABASE_URL is not set; refusing to drop schemas in a shared or unidentified database",
  }, () => undefined);
} else {
  const identity = {
    sourceGitSha: "5324116250977b5e8ac24bc83b6cae89ebcbd990",
    executorImageDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    runnerId: "pb10-batched-pg-contract",
  };
  const realSleep = (milliseconds: number): Promise<void> => delay(milliseconds, undefined, { ref: false });

  const entryFor = (wallClockMs: number): MigrationManifestEntry => ({
    id: "0102",
    filename: "0102_backfill_demo.sql",
    sha256: "0".repeat(64),
    lifecyclePhase: "backfill",
    operationCategories: ["data-correction"],
    executionMode: "batched",
    requiredRuntimeEpoch: null,
    timeouts: { lockMs: 5_000, statementMs: 60_000, transactionMs: 300_000, idleInTransactionMs: 60_000, wallClockMs },
  });
  const manifestOf = (entry: MigrationManifestEntry): MigrationManifest => ({
    schemaVersion: 1,
    legacyBoundary: "0099",
    migrations: [entry],
  });
  const handlerOf = (batches: Array<(client: PoolClient) => Promise<void>>): BatchedHandler => ({
    execute: async (batchContext: BatchedContext) => {
      for (const batch of batches) await batchContext.runBatch(batch);
    },
    verifyComplete: async () => true,
  });

  let admin: Client;
  const pools: Pool[] = [];
  const newPool = (max = 3): Pool => {
    const pool = new Pool({ connectionString: databaseUrl, max, application_name: "pb10-batched-contract" });
    pools.push(pool);
    return pool;
  };

  const count = async (relation: string): Promise<number> => {
    const result = await admin.query<{ total: string }>(`select count(*)::text as total from ${relation}`);
    return Number(result.rows[0].total);
  };

  const repositoryRoot = path.resolve(__dirname, "../..");
  const controlSchemaSql = readFileSync(path.join(repositoryRoot, "db", "control", "control-schema.sql"), "utf8");

  const resetDatabase = async (): Promise<void> => {
    await admin.query("drop schema if exists migration_control cascade");
    await admin.query("drop schema if exists public cascade");
    await admin.query("create schema public");
    await admin.query(controlSchemaSql);
    await admin.query("create table public.demo (id integer primary key)");
  };

  const backendPid = async (client: { query: (sql: string) => Promise<{ rows: Array<{ pid: number }> }> }): Promise<number> => {
    const result = await client.query("select pg_backend_pid() as pid");
    return result.rows[0].pid;
  };

  /** Builds a real MigrationContext against two freshly connected pool clients. */
  const buildContext = async (
    pool: Pool,
    entry: MigrationManifestEntry,
    handler: BatchedHandler,
  ): Promise<{ context: MigrationContext; control: PoolClient; execution: PoolClient; destroyed: () => boolean }> => {
    const control = await pool.connect();
    const execution = await pool.connect();
    // A fresh run id per call: migration_runs enforces uniqueness on
    // (run_id, event_sequence), and a shared literal would collide across
    // repeated buildContext calls in the same test database.
    const runLog = new RunLog(control, randomUUID(), identity, manifestOf(entry));
    let destroyed = false;
    const context: MigrationContext = {
      entry,
      ordinal: 1,
      bytes: Buffer.from(""),
      checksum: "0".repeat(64),
      control,
      execution,
      runLog,
      identity,
      handlers: { nontransactional: new Map(), batched: new Map([[entry.id, handler]]) },
      sleep: realSleep,
      now: Date.now,
      destroyExecution: () => { destroyed = true; },
    };
    return { context, control, execution, destroyed: () => destroyed };
  };

  before(async () => {
    await assertDistinctDatabases(
      { a: databaseUrl, b: process.env.TEST_DATABASE_URL },
      { a: "MIGRATION_TEST_DATABASE_URL", b: "TEST_DATABASE_URL" },
    );
    admin = new Client({ connectionString: databaseUrl, application_name: "pb10-batched-admin" });
    await admin.connect();
  });

  after(async () => {
    if (admin === undefined) return;
    await Promise.all(pools.map((pool) => pool.end()));
    await resetDatabase();
    await admin.end();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  test("pg: several individually short real batches cumulatively exceed one shared migration wall-clock budget; the next batch is never started", async () => {
    const pool = newPool();
    const entry = entryFor(1_600); // 1.6s aggregate budget
    let batch4Invoked = false;
    const handler = handlerOf([
      async (client) => {
        await client.query("insert into demo values (1)");
        await client.query("select pg_sleep(0.6)");
      },
      async (client) => {
        await client.query("insert into demo values (2)");
        await client.query("select pg_sleep(0.6)");
      },
      async (client) => {
        await client.query("insert into demo values (3)");
        await client.query("select pg_sleep(0.6)");
      },
      async () => { batch4Invoked = true; },
    ]);
    const { context, control, execution } = await buildContext(pool, entry, handler);
    try {
      const startedAt = Date.now();
      await assert.rejects(
        executeBatched(context),
        (error: unknown) => error instanceof MigrationExecutionError
          && error.errorClass === "wall_clock_exceeded"
          && error.sqlstate === "57014",
      );
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 3_000, `expected the shared budget to cut this off well under 3s, took ${elapsedMs}ms`);
      assert.equal(batch4Invoked, false, "the fourth batch must never start after the shared deadline cancels batch 3");
      assert.equal(await count("public.demo"), 2, "the first two batches stay committed; the cancelled third batch rolls back");

      const events = await admin.query<{ event_type: string; sqlstate: string | null; metadata: { batch_number?: number } }>(
        "select event_type, sqlstate, metadata from migration_control.migration_runs order by event_sequence",
      );
      assert.deepEqual(
        events.rows.filter(({ event_type }) => event_type === "operation_completed").map(({ metadata }) => metadata.batch_number),
        [1, 2],
      );
      const rolledBack = events.rows.filter(({ event_type }) => event_type === "transaction_rolled_back");
      assert.equal(rolledBack.length, 1);
      assert.equal(rolledBack[0].metadata.batch_number, 3);
      assert.equal(rolledBack[0].sqlstate, "57014");
    } finally {
      control.release();
      execution.release();
    }
  });

  test("pg: the active batch is cancelled using the accepted SQLSTATE 57014 confirmation rule", async () => {
    const pool = newPool();
    const entry = entryFor(200);
    const handler = handlerOf([async (client) => { await client.query("select pg_sleep(5)"); }]);
    const { context, control, execution } = await buildContext(pool, entry, handler);
    try {
      const startedAt = Date.now();
      await assert.rejects(
        executeBatched(context),
        (error: unknown) => error instanceof MigrationExecutionError
          && error.errorClass === "wall_clock_exceeded"
          && error.sqlstate === "57014",
      );
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 3_000, `expected genuine cancellation well under the full 5s pg_sleep, took ${elapsedMs}ms`);
    } finally {
      control.release();
      execution.release();
    }
  });

  test("pg: already-committed prior batches remain committed and are never reported as rolled back", async () => {
    const pool = newPool();
    const entry = entryFor(300);
    const handler = handlerOf([
      async (client) => { await client.query("insert into demo values (1)"); },
      async (client) => { await client.query("select pg_sleep(5)"); },
    ]);
    const { context, control, execution } = await buildContext(pool, entry, handler);
    try {
      await assert.rejects(executeBatched(context), /wall_clock_exceeded/);
      // Proven from a fresh connection, not the (about-to-be-released)
      // execution client itself.
      assert.equal(await count("public.demo"), 1, "the first batch's committed insert must survive the second batch's cancellation");

      const events = await admin.query<{ event_type: string; metadata: { batch_number?: number } }>(
        "select event_type, metadata from migration_control.migration_runs order by event_sequence",
      );
      const rolledBack = events.rows.filter(({ event_type }) => event_type === "transaction_rolled_back");
      assert.equal(rolledBack.length, 1, "exactly one batch is reported rolled back");
      assert.equal(rolledBack[0].metadata.batch_number, 2, "only the second (cancelled) batch is ever described as rolled back");
    } finally {
      control.release();
      execution.release();
    }
  });

  test("pg: an unverified cancellation (forced control failure) discards the execution client, which the pool never hands back out", async () => {
    // Two slots: buildContext needs control and execution simultaneously.
    // "Never handed back" is still proven below purely by PID inequality —
    // the discarded connection is physically terminated, so no pool-size
    // constraint is needed to force a fresh connection to prove it.
    const pool = newPool(2);
    const entry = entryFor(1_000);
    let batchStarted!: () => void;
    const started = new Promise<void>((resolve) => { batchStarted = resolve; });
    const handler = handlerOf([async (client) => {
      batchStarted();
      await client.query("select pg_sleep(5)");
    }]);
    const { context, control, execution, destroyed } = await buildContext(pool, entry, handler);
    control.on("error", () => undefined);
    const executionPid = await backendPid(execution);
    try {
      const controlPid = await backendPid(control);
      const pending = executeBatched(context);
      // Kill the control backend only after the real batch callback has
      // started, but well before the 1s budget expires, so that when executeBatched later tries
      // to issue pg_cancel_backend over `control`, that connection is
      // already dead and the request itself fails — the unverified path.
      await started;
      await admin.query("select pg_terminate_backend($1)", [controlPid]);
      // Killing the control connection also breaks the outer event-recording
      // append that follows the cancellation_unverified throw (the same dead
      // connection RunLog.append writes through), so the rejection surfaces
      // as that append's own connection error rather than the original
      // cancellation_unverified message — recovering gracefully from a
      // simultaneously-dead control connection belongs to the outer run
      // loop's onControlError handling (executeVerifiedMigrations), already
      // covered by "loss of the control connection aborts execution and
      // destroys the execution client" in migration-execute.test.ts, not to
      // executeBatched itself. What this test proves is narrower and
      // unambiguous: destroyExecution fires, and the discarded connection is
      // never handed back out by the pool.
      await assert.rejects(pending);
      assert.equal(destroyed(), true, "destroyExecution must fire for an unverified cancellation");
    } finally {
      control.release(new Error("control backend was terminated by this test"));
      execution.release(new Error("execution left mid pg_sleep after an unverified cancellation"));
    }

    // The execution backend is still genuinely mid pg_sleep(5) here — since
    // the control connection died before pg_cancel_backend was ever issued,
    // nothing ever asked PostgreSQL to interrupt it, and a closed client
    // socket alone does not interrupt an in-progress pg_sleep (the backend
    // has no I/O to notice the disconnect on until the sleep itself
    // completes), so asserting its immediate death would be timing-fiction,
    // not a real guarantee this code makes. What the "discarded" contract
    // actually promises — the only guarantee unverified() gives — is that
    // the pool never hands that connection back out for reuse, proven next.
    const next = await pool.connect();
    try {
      const nextPid = await backendPid(next);
      assert.notEqual(nextPid, executionPid, "the pool must open a genuinely new physical connection, never hand back the discarded one");
    } finally {
      next.release();
    }
  });

  test("pg: repeated confirmed-cancellation runs leave pool waitingCount at 0 and totalCount equal to idleCount", async () => {
    const pool = newPool(3);
    const entry = entryFor(200);

    for (let iteration = 0; iteration < 3; iteration += 1) {
      const handler = handlerOf([async (client) => { await client.query("select pg_sleep(5)"); }]);
      const { context, control, execution } = await buildContext(pool, entry, handler);
      try {
        await assert.rejects(executeBatched(context), /wall_clock_exceeded/);
      } finally {
        control.release();
        execution.release();
      }
      assert.equal(pool.waitingCount, 0, `iteration ${iteration}: no caller left waiting on the pool`);
      assert.equal(pool.totalCount, pool.idleCount, `iteration ${iteration}: no connection leaked as still checked out`);
    }
  });
}
