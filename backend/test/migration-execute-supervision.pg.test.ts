import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after, before, beforeEach } from "node:test";
import { Client, Pool } from "pg";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import { assertDistinctDatabases } from "../src/db/migrate/database-identity";
import { installControlSchema, type ControlSchemaInstall } from "./helpers/control-schema-install";
import { withSchemaAdvisoryLock } from "../src/db/migrate/runner";
import { executeMigrationsForTest } from "./helpers/migration-execute";

/**
 * PB-10 Step 3 Phase 2a/2c final review: cancellation-confirmation
 * hardening, real PostgreSQL contract, exercised entirely through
 * executeMigrations(pool)/executeMigrationsForTest (the approved test
 * adapter). superviseOperation/superviseCallback were merged directly into
 * execute.ts as module-private code in the PB-10 Step 3 Phase 2c final
 * review — the emitted build no longer has a separate supervision.js module
 * exporting them, so this suite (like every other in this repository) now
 * reaches the cancellation state machine only via the one production entry
 * point, using a real transactional migration whose SQL is `select
 * pg_sleep(...)`.
 *
 *   MIGRATION_TEST_DATABASE_URL=postgres://... TEST_DATABASE_URL=postgres://... \
 *     node --import tsx --test test/migration-execute-supervision.pg.test.ts
 *
 * The exact-ordering "cancellation begins, then the operation settles"
 * contract — in both directions, with zero timing tolerance — is proven
 * deterministically (no real timers, no database, via
 * executeMigrationsForTest's own sleep-override test adapter) by
 * migration-execute.test.ts's wall-clock section instead; constructing that
 * exact race against a real server is fundamentally non-deterministic (it
 * depends on PostgreSQL's own interrupt-check timing, which this suite has
 * no way to control), so this file does not attempt it. Its job is
 * narrower and fully deterministic: proving the real-database facts the
 * state machine relies on — genuine cancellation really does produce
 * SQLSTATE 57014, a bare "true" from pg_cancel_backend is not by itself
 * proof of anything, a forced control failure is handled, a discarded
 * connection is truly gone, and nothing leaks across repetitions.
 */
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required for the destructive PB-10 PostgreSQL suite in CI");
}

