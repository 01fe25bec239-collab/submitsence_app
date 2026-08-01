import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool, type PoolClient } from "pg";
import type { BatchedHandler } from "../src/db/migrate/execute";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import { assertDistinctDatabases } from "../src/db/migrate/database-identity";
import { installControlSchema, type ControlSchemaInstall } from "./helpers/control-schema-install";
import { executeMigrationsForTest } from "./helpers/migration-execute";

/**
 * PB-10 Step 3 Phase 2c: batched-mode batch-lifecycle coverage against real
 * PostgreSQL, driven exclusively through the production entry point
 * executeMigrations(pool).
 *
 * executeBatched was previously its own separately compiled module
 * (backend/src/db/migrate/batched.ts) specifically so this suite could call
 * it directly with a test-authored BatchedHandler. That direct-call
 * capability is exactly what the emitted build was found to expose as a
 * callable alternate executor — any same-process require() of batched.js
 * could invoke it — and closing it required merging executeBatched into
 * execute.ts as module-private code.
 *
 * The regression coverage below is therefore *not* restored by reopening
 * that seam. Batched mode has no real production migration yet, so its
 * handler lookup (src/db/migrate/handlers.ts) is an inert function that
 * returns undefined for every id; this suite substitutes that one module
 * through the sealed test adapter's existing `Module._load` interception —
 * scoped to execute.ts's own import, the same mechanism already used for
 * `./manifest` — and then runs the entire real production path:
 * executeMigrations(pool) → the advisory lock, control-schema verification,
 * the applied ledger, the real batch-lifecycle state machine, real BEGIN/
 * COMMIT/ROLLBACK per batch on a real connection. Nothing in the emitted
 * build exposes that substitution: handlers.js exports two always-undefined
 * lookup functions and no container anything can add to (proven by the
 * encapsulation test in migration-execute.test.ts).
 *
 * The batch lifecycle is batched-only logic — the per-batch transaction
 * wrapper, executor ownership of unawaited batch promises, and the closed-
 * lifecycle guard have no transactional-mode equivalent — so transactional
 * coverage is explicitly not a substitute for any of it.
 *
 *   MIGRATION_TEST_DATABASE_URL=postgres://... TEST_DATABASE_URL=postgres://... \
 *     node --import tsx --test test/migration-batched.pg.test.ts
 */
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required for the destructive PB-10 Phase 2b/2c batched PostgreSQL suite in CI");
}

