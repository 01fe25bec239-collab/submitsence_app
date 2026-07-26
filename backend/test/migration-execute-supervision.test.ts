import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import {
  CANCELLATION_GRACE_MS,
  superviseOperation,
  type SupervisedOperationContext,
} from "../src/db/migrate/supervision";

/**
 * PB-10 Step 3 Phase 2a: cancellation-confirmation hardening, unit-level.
 *
 * superviseOperation is unreachable through executeMigrations in this test
 * suite: reaching it in a real run requires a registered nontransactional
 * handler, and both handler registries in execute.ts are — by design —
 * hardcoded empty (see db/README.md: "no migration above 0099 exists yet").
 * These tests therefore exercise superviseOperation directly against a
 * minimal, self-contained fake control/execution pair, importing it from
 * its own internal module (backend/src/db/migrate/supervision.ts) rather
 * than from execute.ts: execute.ts imports superviseOperation for its own
 * internal use and does not re-export it, so executeMigrations(pool)
 * remains the sole production migration execution entry point.
 * superviseOperation itself never calls .release() on either connection —
 * that stays owned by executeVerifiedMigrations's outer finally block,
 * unchanged by this phase — it only ever decides whether destroyExecution()
 * must fire; these tests assert exactly that decision, once, on every path.
 *
 * Fully deterministic: `sleep` never uses a real timer. Each call returns a
 * promise whose resolver is captured by index, so a test fires the
 * budget-expiry wait and/or the cancellation-grace wait at the exact moment
 * it chooses, with no reliance on wall-clock timing or CANCELLATION_GRACE_MS
 * (10s) actually elapsing.
 */

const QUERY_CANCELED = Object.assign(new Error("canceling statement due to user request"), { code: "57014" });
const SERIALIZATION_FAILURE = Object.assign(new Error("could not serialize access"), { code: "40001" });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Deterministic, real-time-free stand-in for context.sleep. */
function controllableSleep() {
  const pending: Array<() => void> = [];
  const sleep = (_milliseconds: number): Promise<void> => new Promise((resolve) => { pending.push(resolve); });
  return {
    sleep,
    fire(index: number): void {
      const resolve = pending[index];
      assert.ok(resolve, `no sleep() call recorded at index ${index}`);
      resolve();
    },
    callCount(): number {
      return pending.length;
    },
  };
}

type FakeQuery = (sql: string, values?: unknown[]) => unknown;

class FakeClient {
  readonly releaseCalls: Array<Error | undefined> = [];
  constructor(private readonly handleQuery: FakeQuery) {}
  async query(sql: string, values?: unknown[]): Promise<unknown> {
    return this.handleQuery(sql, values);
  }
  release(error?: Error): void {
    this.releaseCalls.push(error);
  }
}

/** Cancel-backend behaviour under test: true (default), false, or "throws". */
type CancelBehaviour = true | false | "throws";

interface Harness {
  context: SupervisedOperationContext;
  control: FakeClient;
  execution: FakeClient;
  sleepController: ReturnType<typeof controllableSleep>;
  destroyCalls: () => number;
}

function buildContext(options: {
  operationSettlement?: Promise<unknown>;
  cancel?: CancelBehaviour;
}): Harness {
  let destroyCount = 0;
  const sleepController = controllableSleep();

  const control = new FakeClient((sql) => {
    if (sql.includes("pg_cancel_backend")) {
      const behaviour = options.cancel ?? true;
      if (behaviour === "throws") throw new Error("control connection unavailable");
      return { rows: [{ pg_cancel_backend: behaviour }], rowCount: 1 };
    }
    throw new Error(`unexpected control query in test: ${sql}`);
  });

  const pendingOperation = options.operationSettlement ?? new Promise(() => undefined);
  const execution = new FakeClient((sql) => {
    if (sql.includes("pg_backend_pid")) return { rows: [{ pid: 4242 }], rowCount: 1 };
    // The supervised SQL itself.
    return pendingOperation;
  });

  const context: SupervisedOperationContext = {
    entry: { id: "0101" },
    control: control as unknown as PoolClient,
    execution: execution as unknown as PoolClient,
    sleep: sleepController.sleep,
    now: Date.now,
    destroyExecution: () => { destroyCount += 1; },
  };

  return { context, control, execution, sleepController, destroyCalls: () => destroyCount };
}

