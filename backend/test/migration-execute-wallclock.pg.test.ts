import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { Client, Pool } from "pg";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import { assertDistinctDatabases } from "../src/db/migrate/database-identity";
import { executeMigrationsForTest } from "./helpers/migration-execute";

/**
 * PB-10 Step 3 Phase 2b: whole-migration wall-clock supervision, real
 * PostgreSQL contract. Registered only when a disposable target is
 * supplied, matching migration-execute.pg.test.ts's own gating exactly.
 *
 *   MIGRATION_TEST_DATABASE_URL=postgres://... TEST_DATABASE_URL=postgres://... \
 *     node --import tsx --test test/migration-execute-wallclock.pg.test.ts
 *
 * Every case drops and reinstalls migration_control, so the target must be
 * disposable, and TEST_DATABASE_URL is required (not used for writes here)
 * purely so assertDistinctDatabases can prove it differs from
 * MIGRATION_TEST_DATABASE_URL before anything destructive runs — the same
 * safety precondition migration-execute.pg.test.ts already requires,
 * because this file, like that one, installs and drops migration_control.
 *
 * Deliberately narrow, with wide deterministic timing margins (never a race
 * decided by which of two close timings wins) — real pg_sleep durations that
 * are always much larger than the declared wall-clock budgets, and budgets
 * that are always much larger than the local round-trip time of the
 * verification/BEGIN/SET LOCAL steps that precede the supervised statement.
 *
 * Batched-mode wall-clock enforcement is NOT covered here: this file drives
 * everything through executeMigrations(pool)/executeMigrationsForTest, and
 * registeredHandlers in execute.ts is deliberately hardcoded empty until a
 * real migration above the legacy boundary exists (see db/README.md), so
 * batched mode is unreachable through that entry point. It has its own
 * dedicated real-PostgreSQL suite instead — migration-batched.pg.test.ts —
 * which calls executeBatched (backend/src/db/migrate/batched.ts) directly
 * with a test-authored handler, the same production function execute.ts
 * itself calls.
 */
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required for the destructive PB-10 Phase 2b PostgreSQL suite in CI");
}