if (!databaseUrl) {
  test("pg: batched-mode boundary suite requires a dedicated disposable database", {
    skip: "MIGRATION_TEST_DATABASE_URL is not set; refusing to drop schemas in a shared or unidentified database",
  }, () => undefined);
} else {
  const identity = {
    sourceGitSha: "5324116250977b5e8ac24bc83b6cae89ebcbd990",
    executorImageDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    runnerId: "pb10-batched-boundary-pg",
  };
  const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

  const root = mkdtempSync(path.join(os.tmpdir(), "pb10-batched-boundary-pg-"));
  mkdirSync(path.join(root, "db", "migrations"), { recursive: true });
  const bytes = Buffer.from("-- reserved for a future batched migration\n", "utf8");
  const filename = "0102_backfill_demo.sql";
  writeFileSync(path.join(root, "db", "migrations", filename), bytes);
  after(() => rmSync(root, { recursive: true, force: true }));

  const entry: MigrationManifestEntry = {
    id: "0102",
    filename,
    sha256: sha256(bytes),
    lifecyclePhase: "backfill",
    operationCategories: ["data-correction"],
    executionMode: "batched",
    requiredRuntimeEpoch: null,
    timeouts: { lockMs: 5_000, statementMs: 60_000, transactionMs: 300_000, idleInTransactionMs: 60_000, wallClockMs: 900_000 },
  };
  const manifestOf = (): MigrationManifest => ({ schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] });

  let admin: Client;
  const pools: Pool[] = [];
  const newPool = (max = 3): Pool => {
    const pool = new Pool({ connectionString: install.executionUrl, max, application_name: "pb10-batched-boundary" });
    pools.push(pool);
    return pool;
  };

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

  const resetDatabase = async (): Promise<void> => {
    await admin.query("drop schema if exists migration_control cascade");
    await admin.query("drop schema if exists public cascade");
    await admin.query("create schema public");
    install = await installControlSchema(admin, databaseUrl!);
    // What every batch below actually writes to, so "did this batch's own
    // transaction really commit?" is answered by real committed rows read
    // back on an independent admin connection, never by the runner's own
    // bookkeeping.
    await admin.query("create table public.demo (id integer primary key, label text)");
  };

  const count = async (relation: string): Promise<number> => {
    const result = await admin.query<{ total: string }>(`select count(*)::text as total from ${relation}`);
    return Number(result.rows[0].total);
  };

  const eventTypes = async (): Promise<string[]> => {
    const result = await admin.query<{ event_type: string }>(
      "select event_type from migration_control.migration_runs order by event_sequence",
    );
    return result.rows.map((row) => row.event_type);
  };

  /**
   * Runs the real production entry point with `handler` registered for this
   * suite's batched manifest entry, through the sealed adapter. `timeouts`
   * overrides only the aggregate wall-clock budget where a test needs one.
   */
  const runBatched = (
    pool: Pool,
    handler: BatchedHandler,
    wallClockMs?: number,
  ): Promise<unknown> => executeMigrationsForTest(pool, {
    manifest: wallClockMs === undefined
      ? manifestOf()
      : { schemaVersion: 1, legacyBoundary: "0099", migrations: [{ ...entry, timeouts: { ...entry.timeouts, wallClockMs } }] },
    identity,
    repositoryRoot: root,
    batchedHandlers: new Map([[entry.id, handler]]),
  });

  // Every batch promise this executor hands out is executor-owned: an
  // unawaited one that rejects must be consumed by the run, never left to
  // Node as an unhandled rejection (which, in the production entry point's
  // own strict-mode process, terminates the process instead of reporting the
  // authoritative migration failure). Collected rather than left to crash so
  // a regression reports as a readable assertion instead of a dead runner.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  before(() => {
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUncaught);
  });
  after(() => {
    process.removeListener("unhandledRejection", onUnhandled);
    process.removeListener("uncaughtException", onUncaught);
    assert.deepEqual(unhandled, [], `no unhandled rejection across the suite: ${String(unhandled[0])}`);
    assert.deepEqual(uncaught, [], `no uncaught exception across the suite: ${String(uncaught[0])}`);
  });
  /** Lets any rejection that escaped ownership reach the listeners above before it is asserted on. */
  const settleMicrotasks = async (): Promise<void> => { await delay(50); };

  before(async () => {
    await assertDistinctDatabases(
      { a: databaseUrl, b: process.env.TEST_DATABASE_URL },
      { a: "MIGRATION_TEST_DATABASE_URL", b: "TEST_DATABASE_URL" },
    );
    admin = new Client({ connectionString: databaseUrl, application_name: "pb10-batched-admin" });
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

  test("pg: a batched-mode manifest entry with no registered handler fails closed with unsupported_handler through executeMigrations(pool)", async () => {
    const pool = newPool();
    await assert.rejects(
      executeMigrationsForTest(pool, { manifest: manifestOf(), identity, repositoryRoot: root }),
      (error: unknown) => error instanceof Error && /unsupported_handler/.test(error.message),
    );
    // The handler-lookup failure happens before executeBatched ever appends
    // a "started" event (the handler is confirmed registered first, mirroring
    // executeNontransactional's own ordering) — no ledger row at all.
    const events = await admin.query<{ event_type: string }>(
      "select event_type from migration_control.migration_runs order by event_sequence",
    );
    assert.deepEqual(events.rows.map((row) => row.event_type), []);
    const applied = await admin.query<{ total: string }>("select count(*)::text as total from migration_control.schema_migrations");
    assert.equal(applied.rows[0].total, "0");
  });

  test("pg: an armed, unreconciled commit_outcome_unknown for a batched-mode migration durably blocks a fresh executeMigrations(pool) attempt before BEGIN", async () => {
    const pool = newPool();
    // Arm the guard exactly as a real ambiguous run would have recorded it —
    // via the same structured metadata shape assertNoUnresolvedCommitAmbiguity
    // and mr_metadata_ck both require (proven end-to-end for transactional
    // mode by migration-execute-commit-ambiguity.pg.test.ts; this proves the
    // identical shared guard also fires for a batched-mode migration_id).
    const runId = "10000000-0000-4000-8000-000000000097";
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, error_class, metadata)
       values ($1, $2, 1, 'started', $3, $4, $5, null, $6::jsonb),
              ($1, $2, 2, 'execution_failed', $3, $4, $5, 'commit_outcome_unknown', $7::jsonb)`,
      [
        runId,
        entry.id,
        identity.runnerId,
        identity.sourceGitSha,
        identity.executorImageDigest,
        JSON.stringify({ execution_mode: "batched", migration_filename: entry.filename, migration_ordinal: 1 }),
        JSON.stringify({ execution_mode: "batched", migration_filename: entry.filename, migration_ordinal: 1, checksum_sha256: entry.sha256 }),
      ],
    );

    await assert.rejects(
      executeMigrationsForTest(pool, { manifest: manifestOf(), identity, repositoryRoot: root }),
      /commit_outcome_unknown/,
    );
    const executionActivity = await admin.query<{ total: string }>(
      "select count(*)::text as total from migration_control.migration_runs where run_id != $1",
      [runId],
    );
    assert.equal(executionActivity.rows[0].total, "0", "the fresh attempt never appended a single ledger event of its own — it was blocked before BEGIN");
  });

  // ── batch lifecycle, real handler, real PostgreSQL, public entry point ──

  test("pg: awaited batches each commit in their own transaction and the run completes through the real applied ledger", async () => {
    const pool = newPool();
    const handler: BatchedHandler = {
      execute: async (context) => {
        for (const id of [1, 2, 3]) {
          await context.runBatch(async (client: PoolClient) => {
            await client.query("insert into public.demo (id, label) values ($1, $2)", [id, `batch-${id}`]);
            // Read back from an independent connection *inside* the batch:
            // proves each batch really is its own uncommitted transaction,
            // not one long-running transaction spanning all three.
            assert.equal(await count("public.demo"), id - 1, "the current batch's own row is not visible outside its transaction until it commits");
          });
          assert.equal(await count("public.demo"), id, "each batch's own transaction really committed before the next one began");
        }
      },
      verifyComplete: async () => true,
    };
    await runBatched(pool, handler);
    assert.equal(await count("public.demo"), 3);
    assert.equal(await count("migration_control.schema_migrations"), 1);
    assert.deepEqual(await eventTypes(), [
      // H2: the durable-work marker, committed on the control connection
      // before the first batch could open a transaction.
      "started", "heartbeat", "heartbeat",
      "operation_completed", "operation_completed", "operation_completed",
      "applied_committed", "succeeded",
    ]);
    assert.equal(pool.totalCount, pool.idleCount, "no connection left checked out");
  });

  // The reproduced release blocker: a batch the handler starts and never
  // awaits, which rejects while handler.execute() is still running. Its
  // rejection is the executor's to consume — self-removal from executor
  // ownership at rejection time left nothing for the drain to attach to,
  // producing a strict unhandled rejection (process death) instead of the
  // authoritative migration failure, and the run continuing on to a
  // succeeded event as though the batch had never failed.
  test("pg: a fire-and-forget batch that rejects while handler.execute() is still running fails the run authoritatively — never an unhandled rejection, never a success", async () => {
    const pool = newPool();
    const handler: BatchedHandler = {
      execute: async (context) => {
        // Not awaited, not stored, nothing attached to it: the executor is
        // the only thing that can ever observe this outcome.
        void context.runBatch(async (client: PoolClient) => {
          await client.query("insert into public.no_such_table (id) values (1)");
        });
        // Still inside execute() when that batch rejects.
        await delay(300);
      },
      verifyComplete: async () => {
        assert.fail("verifyComplete must never run once a started batch has failed");
      },
    };
    await assert.rejects(runBatched(pool, handler), (error: unknown) => error instanceof Error && /sql_failed/.test(error.message));
    await settleMicrotasks();
    assert.deepEqual(unhandled, [], "the executor consumed the unawaited batch's rejection itself");
    assert.equal(await count("migration_control.schema_migrations"), 0, "a failed batch can never be recorded as an applied migration");
    const events = await eventTypes();
    assert.deepEqual(events, ["started", "heartbeat", "heartbeat", "transaction_rolled_back", "execution_failed"]);
    assert.equal(pool.totalCount, pool.idleCount, "no connection left checked out");
  });

  test("pg: a fire-and-forget batch that succeeds is fully committed before the applied-ledger row is ever written", async () => {
    const pool = newPool();
    let appliedRowsWhenBatchCommitted = -1;
    const handler: BatchedHandler = {
      execute: async (context) => {
        void context.runBatch(async (client: PoolClient) => {
          await client.query("select pg_sleep(0.3)");
          await client.query("insert into public.demo (id, label) values (1, 'fire-and-forget')");
          appliedRowsWhenBatchCommitted = await count("migration_control.schema_migrations");
        });
        // Returns immediately, long before the batch above finishes.
      },
      verifyComplete: async () => {
        assert.equal(await count("public.demo"), 1, "the unawaited batch had already committed before the verifier ran");
        return true;
      },
    };
    await runBatched(pool, handler);
    assert.equal(await count("public.demo"), 1);
    assert.equal(appliedRowsWhenBatchCommitted, 0, "the applied-ledger row is written only after every started batch has settled");
    assert.equal(await count("migration_control.schema_migrations"), 1);
    assert.deepEqual(await eventTypes(), ["started", "heartbeat", "heartbeat", "operation_completed", "applied_committed", "succeeded"]);
  });

  // Batches share the run's single execution connection, so starting several
  // at once is a handler bug: their BEGIN/COMMIT boundaries interleave on one
  // session. What matters is that it fails closed — every started batch's
  // outcome is still consumed by the executor, the run rejects, and nothing
  // is recorded as applied — rather than leaving an unowned rejection behind
  // or reporting success from whichever batch happened to finish last.
  test("pg: several unawaited batches started in one tick all settle and are all consumed by the executor — the run fails closed and records nothing as applied", async () => {
    const pool = newPool();
    const settled: number[] = [];
    const handler: BatchedHandler = {
      execute: async (context) => {
        for (const id of [1, 2, 3]) {
          void context.runBatch(async (client: PoolClient) => {
            await client.query("insert into public.demo (id, label) values ($1, 'concurrent')", [id]);
          }).then(() => settled.push(id), () => settled.push(id));
        }
      },
      verifyComplete: async () => {
        assert.fail("verifyComplete must never run once a started batch has failed");
      },
    };
    await assert.rejects(runBatched(pool, handler), (error: unknown) => error instanceof Error && /sql_failed|commit_outcome_unknown/.test(error.message));
    await settleMicrotasks();
    assert.deepEqual(settled.slice().sort(), [1, 2, 3], "every started batch reached a real outcome before the run returned");
    assert.deepEqual(unhandled, [], "no started batch's rejection was left unowned");
    assert.equal(await count("migration_control.schema_migrations"), 0);
  });

  test("pg: a late runBatch from a timer after handler.execute() returned is refused inertly — no transaction, no unhandled rejection, and the run still completes", async () => {
    const pool = newPool();
    let lateOutcome: unknown;
    let lateFired!: () => void;
    const lateHasFired = new Promise<void>((resolve) => { lateFired = resolve; });
    const handler: BatchedHandler = {
      execute: async (context) => {
        await context.runBatch(async (client: PoolClient) => {
          await client.query("insert into public.demo (id, label) values (1, 'legitimate')");
        });
        // A closure retained past the end of execute(), fired from a real
        // timer well after this function returned, whose rejection nothing
        // ever awaits.
        setTimeout(() => {
          void context.runBatch(async (client: PoolClient) => {
            await client.query("insert into public.demo (id, label) values (99, 'must never run')");
          }).catch((error: unknown) => { lateOutcome = error; }).finally(lateFired);
        }, 50);
      },
      verifyComplete: async () => true,
    };
    await runBatched(pool, handler);
    await lateHasFired;
    await settleMicrotasks();
    assert.ok(lateOutcome instanceof Error, "the late call was refused, not executed");
    assert.equal(await count("public.demo"), 1, "the late batch ran no SQL at all");
    assert.equal(await count("migration_control.schema_migrations"), 1, "the run itself still completed normally");
    assert.equal((await eventTypes()).filter((type) => type === "operation_completed").length, 1, "only the one legitimate batch was ever recorded");
    assert.deepEqual(unhandled, [], "an inert refusal is never an unhandled rejection either");
  });

  test("pg: a runBatch call made from inside verifyComplete is refused inertly — the verifier can never start a batch", async () => {
    const pool = newPool();
    let retained!: BatchedHandlerContext;
    let verifierOutcome: unknown;
    type BatchedHandlerContext = Parameters<BatchedHandler["execute"]>[0];
    const handler: BatchedHandler = {
      execute: async (context) => {
        retained = context;
        await context.runBatch(async (client: PoolClient) => {
          await client.query("insert into public.demo (id, label) values (1, 'legitimate')");
        });
      },
      verifyComplete: async () => {
        // The exact closure captured during execute(), called from the one
        // place migration-authored code runs after the lifecycle closes.
        await retained.runBatch(async (client: PoolClient) => {
          await client.query("insert into public.demo (id, label) values (99, 'must never run')");
        }).catch((error: unknown) => { verifierOutcome = error; });
        return true;
      },
    };
    await runBatched(pool, handler);
    await settleMicrotasks();
    assert.ok(verifierOutcome instanceof Error, "the verifier's call was refused");
    assert.equal(await count("public.demo"), 1, "the verifier's batch ran no SQL at all");
    assert.equal(await count("migration_control.schema_migrations"), 1);
    assert.deepEqual(unhandled, []);
  });

  test("pg: the wall-clock budget is cumulative across batches — a later batch is refused once the whole migration's budget is spent, and earlier committed batches are never claimed as rolled back", async () => {
    const pool = newPool();
    const budgets: number[] = [];
    const handler: BatchedHandler = {
      execute: async (context) => {
        // First batch commits genuinely, well inside the budget.
        await context.runBatch(async (client: PoolClient) => {
          await client.query("insert into public.demo (id, label) values (1, 'first')");
          await client.query("select pg_sleep(0.8)");
        });
        budgets.push(await count("public.demo"));
        // Time keeps being spent between batches, and the migration's
        // aggregate budget keeps shrinking: nothing about a batch finishing
        // successfully hands the next one a fresh one.
        await delay(700);
        await context.runBatch(async (client: PoolClient) => {
          await client.query("insert into public.demo (id, label) values (2, 'second')");
        });
      },
      verifyComplete: async () => {
        assert.fail("verifyComplete must never run once the migration's budget is exhausted");
      },
    };
    await assert.rejects(runBatched(pool, handler, 1_500), /wall_clock_exceeded/, "the second batch inherits the already-spent aggregate budget, never a fresh one");
    assert.deepEqual(budgets, [1], "the first batch genuinely committed");
    assert.equal(await count("public.demo"), 1, "the refused second batch ran no SQL");
    const events = await eventTypes();
    assert.equal(events.filter((type) => type === "operation_completed").length, 1, "the first batch's own commit is recorded exactly once");
    assert.equal(
      events.filter((type) => type === "transaction_rolled_back").length,
      0,
      "the already-committed first batch is never represented as rolled back — batches commit independently",
    );
    assert.equal(await count("migration_control.schema_migrations"), 0, "an incomplete batched migration is never recorded as applied");
  }, { timeout: 30_000 });

  test("pg: a batch that fails after earlier batches committed rolls back only itself, and the run refuses to record the migration as applied", async () => {
    const pool = newPool();
    const handler: BatchedHandler = {
      execute: async (context) => {
        await context.runBatch(async (client: PoolClient) => {
          await client.query("insert into public.demo (id, label) values (1, 'committed')");
        });
        await context.runBatch(async (client: PoolClient) => {
          await client.query("insert into public.demo (id, label) values (2, 'rolled back')");
          // A genuine server ErrorResponse: PostgreSQL guarantees this
          // transaction never commits, and only this one.
          await client.query("insert into public.demo (id, label) values (1, 'duplicate key')");
        });
      },
      verifyComplete: async () => true,
    };
    await assert.rejects(runBatched(pool, handler), (error: unknown) => error instanceof Error && /sql_failed/.test(error.message));
    assert.equal(await count("public.demo"), 1, "the failing batch rolled back entirely; the earlier committed batch survives untouched");
    const events = await eventTypes();
    assert.deepEqual(events, ["started", "heartbeat", "heartbeat", "operation_completed", "transaction_rolled_back", "execution_failed"]);
    const rolledBack = await admin.query<{ batch_number: number }>(
      "select (metadata ->> 'batch_number')::int as batch_number from migration_control.migration_runs where event_type = 'transaction_rolled_back'",
    );
    assert.equal(rolledBack.rows[0].batch_number, 2, "the rollback event names exactly the batch that rolled back, never the ones that already committed");
    assert.equal(await count("migration_control.schema_migrations"), 0);
  });

}
