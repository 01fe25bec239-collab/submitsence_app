import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test, { after, before } from "node:test";
import { Client, Pool } from "pg";
import { superviseOperation, type SupervisedOperationContext } from "../src/db/migrate/supervision";
import { withSchemaAdvisoryLock } from "../src/db/migrate/runner";

/**
 * PB-10 Step 3 Phase 2a: cancellation-confirmation hardening, real
 * PostgreSQL contract. Registered only when a disposable target is
 * supplied, matching migration-execute.pg.test.ts's own gating exactly, so
 * the default suite gains no ungated PostgreSQL dependency.
 *
 *   MIGRATION_TEST_DATABASE_URL=postgres://... node --import tsx --test test/migration-execute-supervision.pg.test.ts
 *
 * superviseOperation needs no migration_control installation and touches no
 * application schema — it only supervises one statement on a caller-
 * supplied context — so, unlike migration-execute.pg.test.ts, these tests
 * need no control-schema install/reset per case. The real sleep from
 * node:timers/promises is used throughout (the same one execute.ts itself
 * uses in production), with genuinely short, comfortably-separated budgets
 * (never a race decided by which of two close timings wins) so the whole
 * file still runs in well under two seconds of real wall-clock time.
 *
 * Deliberately narrow in scope: the exact-ordering "cancellation begins,
 * then the operation settles" contract — in both directions — is proven
 * deterministically (no real timers, no database) by the unit suite in
 * migration-execute-supervision.test.ts. Constructing that exact race
 * against a real server is fundamentally non-deterministic (it depends on
 * PostgreSQL's own interrupt-check timing, which this suite has no way to
 * control), so this file does not attempt it. Its job is narrower and fully
 * deterministic: proving the real-database facts the state machine relies
 * on — genuine cancellation really does produce SQLSTATE 57014, a bare
 * "true" from pg_cancel_backend is not by itself proof of anything, a
 * forced control failure is handled, a discarded connection is truly gone,
 * and nothing leaks across repetitions.
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
  const realSleep = (milliseconds: number): Promise<void> => delay(milliseconds, undefined, { ref: false });

  let admin: Client;
  const pools: Pool[] = [];
  const newPool = (max = 2): Pool => {
    const pool = new Pool({ connectionString: databaseUrl, max, application_name: "pb10-supervision-contract" });
    pools.push(pool);
    return pool;
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
    admin = new Client({ connectionString: databaseUrl, application_name: "pb10-supervision-admin" });
    await admin.connect();
  });

  after(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.end();
  });

  test("pg: a real pg_sleep operation is cancelled and produces SQLSTATE 57014", async () => {
    const pool = newPool();
    const control = await pool.connect();
    const execution = await pool.connect();
    try {
      const context: SupervisedOperationContext = {
        entry: { id: "0101" },
        control,
        execution,
        sleep: realSleep,
        now: Date.now,
        destroyExecution: () => undefined,
      };
      const startedAt = Date.now();
      await assert.rejects(
        superviseOperation(context, "select pg_sleep(5)", 200),
        /wall_clock_exceeded/,
      );
      // Real proof of a genuinely cancelled (not merely timed-out client-side)
      // backend: the whole thing finished in a couple of seconds, not the 5s
      // pg_sleep would have taken had cancellation not actually interrupted it.
      assert.ok(Date.now() - startedAt < 4_000, "the backend must have actually been cancelled, not merely abandoned");
    } finally {
      control.release();
      execution.release();
    }
  });

  test("pg: pg_cancel_backend against a backend with no active query is not by itself proof of cancellation", async () => {
    // A deterministic, database-level fact, independent of any race: the
    // signal is accepted (returns true) purely because the target PID
    // exists and is reachable — regardless of whether anything is running
    // there to interrupt. superviseOperation's contract never trusts a bare
    // "true" for exactly this reason (requirement: pg_cancel_backend
    // returning true only means PostgreSQL accepted the request).
    const pool = newPool();
    const target = await pool.connect();
    try {
      const pid = await backendPid(target);
      // The connection is idle right now: backendPid's own query has
      // already completed and nothing else has been issued on it.
      const cancelResult = await admin.query<{ pg_cancel_backend: boolean }>(
        "select pg_cancel_backend($1) as pg_cancel_backend",
        [pid],
      );
      assert.equal(cancelResult.rows[0]?.pg_cancel_backend, true, "the signal is accepted even with nothing to cancel");

      // Prove nothing was actually affected: the same connection remains
      // fully healthy and answers a fresh query normally, with no trace of
      // SQLSTATE 57014 anywhere.
      const probe = await target.query<{ one: number }>("select 1 as one");
      assert.equal(probe.rows[0]?.one, 1);
    } finally {
      target.release();
    }
  });

  test("pg: a forced control-connection failure causes the execution connection to be discarded", async () => {
    const pool = newPool();
    const control = await pool.connect();
    const execution = await pool.connect();
    let destroyed = false;
    // Terminating this backend out from under a live client makes the
    // driver emit an 'error' event on it; EventEmitter throws an
    // uncaughtException for an 'error' event with no listener, so this must
    // be attached before the kill, exactly as production code
    // (withSchemaAdvisoryLock's onControlError) attaches one to the real
    // control connection.
    control.on("error", () => undefined);
    try {
      const controlPid = await backendPid(control);
      const context: SupervisedOperationContext = {
        entry: { id: "0101" },
        control,
        execution,
        sleep: realSleep,
        now: Date.now,
        destroyExecution: () => { destroyed = true; },
      };

      // Kill the control backend well before the 100ms budget expires (a
      // wide, comfortable 70ms margin — not a close race), so that when
      // superviseOperation later tries to issue pg_cancel_backend over
      // `control`, that connection is already dead and the query throws —
      // the "cancellation control connection fails" case.
      const pending = superviseOperation(context, "select pg_sleep(5)", 100);
      await delay(30);
      await admin.query("select pg_terminate_backend($1)", [controlPid]);

      await assert.rejects(pending, /cancellation_unverified/);
      assert.equal(destroyed, true, "the execution connection must be discarded when the cancellation request cannot even be issued");
    } finally {
      // The now-dead control connection cannot be released normally; discard it.
      control.release(new Error("control backend was terminated by this test"));
      execution.release(new Error("execution left mid pg_sleep after an unverified cancellation"));
    }
  });

  test("pg: a discarded execution connection is never handed back out by the pool", async () => {
    const pool = newPool(1); // exactly one slot: whatever connect() returns next must be a fresh physical connection
    const execution = await pool.connect();
    const firstPid = await backendPid(execution);

    // Simulate exactly what executeVerifiedMigrations's finally block does
    // after a superviseOperation-driven destroyExecution(): release with an
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

  test("pg: repeated confirmed and unverified cancellation cycles are stable, with no leaked clients", async () => {
    const pool = newPool(2);

    const confirmedCycle = async (): Promise<void> => {
      const control = await pool.connect();
      const execution = await pool.connect();
      const context: SupervisedOperationContext = {
        entry: { id: "0101" },
        control,
        execution,
        sleep: realSleep,
        now: Date.now,
        destroyExecution: () => undefined,
      };
      await assert.rejects(superviseOperation(context, "select pg_sleep(5)", 100), /wall_clock_exceeded/);
      control.release();
      execution.release();
    };

    const unverifiedCycle = async (): Promise<void> => {
      const control = await pool.connect();
      const execution = await pool.connect();
      control.on("error", () => undefined);
      let destroyed = false;
      const controlPid = await backendPid(control);
      const context: SupervisedOperationContext = {
        entry: { id: "0101" },
        control,
        execution,
        sleep: realSleep,
        now: Date.now,
        destroyExecution: () => { destroyed = true; },
      };
      const pending = superviseOperation(context, "select pg_sleep(5)", 100);
      await delay(30);
      await admin.query("select pg_terminate_backend($1)", [controlPid]);
      await assert.rejects(pending, /cancellation_unverified/);
      assert.equal(destroyed, true);
      control.release(new Error("control backend was terminated by this test"));
      execution.release(new Error("execution left mid pg_sleep after an unverified cancellation"));
    };

    for (let iteration = 0; iteration < 3; iteration += 1) {
      await confirmedCycle();
      assert.equal(pool.waitingCount, 0, `iteration ${iteration} (confirmed): no caller left waiting on the pool`);
      assert.equal(pool.totalCount, pool.idleCount, `iteration ${iteration} (confirmed): no connection leaked as still-checked-out`);

      await unverifiedCycle();
      assert.equal(pool.waitingCount, 0, `iteration ${iteration} (unverified): no caller left waiting on the pool`);
      assert.equal(pool.totalCount, pool.idleCount, `iteration ${iteration} (unverified): no connection leaked as still-checked-out`);
    }
  });

  // Real production-path control-client ownership: withSchemaAdvisoryLock —
  // the actual function fixed in this correction — against a real
  // PostgreSQL control backend that is genuinely terminated (not merely a
  // synthetic 'error' event) around the same window an action's own
  // cancellation-driven failure is being handled and the advisory unlock is
  // attempted. This proves the fix holds under real I/O timing, not just
  // against the fully deterministic fakes used elsewhere in this suite.
  test("pg: a real control-backend termination while control is still held ends in exactly one destructive release, with no uncaught client error", async () => {
    const pool = newPool(2);
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const control = await pool.connect();
        // Held only to prove the pool has no leaked/uncounted clients
        // alongside control; its own destruction is already proven through
        // the full production chain (with fakes) by the "both clients are
        // destroyed exactly once..." test in migration-execute.test.ts —
        // this test's focus is control's ownership contract specifically,
        // under a genuine real-PostgreSQL backend termination.
        const execution = await pool.connect();
        try {
          const controlPid = await backendPid(control);

          // The action deliberately holds the ownership window open for a
          // real, comfortable interval (standing in for real supervision
          // work — issuing pg_cancel_backend, awaiting its response, etc.)
          // before failing, so the termination fired below reliably lands
          // while withSchemaAdvisoryLock still owns this connection — not,
          // as an instantaneous throw would produce, only after ownership
          // has already been handed back to the pool healthily. Once
          // released, a connection sitting idle in the pool is pg.Pool's
          // own responsibility (via pool.on('error', ...)), not this
          // function's — a separate, pre-existing concern outside this
          // ownership fix's scope.
          const pending = withSchemaAdvisoryLock(control, async () => {
            await delay(200);
            throw new Error("[cancellation_unverified] migration 0101: cancellation request was not accepted by PostgreSQL");
          });

          // A handler is attached to `pending` here, in the same
          // synchronous step it is created in — via assert.rejects, run
          // concurrently with the timed termination below — so it is never
          // briefly unhandled while the real delay elapses. The outcome may
          // surface as either the action's own cancellation_unverified or
          // the connection failure itself (connectionLost races the action
          // directly — pre-existing behaviour), so no specific pattern is
          // asserted here; what matters is that it rejects exactly once,
          // cleanly, with no uncaught client error.
          await Promise.all([
            assert.rejects(pending),
            (async () => {
              // Fired at a wide, comfortable 75ms — well inside the 200ms
              // window the action above deliberately holds open, not a
              // tight race against it — so the connection is genuinely
              // still owned by withSchemaAdvisoryLock when it dies.
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
      // Give any delayed socket teardown from the terminated backends a
      // chance to surface before asserting no uncaught client error.
      await delay(300);
      process.removeListener("uncaughtException", onUncaught);
    }
    assert.deepEqual(uncaught, [], `no uncaught client error across repeated runs: ${String(uncaught[0])}`);
  });
}