/**
 * Flushes pending microtasks (a macrotask boundary via setImmediate), so a
 * test can safely wait for superviseOperation's internal awaits (e.g. the
 * pg_backend_pid lookup) to actually reach its next context.sleep(...) call
 * before firing that sleep's resolver.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Fails the test if any unhandledRejection fires while `run` executes. */
async function withStrictUnhandledRejection<T>(run: () => Promise<T>): Promise<T> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    return await run();
  } finally {
    // Give any late microtask a chance to surface before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener("unhandledRejection", onUnhandled);
    assert.deepEqual(unhandled, [], `unexpected unhandledRejection: ${String(unhandled[0])}`);
  }
}

// 1 ──────────────────────────────────────────────────────────────────────────
test("operation succeeds before timeout: returns normally, never cancels", async () => {
  await withStrictUnhandledRejection(async () => {
    const { context, sleepController, destroyCalls } = buildContext({
      operationSettlement: Promise.resolve({ rows: [], rowCount: null }),
    });
    await superviseOperation(context, "select 1", 5_000);
    assert.equal(sleepController.callCount(), 1, "only the budget wait is ever raced");
    assert.equal(destroyCalls(), 0);
  });
});

// 2 ──────────────────────────────────────────────────────────────────────────
test("operation fails before timeout: classified failure propagates, never cancels", async () => {
  await withStrictUnhandledRejection(async () => {
    const boom = Object.assign(new Error("boom"), { code: "42601" });
    const { context, sleepController, destroyCalls } = buildContext({
      operationSettlement: Promise.reject(boom),
    });
    await assert.rejects(
      superviseOperation(context, "select 1", 5_000),
      (error: Error) => /sql_failed/.test(error.message) && !error.message.includes("boom"),
    );
    assert.equal(sleepController.callCount(), 1);
    assert.equal(destroyCalls(), 0);
  });
});

// 3 ──────────────────────────────────────────────────────────────────────────
test("timeout, cancel accepted, operation rejects 57014: confirmed cancellation, not destroyed", async () => {
  await withStrictUnhandledRejection(async () => {
    const op = deferred<unknown>();
    const { context, control, sleepController, destroyCalls } = buildContext({ operationSettlement: op.promise });

    const pending = superviseOperation(context, "select 1", 5_000);
    await tick();
    sleepController.fire(0); // budget expires
    await tick();
    op.reject(QUERY_CANCELED); // confirmed cancellation, before the grace timer ever fires

    await assert.rejects(pending, /wall_clock_exceeded/);
    assert.equal(control.releaseCalls.length, 0, "superviseOperation never releases control itself");
    assert.equal(destroyCalls(), 0, "a confirmed cancellation leaves a healthy, reusable connection");
  });
});

// 4 ──────────────────────────────────────────────────────────────────────────
test("timeout, pg_cancel_backend returns false: unverified immediately, no grace wait", async () => {
  await withStrictUnhandledRejection(async () => {
    const { context, sleepController, destroyCalls } = buildContext({ cancel: false });
    const pending = superviseOperation(context, "select 1", 5_000);
    await tick();
    sleepController.fire(0);
    await assert.rejects(pending, /cancellation_unverified/);
    assert.equal(destroyCalls(), 1);
    assert.equal(sleepController.callCount(), 1, "no grace-period wait is requested once the cancel request is rejected");
  });
});

// 5 ──────────────────────────────────────────────────────────────────────────
test("cancellation query throws: unverified immediately, no grace wait", async () => {
  await withStrictUnhandledRejection(async () => {
    const { context, sleepController, destroyCalls } = buildContext({ cancel: "throws" });
    const pending = superviseOperation(context, "select 1", 5_000);
    await tick();
    sleepController.fire(0);
    await assert.rejects(pending, /cancellation_unverified/);
    assert.equal(destroyCalls(), 1);
    assert.equal(sleepController.callCount(), 1);
  });
});