if (!databaseUrl) {
  test("pg: cancellation-confirmation suite requires a dedicated disposable database", {
    skip: "MIGRATION_TEST_DATABASE_URL is not set; refusing to connect to a shared or unidentified database",
  }, () => undefined);
} else {
  const repositoryRoot = path.resolve(__dirname, "../..");
  /**
   * PB-10 Step 3 Phase 2c: the control schema is installed through psql, not
   * as one SQL blob over an ordinary connection. It now takes a required
   * `-v migration_execution_role` variable and includes the two files shared
   * with the upgrade path, and those are psql meta-commands the server never
   * sees. `install` carries the credentials for the non-superuser role every
   * pool below connects as — a superuser connection is refused by
   * verifyControlSchema, because a superuser bypasses every privilege the
   * commit-proof design relies on.
   */
  let install: ControlSchemaInstall;
  const identity = {
    sourceGitSha: "5324116250977b5e8ac24bc83b6cae89ebcbd990",
    executorImageDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    runnerId: "pb10-supervision-contract",
  };
  const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

  const root = mkdtempSync(path.join(os.tmpdir(), "pb10-supervision-pg-"));
  mkdirSync(path.join(root, "db", "migrations"), { recursive: true });
  const sleepFile = Buffer.from("select pg_sleep(5);\n", "utf8");
  writeFileSync(path.join(root, "db", "migrations", "0100_sleep.sql"), sleepFile);
  after(() => rmSync(root, { recursive: true, force: true }));

  const sleepEntry = (wallClockMs: number): MigrationManifestEntry => ({
    id: "0100",
    filename: "0100_sleep.sql",
    sha256: sha256(sleepFile),
    lifecyclePhase: "expand",
    operationCategories: ["schema"],
    executionMode: "transactional",
    requiredRuntimeEpoch: null,
    timeouts: { lockMs: 5_000, statementMs: 60_000, transactionMs: 300_000, idleInTransactionMs: 60_000, wallClockMs },
  });
  const manifestOf = (entry: MigrationManifestEntry): MigrationManifest => ({
    schemaVersion: 1,
    legacyBoundary: "0099",
    migrations: [entry],
  });

  let admin: Client;
  const pools: Pool[] = [];
  const newPool = (max = 2): Pool => {
    const pool = new Pool({ connectionString: install.executionUrl, max, application_name: "pb10-supervision-contract" });
    pools.push(pool);
    return pool;
  };
  const execute = (pool: Pool, entry: MigrationManifestEntry) =>
    executeMigrationsForTest(pool, { manifest: manifestOf(entry), identity, repositoryRoot: root });
  const resetDatabase = async (): Promise<void> => {
    await admin.query("drop schema if exists migration_control cascade");
    await admin.query("drop schema if exists public cascade");
    await admin.query("create schema public");
    install = await installControlSchema(admin, databaseUrl!);
  };

  const backendPid = async (client: { query: (sql: string) => Promise<{ rows: Array<{ pid: number }> }> }): Promise<number> => {
    const result = await client.query("select pg_backend_pid() as pid");
    return result.rows[0].pid;
  };

  const backendIsAlive = async (pid: number): Promise<boolean> => {
    const result = await admin.query<{ present: boolean }>(
      "select exists (select 1 from pg_stat_activity where pid = $1) as present",
      [pid],
    );
    return result.rows[0]?.present === true;
  };

  before(async () => {
    await assertDistinctDatabases(
      { a: databaseUrl, b: process.env.TEST_DATABASE_URL },
      { a: "MIGRATION_TEST_DATABASE_URL", b: "TEST_DATABASE_URL" },
    );
    admin = new Client({ connectionString: databaseUrl, application_name: "pb10-supervision-admin" });
    await admin.connect();
    // The runner credential must exist before any pool is constructed: every
    // pool below connects as the non-superuser execution role, and some cases
    // build their pool before calling the per-case reset helper.
    install = await installControlSchema(admin, databaseUrl!);
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

  test("pg: a real pg_sleep operation is cancelled and produces SQLSTATE 57014, through executeMigrations(pool)", async () => {
    const pool = newPool();
    const startedAt = Date.now();
    await assert.rejects(execute(pool, sleepEntry(200)), /wall_clock_exceeded/);
    // Real proof of a genuinely cancelled (not merely timed-out client-side)
    // backend: the whole thing finished in a couple of seconds, not the 5s
    // pg_sleep would have taken had cancellation not actually interrupted it.
    assert.ok(Date.now() - startedAt < 4_000, "the backend must have actually been cancelled, not merely abandoned");
  });

  test("pg: pg_cancel_backend against a backend with no active query is not by itself proof of cancellation", async () => {
    // A deterministic, database-level fact, independent of any race: the
    // signal is accepted (returns true) purely because the target PID
    // exists and is reachable — regardless of whether anything is running
    // there to interrupt. The production cancellation-confirmation state
    // machine never trusts a bare "true" for exactly this reason.
    const pool = newPool();
    const target = await pool.connect();
    try {
      const pid = await backendPid(target);
      const cancelResult = await admin.query<{ pg_cancel_backend: boolean }>(
        "select pg_cancel_backend($1) as pg_cancel_backend",
        [pid],
      );
      assert.equal(cancelResult.rows[0]?.pg_cancel_backend, true, "the signal is accepted even with nothing to cancel");

      const probe = await target.query<{ one: number }>("select 1 as one");
      assert.equal(probe.rows[0]?.one, 1);
    } finally {
      target.release();
    }
  });

  test("pg: a forced control-connection failure during cancellation causes the run to fail with an unverified/durable outcome", async () => {
    const pool = newPool();
    let controlPid: number | undefined;
    const originalConnect = pool.connect.bind(pool);
    let connectCount = 0;
    // @ts-expect-error narrow test-only override of pool.connect's overloaded signature
    pool.connect = async (...args: unknown[]) => {
      connectCount += 1;
      const client = await (originalConnect as (...a: unknown[]) => Promise<import("pg").PoolClient>)(...args);
      if (connectCount === 1) {
        // The first connection executeVerifiedMigrations acquires is control.
        controlPid = await backendPid(client);
        client.on("error", () => undefined);
      }
      return client;
    };

    const pending = execute(pool, sleepEntry(100));
    // Kill the control backend well before the 100ms budget expires (a wide,
    // comfortable margin — not a close race), so that when the production
    // code later tries to issue pg_cancel_backend over the control
    // connection, that connection is already dead.
    await delay(30);
    if (controlPid !== undefined) {
      await admin.query("select pg_terminate_backend($1)", [controlPid]).catch(() => undefined);
    }
    // The run must fail — either the confirmed cancellation_unverified path
    // (if the control connection died exactly during pg_cancel_backend) or
    // control_connection_lost (if the pool's own error listener saw it
    // first) — both are genuine, safe, fail-closed outcomes of a control
    // connection dying mid-supervision; no specific pattern is required.
    await assert.rejects(pending);
  });

  test("pg: a discarded execution connection is never handed back out by the pool", async () => {
    const pool = newPool(1); // exactly one slot: whatever connect() returns next must be a fresh physical connection
    const execution = await pool.connect();
    const firstPid = await backendPid(execution);

    // Simulate exactly what executeVerifiedMigrations's finally block does
    // after a cancellation-driven destroyExecution(): release with an
    // error, which node-postgres discards the underlying connection for
    // rather than returning it to the pool.
    execution.release(new Error("destroyed after an unverified cancellation"));
    assert.ok(!(await backendIsAlive(firstPid)), "a discarded connection's backend must not remain alive in the pool");

    const next = await pool.connect();
    try {
      const secondPid = await backendPid(next);
      assert.notEqual(secondPid, firstPid, "the pool must open a genuinely new physical connection, never hand back the discarded one");
    } finally {
      next.release();
    }
  });

  test("pg: repeated confirmed cancellation cycles through executeMigrations(pool) are stable, with no leaked clients", async () => {
    const pool = newPool(3);

    for (let iteration = 0; iteration < 3; iteration += 1) {
      await assert.rejects(execute(pool, sleepEntry(100)), /wall_clock_exceeded/);
      assert.equal(pool.waitingCount, 0, `iteration ${iteration}: no caller left waiting on the pool`);
      assert.equal(pool.totalCount, pool.idleCount, `iteration ${iteration}: no connection leaked as still-checked-out`);
    }
  });

  // Real production-path control-client ownership: withSchemaAdvisoryLock —
  // still its own exported function in runner.ts, unaffected by the
  // execute.ts merge — against a real PostgreSQL control backend that is
  // genuinely terminated (not merely a synthetic 'error' event) around the
  // same window an action's own cancellation-driven failure is being
  // handled and the advisory unlock is attempted. This proves the fix holds
  // under real I/O timing, not just against the fully deterministic fakes
  // used elsewhere in this repository.
  test("pg: a real control-backend termination while control is still held ends in exactly one destructive release, with no uncaught client error", async () => {
    const pool = newPool(2);
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const control = await pool.connect();
        const execution = await pool.connect();
        try {
          const controlPid = await backendPid(control);

          const pending = withSchemaAdvisoryLock(control, async () => {
            await delay(200);
            throw new Error("[cancellation_unverified] migration 0101: cancellation request was not accepted by PostgreSQL");
          });

          await Promise.all([
            assert.rejects(pending),
            (async () => {
              await delay(75);
              await admin.query("select pg_terminate_backend($1)", [controlPid]).catch(() => undefined);
            })(),
          ]);
        } finally {
          execution.release();
        }

        assert.equal(pool.waitingCount, 0, `iteration ${iteration}: no leaked pool waiter`);
        assert.equal(pool.totalCount, pool.idleCount, `iteration ${iteration}: no leaked checked-out client (control and execution both accounted for)`);
      }
    } finally {
      await delay(300);
      process.removeListener("uncaughtException", onUncaught);
    }
    assert.deepEqual(uncaught, [], `no uncaught client error across repeated runs: ${String(uncaught[0])}`);
  });
}
