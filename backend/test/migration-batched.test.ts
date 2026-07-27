import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { mock } from "node:test";
import type { PoolClient } from "pg";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import { MigrationExecutionError, type BatchedContext, type BatchedHandler } from "../src/db/migrate/execute";
import { executeBatched } from "../src/db/migrate/batched";
import { RunLog, type MigrationContext } from "../src/db/migrate/execution-context";

/**
 * PB-10 Step 3 Phase 2b: deterministic tests of the *real* production
 * batched-mode orchestration (`executeBatched`, `backend/src/db/migrate/batched.ts`)
 * — the exact function execute.ts imports and calls, not a reproduction of
 * its algorithm. registeredHandlers in execute.ts stays hardcoded empty (no
 * migration above the legacy boundary exists yet — see db/README.md), which
 * is exactly why executeBatched was extracted into its own narrowly scoped
 * internal module in the first place: these tests reach it directly with a
 * test-authored BatchedHandler, bypassing executeMigrations entirely, the
 * same way migration-execute-supervision.test.ts reaches superviseOperation
 * directly. executeMigrations(pool)'s own public contract — one Pool
 * argument, the hardcoded-empty production registry — is untouched; see
 * "production execution/API/build-boundary" tests in migration-execute.test.ts.
 *
 * process.hrtime.bigint is mocked to drive monotonicMs() deterministically
 * (same technique as the transactional/legacy wall-clock tests); sleep is
 * set directly on the hand-built MigrationContext (no Module._load
 * indirection needed here, since this test constructs the context itself).
 */