// 6 ──────────────────────────────────────────────────────────────────────────
test("operation resolves after cancellation has started: ambiguous race is unverified, not success", async () => {
  await withStrictUnhandledRejection(async () => {
    const op = deferred<unknown>();
    const { context, sleepController, destroyCalls } = buildContext({ operationSettlement: op.promise });
    const pending = superviseOperation(context, "select 1", 5_000);
    await tick();
    sleepController.fire(0);
    await tick();
    op.resolve({ rows: [], rowCount: null }); // completed AFTER the cancel request was issued
    await assert.rejects(pending, /cancellation_unverified/);
    assert.equal(destroyCalls(), 1, "a race that could have been success must still destroy the connection");
  });
});

// 7 ──────────────────────────────────────────────────────────────────────────
test("operation rejects with an unexpected SQLSTATE after cancellation: unverified, not confirmed", async () => {
  await withStrictUnhandledRejection(async () => {
    const op = deferred<unknown>();
    const { context, sleepController, destroyCalls } = buildContext({ operationSettlement: op.promise });
    const pending = superviseOperation(context, "select 1", 5_000);
    await tick();
    sleepController.fire(0);
    await tick();
    op.reject(SERIALIZATION_FAILURE);
    await assert.rejects(pending, /cancellation_unverified/);
    assert.equal(destroyCalls(), 1);
  });
});

// 8 ──────────────────────────────────────────────────────────────────────────
test("operation never settles during the grace period: unverified on grace expiry", async () => {
  await withStrictUnhandledRejection(async () => {
    const { context, sleepController, destroyCalls } = buildContext({});
    const pending = superviseOperation(context, "select 1", 5_000);
    await tick();
    sleepController.fire(0); // budget expires
    await tick();
    assert.equal(sleepController.callCount(), 2, "the grace-period wait has been requested");
    sleepController.fire(1); // grace period elapses with no settlement
    await assert.rejects(pending, new RegExp(`cancellation_unverified|not confirmed within ${CANCELLATION_GRACE_MS}ms`));
    assert.equal(destroyCalls(), 1);
  });
});

// 9 ──────────────────────────────────────────────────────────────────────────
test("the execution connection is destroyed exactly once on every unverified path", async () => {
  await withStrictUnhandledRejection(async () => {
    const scenarios: Array<{ name: string; run: () => Promise<Harness> }> = [
      {
        name: "cancel returns false",
        run: async () => {
          const harness = buildContext({ cancel: false });
          const pending = superviseOperation(harness.context, "select 1", 5_000);
          await tick();
          harness.sleepController.fire(0);
          await assert.rejects(pending);
          return harness;
        },
      },
      {
        name: "cancel query throws",
        run: async () => {
          const harness = buildContext({ cancel: "throws" });
          const pending = superviseOperation(harness.context, "select 1", 5_000);
          await tick();
          harness.sleepController.fire(0);
          await assert.rejects(pending);
          return harness;
        },
      },
      {
        name: "grace period expires with no settlement",
        run: async () => {
          const harness = buildContext({});
          const pending = superviseOperation(harness.context, "select 1", 5_000);
          await tick();
          harness.sleepController.fire(0);
          await tick();
          harness.sleepController.fire(1);
          await assert.rejects(pending);
          return harness;
        },
      },
      {
        name: "operation resolves after cancellation started",
        run: async () => {
          const op = deferred<unknown>();
          const harness = buildContext({ operationSettlement: op.promise });
          const pending = superviseOperation(harness.context, "select 1", 5_000);
          await tick();
          harness.sleepController.fire(0);
          await tick();
          op.resolve({ rows: [], rowCount: null });
          await assert.rejects(pending);
          return harness;
        },
      },
      {
        name: "operation rejects with unexpected SQLSTATE after cancellation",
        run: async () => {
          const op = deferred<unknown>();
          const harness = buildContext({ operationSettlement: op.promise });
          const pending = superviseOperation(harness.context, "select 1", 5_000);
          await tick();
          harness.sleepController.fire(0);
          await tick();
          op.reject(SERIALIZATION_FAILURE);
          await assert.rejects(pending);
          return harness;
        },
      },
    ];

    for (const scenario of scenarios) {
      const harness = await scenario.run();
      assert.equal(harness.destroyCalls(), 1, `${scenario.name}: destroyExecution must fire exactly once`);
    }
  });
});