if (!databaseUrl) {
  test("pg: wall-clock supervision suite requires a dedicated disposable database", {
    skip: "MIGRATION_TEST_DATABASE_URL is not set; refusing to drop schemas in a shared or unidentified database",
  }, () => undefined);
} else {
  const repositoryRoot = path.resolve(__dirname, "../..");
  const controlSchemaSql = readFileSync(path.join(repositoryRoot, "db", "control", "control-schema.sql"), "utf8");

  const identity = {
    sourceGitSha: "5324116250977b5e8ac24bc83b6cae89ebcbd990",
    executorImageDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    runnerId: "pb10-wallclock-contract",
  };
  const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

  const root = mkdtempSync(path.join(os.tmpdir(), "pb10-wallclock-pg-"));
  mkdirSync(path.join(root, "db", "migrations"), { recursive: true });

  // Every statement individually finishes in ~300ms, comfortably inside a
  // generous 60s statementMs — only the shared wall-clock budget (below)
  // can catch their sum.
  const files: Record<string, Buffer> = {
    "0001_legacy_setup.sql": Buffer.from(
      "begin;\r\ncreate table demo (id integer primary key);\r\ncommit;\n",
      "utf8",
    ),
    "0100_cumulative_statements.sql": Buffer.from(
      [
        "insert into demo values (1);",
        "select pg_sleep(0.3);",
        "insert into demo values (2);",
        "select pg_sleep(0.3);",
        "insert into demo values (3);",
        "select pg_sleep(0.3);",
        "insert into demo values (4);",
      ].join("\n"),
      "utf8",
    ),
    "0101_single_sleep.sql": Buffer.from("select pg_sleep(5);\n", "utf8"),
    "0102_legacy_sleep.sql": Buffer.from(
      "begin;\r\ninsert into demo values (101);\r\nselect pg_sleep(5);\r\ninsert into demo values (102);\r\ncommit;\n",
      "utf8",
    ),
  };
  for (const [filename, bytes] of Object.entries(files)) {
    writeFileSync(path.join(root, "db", "migrations", filename), bytes);
  }
  after(() => rmSync(root, { recursive: true, force: true }));

  const entry = (
    id: string,
    filename: string,
    executionMode: MigrationManifestEntry["executionMode"],
    wallClockMs: number,
    timeoutOverrides: Partial<MigrationManifestEntry["timeouts"]> = {},
  ): MigrationManifestEntry => ({
    id,
    filename,
    sha256: sha256(files[filename]),
    lifecyclePhase: "expand",
    operationCategories: ["schema"],
    executionMode,
    requiredRuntimeEpoch: null,
    timeouts: { lockMs: 5_000, statementMs: 60_000, transactionMs: 300_000, idleInTransactionMs: 60_000, wallClockMs, ...timeoutOverrides },
  });

  const legacySetup = entry("0001", "0001_legacy_setup.sql", "legacy-verbatim", 900_000);
  const manifestOf = (...migrations: MigrationManifestEntry[]): MigrationManifest => ({
    schemaVersion: 1,
    legacyBoundary: "0099",
    migrations,
  });

  let admin: Client;
  const pools: Pool[] = [];
  const newPool = (max = 3): Pool => {
    const pool = new Pool({ connectionString: databaseUrl, max, application_name: "pb10-wallclock-contract" });
    pools.push(pool);
    return pool;
  };
  const execute = (pool: Pool, manifest: MigrationManifest) =>
    executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: root });
  const count = async (relation: string): Promise<number> => {
    const result = await admin.query<{ total: string }>(`select count(*)::text as total from ${relation}`);
    return Number(result.rows[0].total);
  };
  const resetDatabase = async (): Promise<void> => {
    await admin.query("drop schema if exists migration_control cascade");
    await admin.query("drop schema if exists public cascade");
    await admin.query("create schema public");
    await admin.query(controlSchemaSql);
  };

  before(async () => {
    // Must run before any connection is opened or any query issued: this
    // suite drops and recreates schemas every test.
    await assertDistinctDatabases(
      { a: databaseUrl, b: process.env.TEST_DATABASE_URL },
      { a: "MIGRATION_TEST_DATABASE_URL", b: "TEST_DATABASE_URL" },
    );
    admin = new Client({ connectionString: databaseUrl, application_name: "pb10-wallclock-admin" });
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

  // Establishes the demo table every case after this one builds on.
  const setup = async (pool: Pool): Promise<void> => {
    await execute(pool, manifestOf(legacySetup));
  };

  test("pg: several individually short transactional statements cumulatively exceed one shared wall-clock budget", async () => {
    const pool = newPool();
    await setup(pool);

    // Each pg_sleep(0.3) is 300ms; three of them plus four inserts total
    // roughly 900ms+ of real execution — comfortably over a 500ms wall-clock
    // budget, even though every individual statement is nowhere near its own
    // 60s statementMs ceiling.
    const cumulative = entry("0100", "0100_cumulative_statements.sql", "transactional", 500);
    const startedAt = Date.now();
    await assert.rejects(execute(pool, manifestOf(legacySetup, cumulative)), /wall_clock_exceeded/);
    const elapsedMs = Date.now() - startedAt;

    // Real proof of genuine cancellation, not merely waiting out the full
    // ~900ms+ of sleeps: comfortably bounded well under that.
    assert.ok(elapsedMs < 3_000, `expected genuine cancellation well under 3s, took ${elapsedMs}ms`);
    // Confirmed cancellation plus confirmed rollback: no payload writes survive.
    assert.equal(await count("public.demo"), 0, "no partial inserts from the cancelled transaction may remain visible");
    assert.equal(await count("migration_control.schema_migrations"), 1, "only the legacy setup migration is recorded as applied");
  });

  test("pg: transactional pg_sleep is cancelled with SQLSTATE 57014 and the confirmed rollback leaves no payload writes", async () => {
    const pool = newPool();
    await setup(pool);

    const sleepy = entry("0101", "0101_single_sleep.sql", "transactional", 200);
    const startedAt = Date.now();
    await assert.rejects(execute(pool, manifestOf(legacySetup, sleepy)), /wall_clock_exceeded/);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 3_000, `expected genuine cancellation well under the full 5s pg_sleep, took ${elapsedMs}ms`);
    assert.equal(await count("migration_control.schema_migrations"), 1);
  });

  test("pg: legacy-verbatim pg_sleep is cancelled; the discarded connection leaves no partial payload writes visible", async () => {
    const pool = newPool();
    await setup(pool);

    const legacySleep = entry("0102", "0102_legacy_sleep.sql", "legacy-verbatim", 200);
    const startedAt = Date.now();
    await assert.rejects(execute(pool, manifestOf(legacySetup, legacySleep)), /cancellation_unverified/);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 3_000, `expected genuine cancellation well under the full 5s pg_sleep, took ${elapsedMs}ms`);

    // The legacy payload's own internal transaction is opaque to us: no
    // rollback is ever explicitly issued or claimed for a cancellation-driven
    // failure (see executeLegacyVerbatim's cancellationDriven branch). What
    // this proves instead is the real-world guarantee that treatment relies
    // on — discarding the physical connection (rather than returning it to
    // the pool) is itself sufficient for PostgreSQL to discard the aborted,
    // never-committed transaction, so the first insert never becomes visible
    // to a fresh connection either.
    assert.equal(await count("public.demo"), 0, "the never-committed legacy payload must leave no trace, proven from a fresh connection");
    assert.equal(await count("migration_control.schema_migrations"), 1, "only the legacy setup migration is recorded as applied");
  });

  test("pg: no next database operation starts once the wall-clock budget is already exhausted", async () => {
    const pool = newPool();
    await setup(pool);

    // A 1ms budget cannot survive even the BEGIN + four SET LOCAL round
    // trips that precede the supervised statement over a real socket, so
    // this deterministically exercises the "budget exhausted before the
    // next operation begins" path — a wide margin, not a close race.
    const starved = entry("0100", "0100_cumulative_statements.sql", "transactional", 1);
    await assert.rejects(execute(pool, manifestOf(legacySetup, starved)), /wall_clock_exceeded/);
    assert.equal(await count("public.demo"), 0, "the migration statement must never have started");
    assert.equal(await count("migration_control.schema_migrations"), 1);
  });

  test("pg: repeated confirmed wall-clock cancellations leak no clients or pool waiters", async () => {
    const pool = newPool(3);
    await setup(pool);
    const sleepy = entry("0101", "0101_single_sleep.sql", "transactional", 200);

    for (let iteration = 0; iteration < 3; iteration += 1) {
      await assert.rejects(execute(pool, manifestOf(legacySetup, sleepy)), /wall_clock_exceeded/);
      assert.equal(pool.waitingCount, 0, `iteration ${iteration}: no caller left waiting on the pool`);
      assert.equal(pool.totalCount, pool.idleCount, `iteration ${iteration}: no connection leaked as still checked out`);
    }
  });
}