const identity = {
  sourceGitSha: "5324116250977b5e8ac24bc83b6cae89ebcbd990",
  executorImageDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  runnerId: "pb10-batched-test",
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const bytes = Buffer.from("-- progress is owned by the registered batched handler\n", "utf8");

const timeouts = { lockMs: 5_000, statementMs: 60_000, transactionMs: 300_000, idleInTransactionMs: 60_000, wallClockMs: 900_000 };

function entryFor(wallClockMs: number, overrides: Partial<MigrationManifestEntry["timeouts"]> = {}): MigrationManifestEntry {
  return {
    id: "0102",
    filename: "0102_backfill_demo.sql",
    sha256: sha256(bytes),
    lifecyclePhase: "backfill",
    operationCategories: ["data-correction"],
    executionMode: "batched",
    requiredRuntimeEpoch: null,
    timeouts: { ...timeouts, wallClockMs, ...overrides },
  };
}

function manifestOf(entry: MigrationManifestEntry): MigrationManifest {
  return { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
}

type QueryResult = { rows: unknown[]; rowCount: number | null };
type Recorded = { client: "control" | "execution"; sql: string; values?: unknown[] };

class FakeClient {
  released = false;
  releasedWith: Error | undefined;
  releaseCount = 0;
  constructor(readonly role: "control" | "execution", readonly log: Recorded[]) {}
  record(sql: string, values?: unknown[]): void {
    this.log.push({ client: this.role, sql: sql.trim(), values });
  }
  release(error?: Error): void {
    this.released = true;
    this.releasedWith = error;
    this.releaseCount += 1;
  }
}

class ControlClient extends FakeClient {
  cancelBehaviour: true | false | "throws" = true;
  onCancel: (() => void) | undefined;
  readonly events: Array<{ sequence: number; type: string; sqlstate: string | null; errorClass: string | null; batchNumber: number | null }> = [];
  readonly appliedInserts: unknown[][] = [];

  constructor(log: Recorded[]) {
    super("control", log);
  }

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.record(sql, values);
    if (sql.includes("pg_cancel_backend")) {
      this.onCancel?.();
      if (this.cancelBehaviour === "throws") throw new Error("control connection unavailable");
      return { rows: [{ pg_cancel_backend: this.cancelBehaviour }], rowCount: 1 };
    }
    if (sql.includes("into migration_control.migration_runs")) {
      const metadata = JSON.parse(String(values?.[10])) as { batch_number?: number };
      this.events.push({
        sequence: Number(values?.[2]),
        type: String(values?.[3]),
        sqlstate: (values?.[8] as string | null) ?? null,
        errorClass: (values?.[9] as string | null) ?? null,
        batchNumber: metadata.batch_number ?? null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("into migration_control.schema_migrations")) {
      this.appliedInserts.push(values ?? []);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected control query in test: ${sql}`);
  }

  eventTypes(): string[] {
    return this.events.map(({ type }) => type);
  }
}

class ExecutionClient extends FakeClient {
  readonly settings: Array<[string, string]> = [];
  failRollback = false;
  failCommit: Error | undefined;

  constructor(log: Recorded[]) {
    super("execution", log);
  }

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.record(sql, values);
    if (sql.includes("set_config")) {
      this.settings.push([String(values?.[0]), String(values?.[1])]);
      return { rows: [{ set_config: String(values?.[1]) }], rowCount: 1 };
    }
    if (sql.includes("pg_backend_pid")) return { rows: [{ pid: 4242 }], rowCount: 1 };
    if (sql === "begin") return { rows: [], rowCount: null };
    if (sql === "commit") {
      if (this.failCommit) throw this.failCommit;
      return { rows: [], rowCount: null };
    }
    if (sql === "rollback") {
      if (this.failRollback) throw new Error("rollback failed");
      return { rows: [], rowCount: null };
    }
    return { rows: [], rowCount: null };
  }
}

function mockMonotonic(...millisecondsSequence: number[]): { restore(): void } {
  let call = 0;
  const method = mock.method(process.hrtime, "bigint", () => {
    const index = Math.min(call, millisecondsSequence.length - 1);
    call += 1;
    return BigInt(millisecondsSequence[index]) * 1_000_000n;
  });
  return { restore: () => method.mock.restore() };
}

function controllableSleep() {
  const pending: Array<{ active: boolean; resolve: () => void }> = [];
  const durations: number[] = [];
  const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
    durations.push(milliseconds);
    const wait = { active: true, resolve };
    pending.push(wait);
    signal?.addEventListener("abort", () => {
      if (!wait.active) return;
      wait.active = false;
      resolve();
    }, { once: true });
  });
  return {
    sleep,
    durations,
    callCount(): number { return pending.length; },
    pendingCount(): number { return pending.filter(({ active }) => active).length; },
    fire(index: number): void {
      const wait = pending[index];
      assert.ok(wait, `no sleep() call recorded at index ${index}`);
      if (!wait.active) return;
      wait.active = false;
      wait.resolve();
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function tickUntil(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
    await tick();
  }
  assert.ok(predicate(), description);
}

async function withStrictUnhandledRejection<T>(action: () => Promise<T>): Promise<T> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    return await action();
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener("unhandledRejection", onUnhandled);
    assert.deepEqual(unhandled, [], `unexpected unhandledRejection: ${String(unhandled[0])}`);
  }
}

interface Harness {
  context: MigrationContext;
  control: ControlClient;
  execution: ExecutionClient;
  log: Recorded[];
  destroyCalls: () => number;
  sleepController: ReturnType<typeof controllableSleep>;
}

function buildContext(entry: MigrationManifestEntry, handler: BatchedHandler, sleep?: (ms: number) => Promise<void>): Harness {
  const log: Recorded[] = [];
  const control = new ControlClient(log);
  const execution = new ExecutionClient(log);
  const runLog = new RunLog(control as unknown as PoolClient, "10000000-0000-4000-8000-000000000001", identity, manifestOf(entry));
  let destroyCount = 0;
  const sleepController = controllableSleep();
  const context: MigrationContext = {
    entry,
    ordinal: 1,
    bytes,
    checksum: sha256(bytes),
    control: control as unknown as PoolClient,
    execution: execution as unknown as PoolClient,
    runLog,
    identity,
    handlers: { nontransactional: new Map(), batched: new Map([[entry.id, handler]]) },
    sleep: sleep ?? sleepController.sleep,
    now: Date.now,
    destroyExecution: () => { destroyCount += 1; },
  };
  return { context, control, execution, log, destroyCalls: () => destroyCount, sleepController };
}

/** A handler whose batches are supplied as an ordered list of callbacks. */
function handlerOf(batches: Array<(client: PoolClient) => Promise<void>>, verifyComplete: () => Promise<boolean> = async () => true): BatchedHandler {
  return {
    execute: async (batchContext: BatchedContext) => {
      for (const batch of batches) {
        await batchContext.runBatch(batch);
      }
    },
    verifyComplete,
  };
}

// 1 ────────────────────────────────────────────────────────────────────────────
test("batched: several batches each complete within the original wallClockMs, but cumulative duration exceeds the shared deadline", async () => {
  const entry = entryFor(1_000); // 1s aggregate budget
  let invocations = 0;
  // Each batch reports elapsed 400ms if measured against the *original*
  // wallClockMs alone it would pass every time (1000ms > 400ms); only the
  // shared, non-resetting deadline can catch the cumulative total.
  // monotonic sequence: deadline base(0) -> batch1 pre-check(100, budget=900,
  // passes) -> batch2 pre-check(500, budget=500, passes) -> batch3
  // pre-check(1100, budget=-100, fails closed).
  const restore = mockMonotonic(0, 100, 500, 1_100);
  try {
    const handler = handlerOf([
      async () => { invocations += 1; },
      async () => { invocations += 1; },
      async () => { invocations += 1; },
    ]);
    const { context, control } = buildContext(entry, handler);
    await assert.rejects(executeBatched(context), /wall_clock_exceeded/);
    assert.equal(invocations, 2, "only the two batches that fit the shared budget ever ran");
    assert.deepEqual(control.eventTypes(), ["started", "operation_completed", "operation_completed", "execution_failed"]);
  } finally {
    restore.restore();
  }
});

// 2 ────────────────────────────────────────────────────────────────────────────
test("batched: budget expires between batches and the next batch callback is never invoked", async () => {
  const entry = entryFor(500);
  let secondBatchInvoked = false;
  const restore = mockMonotonic(0, 100, 600); // deadline=500; batch1 passes at 100; batch2 pre-check at 600 fails
  try {
    const handler = handlerOf([
      async () => undefined,
      async () => { secondBatchInvoked = true; },
    ]);
    const { context } = buildContext(entry, handler);
    await assert.rejects(executeBatched(context), /wall_clock_exceeded/);
    assert.equal(secondBatchInvoked, false, "the second batch callback must never run once the budget is exhausted");
  } finally {
    restore.restore();
  }
});

// 5 ────────────────────────────────────────────────────────────────────────────
test("batched: remaining budget passed to later batches decreases rather than resetting", async () => {
  const entry = entryFor(10_000, { statementMs: 60_000, transactionMs: 60_000 });
  // deadline base 0 -> deadline=10000. batch1 pre-check at 1000 (budget 9000),
  // batch2 pre-check at 4000 (budget 6000), batch3 pre-check at 8000 (budget 2000).
  const restore = mockMonotonic(0, 1_000, 4_000, 8_000);
  try {
    const handler = handlerOf([
      async () => undefined,
      async () => undefined,
      async () => undefined,
    ]);
    const { context, execution, sleepController } = buildContext(entry, handler);
    await executeBatched(context);
    // transaction_timeout is set right after the pre-batch budget check, one
    // SET LOCAL per batch (4 settings per batch: lock/statement/transaction/idle).
    const transactionTimeouts = execution.settings
      .filter(([setting]) => setting === "transaction_timeout")
      .map(([, value]) => Number(value));
    assert.deepEqual(transactionTimeouts, [60_000, 60_000, 60_000], "the independent PostgreSQL ceiling does not reset or replace the migration deadline");
    assert.deepEqual(
      sleepController.durations,
      [9_000, 6_000, 2_000],
      "the control-side supervisor passes each batch only the decreasing remainder",
    );
  } finally {
    restore.restore();
  }
});

// 6, 16 ───────────────────────────────────────────────────────────────────────
test("batched: effective batch timeout is the minimum of remaining migration budget and the declared ceilings", async () => {
  const entry = entryFor(500, { statementMs: 60_000, transactionMs: 300_000 });
  const restore = mockMonotonic(0); // no real elapsed time
  try {
    const handler = handlerOf([async () => undefined]);
    const { context, execution, sleepController } = buildContext(entry, handler);
    await executeBatched(context);
    const settings = execution.settings.filter(([setting]) => setting.endsWith("_timeout") || setting.endsWith("_session_timeout"));
    assert.deepEqual(settings, [
      ["lock_timeout", "5000"],
      ["statement_timeout", "60000"],
      ["transaction_timeout", "300000"],
      ["idle_in_transaction_session_timeout", "60000"],
    ]);
    assert.equal(
      sleepController.durations[0],
      500,
      "the effective batch ceiling is the 500ms supervisor budget, smaller than every PostgreSQL ceiling",
    );
  } finally {
    restore.restore();
  }
});

// 3, 7 ────────────────────────────────────────────────────────────────────────
test("batched: a timeout during an active batch uses the Phase 2a cancellation contract (confirmed via 57014)", async () => {
  await withStrictUnhandledRejection(async () => {
    const entry = entryFor(5_000);
    const restore = mockMonotonic(0); // plenty of budget; the timing comes from the sleep controller instead
    try {
      const hang = new Promise<void>(() => undefined);
      const handler = handlerOf([async (client: PoolClient) => { await client.query("select pg_sleep(5)"); void hang; }]);
      const { context, execution, control, sleepController, destroyCalls } = buildContext(entry, handler);
      const originalQuery = execution.query.bind(execution);
      let settleBatch: ((error?: unknown) => void) | undefined;
      execution.query = async (sql: string, values?: unknown[]) => {
        if (sql.includes("pg_sleep")) {
          return new Promise((resolve, reject) => {
            settleBatch = (error) => (error ? reject(error) : resolve({ rows: [], rowCount: null }));
          });
        }
        return originalQuery(sql, values);
      };

      const pending = executeBatched(context);
      await tickUntil(() => sleepController.callCount() > 0, "the per-batch wall-clock sleep was never reached");
      sleepController.fire(0); // budget expires mid-batch, cancellation requested
      await tick();
      const QUERY_CANCELED = Object.assign(new Error("canceling statement due to user request"), { code: "57014" });
      settleBatch?.(QUERY_CANCELED); // confirmed cancellation

      await assert.rejects(
        pending,
        (error: unknown) => error instanceof MigrationExecutionError
          && error.errorClass === "wall_clock_exceeded"
          && error.sqlstate === "57014",
      );
      const executionSql = execution.log.map(({ sql }) => sql);
      assert.ok(executionSql.includes("rollback"), "the active batch is rolled back after confirmed cancellation");
      assert.ok(!executionSql.includes("commit"), "COMMIT is never sent for the cancelled batch");
      assert.deepEqual(control.eventTypes(), ["started", "transaction_rolled_back", "execution_failed"]);
      assert.equal(destroyCalls(), 0, "confirmed cancellation plus confirmed rollback leaves a healthy connection, never destroyed");
      assert.equal(sleepController.pendingCount(), 0, "both the expired budget wait and losing grace wait are settled");
    } finally {
      restore.restore();
    }
  });
});

// 4 ────────────────────────────────────────────────────────────────────────────
test("batched: previously committed batches are never represented as rolled back", async () => {
  await withStrictUnhandledRejection(async () => {
    const entry = entryFor(5_000);
    const restore = mockMonotonic(0);
    try {
      const hang = new Promise<void>(() => undefined);
      const handler = handlerOf([
        async () => undefined, // batch 1: commits normally
        async (client: PoolClient) => { await client.query("select pg_sleep(5)"); void hang; }, // batch 2: cancelled
      ]);
      const { context, execution, control, sleepController } = buildContext(entry, handler);
      const originalQuery = execution.query.bind(execution);
      let settleBatch: ((error?: unknown) => void) | undefined;
      execution.query = async (sql: string, values?: unknown[]) => {
        if (sql.includes("pg_sleep")) {
          return new Promise((resolve, reject) => {
            settleBatch = (error) => (error ? reject(error) : resolve({ rows: [], rowCount: null }));
          });
        }
        return originalQuery(sql, values);
      };

      const pending = executeBatched(context);
      // Batch 1's own operation settles almost instantly (no sleep fired for
      // it), so it wins its race unaided; batch 2 is the one whose
      // wall-clock sleep this test actually needs to fire — wait for both
      // batches to have reached supervision (two recorded sleep calls) and
      // fire the second one specifically.
      await tickUntil(() => sleepController.callCount() >= 2, "batch 2's wall-clock sleep was never reached");
      sleepController.fire(1);
      await tick();
      const QUERY_CANCELED = Object.assign(new Error("canceling statement due to user request"), { code: "57014" });
      settleBatch?.(QUERY_CANCELED);

      await assert.rejects(pending, /wall_clock_exceeded/);
      assert.deepEqual(control.eventTypes(), [
        "started",
        "operation_completed", // batch 1 committed
        "transaction_rolled_back", // batch 2 only
        "execution_failed",
      ]);
      const rolledBackBatchNumbers = control.events
        .filter(({ type }) => type === "transaction_rolled_back")
        .map(({ batchNumber }) => batchNumber);
      assert.deepEqual(rolledBackBatchNumbers, [2], "batch 1 is never described as rolled back");
      const commitCount = execution.log.filter(({ sql }) => sql === "commit").length;
      assert.equal(commitCount, 1, "exactly one batch (the first) actually committed");
    } finally {
      restore.restore();
    }
  });
});

// 7 (unverified variant) ────────────────────────────────────────────────────────
test("batched: unverified active-batch cancellation destroys the execution client exactly once", async () => {
  await withStrictUnhandledRejection(async () => {
    const entry = entryFor(5_000);
    const restore = mockMonotonic(0);
    try {
      const handler = handlerOf([async (client: PoolClient) => { await client.query("select pg_sleep(5)"); }]);
      const { context, execution, control, sleepController, destroyCalls } = buildContext(entry, handler);
      control.cancelBehaviour = false; // pg_cancel_backend rejected: unverified, no grace wait
      const originalQuery = execution.query.bind(execution);
      execution.query = async (sql: string, values?: unknown[]) => {
        if (sql.includes("pg_sleep")) return new Promise(() => undefined); // never settles
        return originalQuery(sql, values);
      };

      const pending = executeBatched(context);
      await tickUntil(() => sleepController.callCount() > 0, "the per-batch wall-clock sleep was never reached");
      sleepController.fire(0);

      await assert.rejects(pending, /cancellation_unverified/);
      assert.equal(destroyCalls(), 1, "destroyExecution fires exactly once for an unverified cancellation");
      assert.ok(!execution.log.some(({ sql }) => sql === "rollback"), "no rollback is attempted or claimed once cancellation is unverified");
      assert.deepEqual(control.eventTypes(), ["started", "execution_failed"]);
      assert.equal(sleepController.pendingCount(), 0, "no supervision wait remains pending");
    } finally {
      restore.restore();
    }
  });
});

// 8 ────────────────────────────────────────────────────────────────────────────
test("batched: a successful run leaves no timers, promises, or leaked state", async () => {
  await withStrictUnhandledRejection(async () => {
    const entry = entryFor(10_000);
    const restore = mockMonotonic(0);
    try {
      const handler = handlerOf([async () => undefined, async () => undefined]);
      const { context, control, sleepController } = buildContext(entry, handler);
      await executeBatched(context);
      assert.deepEqual(control.eventTypes(), [
        "started",
        "operation_completed",
        "operation_completed",
        "applied_committed",
        "succeeded",
      ]);
      assert.equal(control.appliedInserts.length, 1);
      assert.equal(sleepController.pendingCount(), 0, "successful batches cancel their losing deadline waits");
    } finally {
      restore.restore();
    }
  });
});

// unsupported handler still fails closed through the real function
test("batched: an unregistered migration id still fails closed with unsupported_handler", async () => {
  const entry = entryFor(900_000);
  const handler = handlerOf([async () => undefined]);
  const { context } = buildContext(entry, handler);
  context.handlers = { nontransactional: new Map(), batched: new Map() }; // no entry registered
  await assert.rejects(executeBatched(context), /unsupported_handler/);
});