// 10 ─────────────────────────────────────────────────────────────────────────
test("healthy connections are never destroyed: success and confirmed cancellation both leave zero destroy calls", async () => {
  await withStrictUnhandledRejection(async () => {
    const success = buildContext({ operationSettlement: Promise.resolve({ rows: [], rowCount: null }) });
    await superviseOperation(success.context, "select 1", 5_000);
    assert.equal(success.destroyCalls(), 0);
    assert.equal(success.execution.releaseCalls.length, 0, "superviseOperation itself never releases execution either");

    const op = deferred<unknown>();
    const confirmed = buildContext({ operationSettlement: op.promise });
    const pending = superviseOperation(confirmed.context, "select 1", 5_000);
    await tick();
    confirmed.sleepController.fire(0);
    await tick();
    op.reject(QUERY_CANCELED);
    await assert.rejects(pending, /wall_clock_exceeded/);
    assert.equal(confirmed.destroyCalls(), 0);
  });
});

// 11 ─────────────────────────────────────────────────────────────────────────
test("the control connection is neither released nor destroyed by superviseOperation itself, on any path", async () => {
  await withStrictUnhandledRejection(async () => {
    for (const behaviour of [true, false, "throws"] as const) {
      const { context, control, sleepController } = buildContext({ cancel: behaviour });
      const pending = superviseOperation(context, "select 1", 5_000);
      await tick();
      sleepController.fire(0);
      if (behaviour === true) {
        // Only an accepted cancel request proceeds to the grace-period wait;
        // fire it too so the operation (which never settles here) reaches a
        // terminal cancellation_unverified outcome instead of hanging.
        await tick();
        sleepController.fire(1);
      }
      await pending.catch(() => undefined);
      // superviseOperation must never call release/destroy on the control
      // connection: it is shared across the whole migration run, and its
      // lifecycle belongs to executeVerifiedMigrations, not to any single
      // supervised operation.
      assert.equal(control.releaseCalls.length, 0, `cancel behaviour ${String(behaviour)}: control must not be released`);
    }
  });
});

// 12 ─────────────────────────────────────────────────────────────────────────
test("no unhandled rejection is emitted even when the operation settles after its terminal state was already decided", async () => {
  // withStrictUnhandledRejection wraps every test above already; this test
  // additionally proves a supervised operation that settles long after
  // grace expiry has already been thrown still never surfaces as an
  // unhandled rejection.
  await withStrictUnhandledRejection(async () => {
    const op = deferred<unknown>();
    const { context, sleepController } = buildContext({ operationSettlement: op.promise });
    const pending = superviseOperation(context, "select 1", 5_000);
    await tick();
    sleepController.fire(0);
    await tick();
    sleepController.fire(1); // grace expires first; superviseOperation has now thrown
    await assert.rejects(pending, /cancellation_unverified/);
    // Settle the operation only now, well after the terminal state was
    // selected. Because superviseOperation attached a .then(resolve, reject)
    // handler to it at the very start, this must not produce an
    // unhandledRejection even though nothing awaits `op.promise` any more.
    op.reject(QUERY_CANCELED);
    await new Promise((resolve) => setImmediate(resolve));
  });
});

// 13 ─────────────────────────────────────────────────────────────────────────
test("cancel and operation settle at nearly the same instant, in both orderings", async () => {
  await withStrictUnhandledRejection(async () => {
    // Ordering A: the operation's confirmed-cancellation settlement is
    // observed strictly before the grace-period timer would have fired.
    {
      const op = deferred<unknown>();
      const { context, sleepController, destroyCalls } = buildContext({ operationSettlement: op.promise });
      const pending = superviseOperation(context, "select 1", 5_000);
      await tick();
      sleepController.fire(0);
      await tick();
      op.reject(QUERY_CANCELED); // settles first
      await assert.rejects(pending, /wall_clock_exceeded/, "settlement-before-timer must confirm cancellation");
      assert.equal(destroyCalls(), 0);
    }

    // Ordering B: the grace-period timer fires strictly before the operation
    // ever settles, and the operation only settles afterward.
    {
      const op = deferred<unknown>();
      const { context, sleepController, destroyCalls } = buildContext({ operationSettlement: op.promise });
      const pending = superviseOperation(context, "select 1", 5_000);
      await tick();
      sleepController.fire(0);
      await tick();
      sleepController.fire(1); // timer wins first
      await assert.rejects(pending, /cancellation_unverified/, "timer-before-settlement must never be treated as confirmed");
      op.reject(QUERY_CANCELED); // late settlement must be inert (no unhandled rejection, no second outcome)
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(destroyCalls(), 1);
    }
  });
});

// 14 ─────────────────────────────────────────────────────────────────────────
test("same-turn queuing: operation settlement and the grace-period timer resolved back-to-back with no macrotask gap, both orderings", async () => {
  // Unlike test 13 (where one side settles and is fully observed before the
  // other side is ever touched, or settles only long after the outcome is
  // already decided), this resolves both competing promises within the same
  // event-loop turn — no tick()/setImmediate boundary between them — the way
  // they legitimately could under real timing pressure. Promise.race
  // resolves by which underlying promise actually settles first, which is a
  // function of microtask depth, not source-line order: the supervised
  // operation's settlement passes through extra .then() hops (the
  // resolve/reject-to-OperationSettlement wrapper superviseOperation builds
  // once up front, plus the race-wrapping .then() itself) that the timer's
  // settlement does not, so an operation rejection needs a measured
  // microtask head start (two `await Promise.resolve()` — determined
  // empirically against the real function, not assumed) to reach the race
  // at the same depth as a same-line timer fire.
  // Both variants below still queue their two settlements in the same turn,
  // with no real timer and no macrotask gap; only the microtask depth is
  // balanced so each variant's named winner is the one actually observed,
  // rather than asserting a source-order intuition Promise.race does not
  // itself provide.
  await withStrictUnhandledRejection(async () => {
    // Variant 1: the operation settles, then the timer fires in the same
    // turn, depth-balanced so settlement wins.
    {
      const op = deferred<unknown>();
      const { context, sleepController, destroyCalls } = buildContext({ operationSettlement: op.promise });
      const pending = superviseOperation(context, "select 1", 5_000);
      await tick();
      sleepController.fire(0);
      await tick();
      op.reject(QUERY_CANCELED);
      // Balances the operation settlement's extra .then() hops (measured
      // empirically against the real function, not assumed) so it reaches
      // the race at the same microtask depth as a same-line timer fire;
      // still no macrotask boundary, no real timer, no setImmediate.
      await Promise.resolve();
      await Promise.resolve();
      sleepController.fire(1);
      await assert.rejects(pending, /wall_clock_exceeded/, "operation-settled-first must confirm cancellation even with the timer firing in the same turn");
      assert.equal(destroyCalls(), 0);
    }

    // Variant 2: the timer fires, then the operation settles immediately
    // after, same turn, reversed order — the timer wins.
    {
      const op = deferred<unknown>();
      const { context, sleepController, destroyCalls } = buildContext({ operationSettlement: op.promise });
      const pending = superviseOperation(context, "select 1", 5_000);
      await tick();
      sleepController.fire(0);
      await tick();
      sleepController.fire(1);
      op.reject(QUERY_CANCELED); // settled immediately after, no await between
      await assert.rejects(pending, /cancellation_unverified/, "timer-fired-first must never be treated as confirmed even with the operation settling in the same turn");
      assert.equal(destroyCalls(), 1);
    }
  });
});
