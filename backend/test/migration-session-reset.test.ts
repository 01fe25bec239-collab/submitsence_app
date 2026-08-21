import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import type { MigrationManifest } from "../src/db/migrate/manifest";
import { answerControlSchemaQuery } from "./helpers/control-schema-fixture";
import {
  diagnosticThrowValues,
  hostileThrowValues,
  throws,
  type ThrowInjection,
} from "./helpers/hostile-throw-values";
import { SCHEMA_ADVISORY_LOCK, runMigrationPlan } from "../src/db/migrate/runner";

/**
 * PB-10 Step 3 Phase 2d, focused unit suite for the terminal lifecycle boundary
 * that owns every migration-held pooled PostgreSQL client.
 *
 * These are the lifecycle *races* — duplicate finalization, cleanup after a
 * primary failure, a reset that fails, a reset that never answers, release
 * ordering, listener and timer hygiene, and the acquisition/finalization
 * ordering CRITICAL 1 exists for — which are difficult to force repeatedly
 * against a real server but must hold every single time. They supplement, and
 * never replace, migration-session-reset.pg.test.ts, which proves the same
 * contract against real PostgreSQL sessions handed to a real next borrower.
 *
 * PB-10 Step 3 Phase 2d, HIGH 1: the boundary is not reachable by name at all.
 * The advisory-lock lifecycle owner and the client disposer it creates are
 * module-private declarations inside execute.ts — no runtime export and no
 * emitted `.d.ts` declaration hands either of them to a caller, production or
 * test (asserted directly here, and against the emitted build by the
 * public-surface regression in migration-execute.test.ts). Every case below
 * therefore reaches the boundary exactly the way production reaches it:
 * through `runMigrationPlan(pool)`, whose read-only action runs inside the
 * schema advisory lock and whose pinned control client is disposed of through
 * the very same code path, with the very same exactly-once latch, as an
 * execution run's own connections.
 *
 * The two scenarios that inherently need a *second* migration-owned client —
 * duplicate finalization from two independent owners, and a refusal to reset
 * while registered client-owned work is still unsettled — are proven through
 * `executeMigrations(pool)` in migration-execute.test.ts, where the full
 * two-connection execution harness already exists. The dedicated Phase 2d CI
 * gate enforces both files together, by name.
 */

const repositoryRoot = path.resolve(__dirname, "../..");
const manifest = JSON.parse(
  readFileSync(path.join(repositoryRoot, "db", "migrations", "manifest.json"), "utf8"),
) as MigrationManifest;

type QueryResult = { rows: unknown[]; rowCount: number | null };

const CLEAN_BASELINE = {
  dirty_settings: "0",
  advisory_locks: "0",
  listens: "0",
  prepared_statements: "0",
  cursors: "0",
  temp_objects: "0",
  role_baseline: true,
};

/** The terminal reset sequence, in the only order it may ever be issued in. */
const RESET = ["rollback", "discard all", "baseline-proof"];

/**
 * A pooled client that answers the read-only plan's own queries, the advisory
 * lock protocol, and the terminal reset sequence — the exact traffic the
 * boundary and the plan action generate against a real control connection.
 */
class ResetClient extends EventEmitter {
  /** Real node-postgres exposes this plain-object named-query cache. */
  connection: unknown = { parsedStatements: {} };
  /** Reset statements only, in order: ordering is asserted, never assumed. */
  readonly reset: string[] = [];
  /** Lock, unlock and reset milestones interleaved, so relative order is provable. */
  readonly events: string[] = [];
  /** Terminal actions, in order: exactly one is ever expected per episode. */
  readonly terminal: string[] = [];
  /**
   * Terminal disposition *attempts*, including one that the duplicate-release
   * assertion in `release()` rejects — which is the only observable form the
   * "one ownership episode, one terminal action" invariant has.
   */
  attempts = 0;
  releasedWith: Error | undefined;

  failRollback: Error | undefined;
  failDiscard: Error | undefined;
  hangDiscard = false;
  /** Kills the connection the instant `discard all` is issued, before answering. */
  loseConnectionOnDiscard = false;
  baseline: Record<string, string | boolean> = { ...CLEAN_BASELINE };
  unlockResult = true;
  /** Answers for successive pg_try_advisory_lock probes; the default acquires at once. */
  probes: boolean[] = [true];
  /**
   * Fired from inside the real plan action, at the applied-ledger read: after
   * the advisory lock is held and the control schema has verified, and before
   * the plan is built. This is where a case makes the action itself fail or
   * lose its connection.
   */
  actionHook: (() => Promise<void> | void) | undefined;
  /** Set when this client belongs to a pool that models a real `max` limit. */
  pool: SingleClientPool | undefined;
  /**
   * PB-10 Step 3 Phase 2d final review, CRITICAL 1/2: makes *every*
   * `on('error', …)` registration throw — a client whose EventEmitter contract
   * itself fails (a wrapping proxy, a replaced max-listeners handler, a
   * listener guard that rejects). Unlike a one-shot failure this also breaks
   * the terminal boundary's *own* absorber installation, which is precisely
   * the condition under which the disposer used to reject before issuing any
   * terminal action at all.
   */
  failErrorListener: ThrowInjection;
  /**
   * PB-10 Step 3 Phase 2d final review, CRITICAL 3: makes the terminal
   * `release()` itself throw, after recording that the attempt was made — the
   * one disposal failure a caller can genuinely observe as a rejected
   * disposition promise.
   */
  failRelease: ThrowInjection;

  override on(event: string | symbol, listener: (...args: never[]) => void): this {
    if (event === "error" && this.failErrorListener) throw this.failErrorListener.value;
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    if (sql.includes("set_config")) return { rows: [{ set_config: String(values?.[1]) }], rowCount: 1 };
    if (sql.includes("pg_try_advisory_lock")) {
      this.events.push("probe");
      return { rows: [{ acquired: this.probes.shift() ?? true }], rowCount: 1 };
    }
    if (sql.includes("pg_stat_activity")) {
      this.events.push("diagnose");
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("pg_advisory_unlock")) {
      this.events.push("unlock");
      return { rows: [{ unlocked: this.unlockResult }], rowCount: 1 };
    }
    if (sql === "rollback") {
      this.reset.push(sql);
      this.events.push("rollback");
      if (this.failRollback) throw this.failRollback;
      return { rows: [], rowCount: null };
    }
    if (sql === "discard all") {
      this.reset.push(sql);
      this.events.push("discard all");
      if (this.loseConnectionOnDiscard) {
        // A real socket failure surfaces twice: the statement's own rejection
        // and the client's connection-level 'error' event. Both are emitted,
        // in the order the driver produces them, so the boundary is tested
        // against the real shape rather than a convenient half of it.
        const lost = new Error("connection terminated unexpectedly");
        queueMicrotask(() => this.emit("error", lost));
        throw lost;
      }
      if (this.failDiscard) throw this.failDiscard;
      if (this.hangDiscard) return new Promise<QueryResult>(() => undefined);
      return { rows: [], rowCount: null };
    }
    if (sql.includes("dirty_settings")) {
      this.reset.push("baseline-proof");
      this.events.push("baseline-proof");
      return { rows: [this.baseline], rowCount: 1 };
    }
    // Everything below is the read-only plan action's own traffic.
    if (sql.includes("to_regnamespace")) return { rows: [{ present: true }], rowCount: 1 };
    if (sql.includes("to_regclass")) return { rows: [{ present: false }], rowCount: 1 };
    const controlSchema = answerControlSchemaQuery(sql, {});
    if (controlSchema) return controlSchema as QueryResult;
    if (sql.includes("from migration_control.schema_migrations")) {
      await this.actionHook?.();
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected query: ${sql}`);
  }

  /**
   * How many ownership episodes this client is expected to go through. One,
   * always, except where a test deliberately checks the same client object out
   * twice — which is what pg-pool does on every reuse.
   */
  episodes = 1;

  release(error?: Error): void {
    // PB-10 Step 3 Phase 2d final review, CRITICAL 2: counted first, before the
    // duplicate is rejected. A second disposition throws here, so `terminal`
    // alone can never record one — the reentrancy the independent review
    // demonstrated was invisible to every count that only grew on success.
    this.attempts += 1;
    // pg-pool answers a second release *within one checkout* by throwing; the
    // fake must too, or "exactly one terminal disposition" would assert
    // nothing at all.
    assert.ok(this.terminal.length < this.episodes, "the client was disposed of more than once in one ownership episode");
    this.releasedWith = error;
    this.terminal.push(error ? "destroy" : "release");
    this.events.push(error ? "destroy" : "release");
    // Recorded before it throws: a release that fails is still the one and only
    // terminal action attempted, so a second attempt would be caught above.
    if (this.failRelease) throw this.failRelease.value;
    this.pool?.returned();
  }

  asPoolClient(): PoolClient {
    return this as unknown as PoolClient;
  }
}

/**
 * A pool of exactly one connection — the shape that makes a leaked client
 * fatal rather than merely wasteful. A run that fails to return its client
 * makes the next `connect()` fail loudly here, exactly as a real `max: 1` pool
 * would block forever.
 */
class SingleClientPool {
  connects = 0;
  checkedOut = 0;

  constructor(readonly client: ResetClient) {
    client.pool = this;
  }

  returned(): void {
    this.checkedOut -= 1;
  }

  asPool(): Pool {
    return {
      connect: async (): Promise<PoolClient> => {
        assert.equal(
          this.checkedOut, 0,
          "pool exhausted: a client checked out by an earlier call was never returned to the pool",
        );
        this.connects += 1;
        this.checkedOut += 1;
        return this.client.asPoolClient();
      },
    } as unknown as Pool;
  }
}

/** Runs the real plan path — and therefore the real boundary — over `client`. */
function plan(client: ResetClient, options: Record<string, unknown> = {}): Promise<{ pendingCount: number }> {
  const pool = client.pool ?? new SingleClientPool(client);
  return runMigrationPlan(pool.asPool(), { manifest, ...options }) as Promise<{ pendingCount: number }>;
}

function isPlanDiagnostic(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.message, "Migration plan failed");
  assert.equal((error as Error & { code?: string }).code, "PB10_MIGRATION_PLAN_FAILED");
  assert.equal(error.stack, undefined);
  return true;
}

/** Fails if an uncaughtException or unhandledRejection fires while `run` executes. */
async function withStrictProcessErrors<T>(run: () => Promise<T>): Promise<T> {
  const uncaught: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  try {
    const value = await run();
    // One turn of the loop past the action itself: a rejection abandoned by
    // cleanup surfaces on a later tick, never synchronously.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(uncaught, [], "no uncaught exception may escape the lifecycle boundary");
    assert.deepEqual(unhandled, [], "no unhandled rejection may escape the lifecycle boundary");
    return value;
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
  }
}

test("a healthy client is reset in order and released, never destroyed", async () => {
  const client = new ResetClient();
  const parsedStatements = { before_reset: "select 1" };
  client.connection = { parsedStatements };
  const result = await withStrictProcessErrors(() => plan(client));

  assert.equal(result.pendingCount, manifest.migrations.length);
  assert.deepEqual(client.reset, RESET, "rollback, then discard all, then the baseline proof — in that order");
  assert.deepEqual(client.terminal, ["release"]);
  assert.equal(client.releasedWith, undefined);
  assert.deepEqual((client.connection as { parsedStatements: object }).parsedStatements, {});
  assert.notEqual((client.connection as { parsedStatements: object }).parsedStatements, parsedStatements);
});

test("an absent driver cache shape fails closed and destroys the client", async () => {
  const client = new ResetClient();
  client.connection = undefined;

  await plan(client);

  assert.deepEqual(client.reset, ["rollback", "discard all"]);
  assert.deepEqual(client.terminal, ["destroy"]);
  assert.match(client.releasedWith?.message ?? "", /could not inspect the driver's prepared-statement cache/);
});

test("an unexpected driver cache shape fails closed and destroys the client", async () => {
  const client = new ResetClient();
  client.connection = { parsedStatements: [] };

  await plan(client);

  assert.deepEqual(client.reset, ["rollback", "discard all"]);
  assert.deepEqual(client.terminal, ["destroy"]);
  assert.match(client.releasedWith?.message ?? "", /could not prove the driver's prepared-statement cache clearable/);
});

test("an unprovable driver cache clear fails closed and destroys the client", async () => {
  const parsedStatements = {};
  const client = new ResetClient();
  client.connection = { get parsedStatements() { return parsedStatements; } };

  await plan(client);

  assert.deepEqual(client.reset, ["rollback", "discard all"]);
  assert.deepEqual(client.terminal, ["destroy"]);
  assert.ok(client.releasedWith instanceof Error);
});

test("the reset runs before release, never after: no statement follows the terminal action", async () => {
  const client = new ResetClient();
  await plan(client);

  assert.deepEqual(
    client.events.slice(-4),
    ["rollback", "discard all", "baseline-proof", "release"],
    "the terminal action is the last thing that happens to the client, and the reset immediately precedes it",
  );
});

test("the control client's own reset runs after the advisory unlock, never before it", async () => {
  const client = new ResetClient();
  await plan(client);

  const unlock = client.events.indexOf("unlock");
  assert.ok(unlock >= 0, "the advisory unlock is issued");
  assert.deepEqual(
    client.events.slice(unlock + 1), [...RESET, "release"],
    "DISCARD ALL calls pg_advisory_unlock_all(); resetting first would replace Phase 2c's proven unlock with an unproven one",
  );
  assert.deepEqual(client.terminal, ["release"]);
});

test("a client checked out again by a later run is disposed of again, not silently kept", async () => {
  // pg-pool hands out the *same* PoolClient object on a later checkout, so a
  // disposition latch that outlives one ownership episode makes the second run
  // find the first run's finished outcome and return it unchanged — issuing no
  // reset and, fatally, no release(). The client is then checked out forever;
  // with a production `max: 2` pool the run after that blocks indefinitely.
  const client = new ResetClient();
  client.episodes = 3;
  const pool = new SingleClientPool(client);

  for (const pass of [1, 2, 3]) {
    const result = await plan(client);
    assert.equal(result.pendingCount, manifest.migrations.length, `pass ${pass}: the reused client is reset and returned`);
  }

  assert.equal(pool.connects, 3, "the same pooled client object was genuinely checked out three separate times");
  assert.deepEqual(client.reset, [...RESET, ...RESET, ...RESET], "each checkout gets its own full reset sequence");
  assert.deepEqual(client.terminal, ["release", "release", "release"], "each checkout is returned to the pool exactly once");
  assert.equal(pool.checkedOut, 0, "nothing is left checked out");
});

test("an owner that already knows the session is unusable destroys it without issuing any reset", async () => {
  const client = new ResetClient();
  const cause = new Error("the migration transaction's outcome is unknown");
  client.actionHook = () => { client.emit("error", cause); };

  await assert.rejects(withStrictProcessErrors(() => plan(client)), isPlanDiagnostic);
  assert.deepEqual(client.reset, [], "no statement is issued on a session already known to be unsafe");
  assert.deepEqual(client.terminal, ["destroy"]);
  assert.equal(client.releasedWith, cause, "the destructive release carries the original cause");
  assert.ok(!client.events.includes("unlock"), "an already-uncertain connection is never depended on for a healthy unlock");
});

test("a failed ROLLBACK destroys the client rather than resetting or returning it", async () => {
  const client = new ResetClient();
  client.failRollback = new Error("rollback failed");
  await withStrictProcessErrors(() => plan(client));

  assert.deepEqual(client.reset, ["rollback"], "DISCARD ALL is never attempted once the transaction state is unknown");
  assert.deepEqual(client.terminal, ["destroy"]);
});

test("a failed reset statement destroys the client", async () => {
  const client = new ResetClient();
  client.failDiscard = new Error("DISCARD ALL cannot run inside a transaction block");
  await withStrictProcessErrors(() => plan(client));

  assert.deepEqual(client.reset, ["rollback", "discard all"]);
  assert.deepEqual(client.terminal, ["destroy"]);
});

test("no normal release ever follows a destructive release", async () => {
  // Every destructive path, driven through the one boundary: whatever
  // condemned the session, the client reaches exactly one terminal action and
  // that action is the destructive one. A second, normal release would both
  // hand a poisoned session back to the pool and throw in pg-pool itself.
  for (const [label, prepare] of [
    ["reset failure", (client: ResetClient) => { client.failDiscard = new Error("reset failed"); }],
    ["rollback failure", (client: ResetClient) => { client.failRollback = new Error("rollback failed"); }],
    ["dirty baseline", (client: ResetClient) => { client.baseline = { ...CLEAN_BASELINE, advisory_locks: "1" }; }],
    ["backend loss", (client: ResetClient) => { client.loseConnectionOnDiscard = true; }],
    ["failed unlock", (client: ResetClient) => { client.unlockResult = false; }],
  ] as Array<[string, (client: ResetClient) => void]>) {
    const client = new ResetClient();
    prepare(client);
    await withStrictProcessErrors(() => plan(client).catch(() => undefined));

    assert.deepEqual(client.terminal, ["destroy"], `${label}: exactly one terminal action, and it is destructive`);
    assert.ok(client.releasedWith instanceof Error, `${label}: the destructive release carries a cause`);
    assert.equal(
      client.events.filter((event) => event === "release").length, 0,
      `${label}: no normal release may follow a destructive one`,
    );
  }
});

test("connection loss during the reset destroys the client and raises no unhandled rejection", async () => {
  const client = new ResetClient();
  client.loseConnectionOnDiscard = true;
  // The connection-level 'error' event must land somewhere: on a client the
  // boundary is destroying, the boundary itself owns it.
  await withStrictProcessErrors(() => plan(client));

  assert.deepEqual(client.terminal, ["destroy"]);
});

test("a reset that succeeds but leaves the session dirty is still refused", async () => {
  for (const dirty of [
    { dirty_settings: "1" },
    { advisory_locks: "1" },
    { listens: "1" },
    { prepared_statements: "1" },
    { cursors: "1" },
    { temp_objects: "1" },
    { role_baseline: false },
  ]) {
    const client = new ResetClient();
    client.baseline = { ...CLEAN_BASELINE, ...dirty };
    await plan(client);

    assert.deepEqual(client.terminal, ["destroy"], `a session reporting ${JSON.stringify(dirty)} must never be reused`);
    assert.deepEqual(client.reset, RESET, "the proof is still taken; it is its answer that condemns the session");
  }
});

test("a reset-success baseline is verified, not assumed: a proof returning no row at all is refused", async () => {
  const client = new ResetClient();
  const original = client.query.bind(client);
  client.query = async (sql: string, values?: unknown[]) => {
    const result = await original(sql, values);
    return sql.includes("dirty_settings") ? { rows: [], rowCount: 0 } : result;
  };
  await plan(client);

  assert.deepEqual(client.reset, RESET, "the proof query is genuinely issued");
  assert.deepEqual(client.terminal, ["destroy"]);
});

test("a reset that never answers is abandoned on its budget, and the client is destroyed", async () => {
  const client = new ResetClient();
  client.hangDiscard = true;
  const startedAt = Date.now();
  await withStrictProcessErrors(() => plan(client));

  assert.deepEqual(client.reset, ["rollback", "discard all"]);
  assert.deepEqual(client.terminal, ["destroy"]);
  // The budget is proof of failure, never proof of completion: the outcome is
  // destruction, and it is never reached before the budget genuinely elapsed.
  assert.ok(Date.now() - startedAt >= 4_500, "the reset budget is a real deadline, not an immediate give-up");
});

test("the owner's connection listener is removed exactly once, on every path", async () => {
  for (const [label, prepare] of [
    ["healthy", () => undefined],
    ["reset failure", (client: ResetClient) => { client.failDiscard = new Error("reset failed"); }],
    ["already unusable", (client: ResetClient) => {
      client.actionHook = () => { client.emit("error", new Error("unusable")); };
    }],
  ] as Array<[string, (client: ResetClient) => void]>) {
    const client = new ResetClient();
    prepare(client);
    const before = client.listenerCount("error");
    await plan(client).catch(() => undefined);

    assert.ok(
      client.listenerCount("error") <= before + 1,
      `${label}: the lock owner's own listener must not outlive the client's disposal`,
    );
  }
});

test("a destroyed client keeps exactly one absorbing listener; a returned one keeps none", async () => {
  const returned = new ResetClient();
  await plan(returned);
  assert.equal(
    returned.listenerCount("error"), 0,
    "a client handed back to the pool leaves error handling entirely to the pool",
  );

  const destroyed = new ResetClient();
  destroyed.failDiscard = new Error("reset failed");
  await plan(destroyed);
  assert.equal(
    destroyed.listenerCount("error"), 1,
    "a client nothing will touch again keeps one absorbing listener, so a delayed error cannot crash the process",
  );
});

test("cleanup failure never replaces a primary execution failure", async () => {
  const client = new ResetClient();
  client.failDiscard = new Error("reset failed");
  const primary = new Error("the migration itself failed");
  client.actionHook = () => { throw primary; };

  await assert.rejects(
    withStrictProcessErrors(() => plan(client)),
    (error: unknown) => {
      return isPlanDiagnostic(error);
    },
  );
  assert.deepEqual(client.terminal, ["destroy"], "and the failed cleanup still destroyed the client");
});

test("the boundary leaves no dangling timer: the process can exit immediately after a reset", async () => {
  const client = new ResetClient();
  const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  await plan(client);
  const after = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

  assert.ok(after <= before, "the reset budget's timer is aborted once the reset settles");
});

/**
 * PB-10 Step 3 Phase 2d, CRITICAL 1.
 *
 * The plan path used to check a client out of the pool and only *then* hand it
 * to the lock owner, which validated the caller's lock options before its own
 * ownership boundary existed. An invalid `pollMs` or `budgetMs` therefore
 * rejected while a migration-owned client was already checked out and nothing
 * anywhere would ever release it: zero terminal dispositions, and — against
 * the single-connection pool the CLI plan path actually uses — a pool that is
 * permanently exhausted from the first bad call onward.
 *
 * Every deterministic caller option is now rejected *before* acquisition, and
 * the assertions below fail against the pre-correction implementation on the
 * very first case: `connects` would be 1, and the follow-up plan on the same
 * `max: 1` pool would fail to acquire a client at all.
 */
test("invalid plan lock options are rejected before any client is acquired, and never leak one", async () => {
  const rejected: Array<[string, Record<string, unknown>]> = [
    ["pollMs zero", { pollMs: 0 }],
    ["pollMs negative", { pollMs: -1 }],
    ["pollMs NaN", { pollMs: Number.NaN }],
    ["pollMs infinite", { pollMs: Number.POSITIVE_INFINITY }],
    ["budgetMs negative", { budgetMs: -1 }],
    ["budgetMs NaN", { budgetMs: Number.NaN }],
    ["budgetMs infinite", { budgetMs: Number.POSITIVE_INFINITY }],
    ["now not callable", { now: 0 }],
    ["sleep not callable", { sleep: "soon" }],
    ["diagnose not callable", { diagnose: {} }],
  ];

  for (const [label, options] of rejected) {
    const client = new ResetClient();
    client.episodes = 2;
    const pool = new SingleClientPool(client);

    await assert.rejects(withStrictProcessErrors(() => plan(client, options)), isPlanDiagnostic, `${label}: the option is rejected`);
    assert.equal(pool.connects, 0, `${label}: no client may be checked out before the option is validated`);
    assert.equal(pool.checkedOut, 0, `${label}: nothing is left checked out`);
    assert.deepEqual(client.terminal, [], `${label}: an unacquired client has nothing to dispose of`);
    assert.deepEqual(client.reset, [], `${label}: no session statement is issued at all`);

    // The pool is immediately usable again — the property a leak destroys.
    const result = await plan(client);
    assert.equal(result.pendingCount, manifest.migrations.length, `${label}: the max:1 pool still works`);
    assert.equal(pool.connects, 1);
    assert.deepEqual(client.terminal, ["release"], `${label}: exactly one terminal disposition, and it is not destructive`);
    assert.equal(pool.checkedOut, 0);
  }
});

test("a lock option that can only fail after acquisition still reaches exactly one terminal disposition", async () => {
  // The defensive half of CRITICAL 1: validation before acquisition is not
  // allowed to be the *only* thing standing between a checked-out client and a
  // leak. These overrides pass validation and then throw from inside the lock
  // owner — after the client is held — which must still land on the
  // unconditional finalizer, exactly once, and leave the pool usable.
  const failures: Array<[string, Record<string, unknown>]> = [
    ["now throws", { now: () => { throw new Error("clock unavailable"); } }],
    ["sleep throws", { sleep: () => { throw new Error("sleep unavailable"); }, diagnose: () => undefined, pollMs: 1, budgetMs: 5_000 }],
    ["diagnose throws", { diagnose: () => { throw new Error("diagnostics unavailable"); }, pollMs: 1, budgetMs: 5_000 }],
  ];

  for (const [label, options] of failures) {
    const client = new ResetClient();
    // The two contention-only overrides are never even called unless the lock
    // is genuinely contended on the first probe.
    if (label !== "now throws") client.probes = [false, true];
    client.episodes = 2;
    const pool = new SingleClientPool(client);

    await assert.rejects(withStrictProcessErrors(() => plan(client, options)), isPlanDiagnostic, `${label}: the failure surfaces`);
    assert.equal(pool.connects, 1, `${label}: the client really was acquired first`);
    assert.equal(pool.checkedOut, 0, `${label}: and it was returned`);
    assert.equal(client.terminal.length, 1, `${label}: exactly one terminal disposition`);
    assert.equal(
      client.events.filter((event) => event === "destroy").length === 1
      || client.events.filter((event) => event === "release").length === 1,
      true,
      `${label}: never both a normal and a destructive release`,
    );

    const result = await plan(client);
    assert.equal(result.pendingCount, manifest.migrations.length, `${label}: the max:1 pool remains usable`);
  }
});

/**
 * PB-10 Step 3 Phase 2d final review, CRITICAL 1 and CRITICAL 2.
 *
 * CRITICAL 1: the terminal disposer opened with a bare `client.on('error', …)`
 * — its own absorber installation — before anything guaranteed a `release()`.
 * A client whose EventEmitter contract itself fails therefore rejected the
 * disposal from its very first line and reached *zero* terminal dispositions:
 * the leak the boundary exists to prevent, produced by the boundary.
 *
 * CRITICAL 2: the same failure class reaches the control client through a
 * second door. Its ownership used to begin only after `disposeOnce()` had been
 * constructed outside the protected region, so finalization of an
 * already-acquired connection depended on another lifecycle object being built
 * successfully first.
 *
 * Both are proven here structurally rather than against one known throw site:
 * every `on('error', …)` this client receives fails, so the run's own listener
 * *and* the boundary's absorber *and* any future synchronous setup in that
 * region all fail together. Against the pre-correction implementation the
 * first assertion below fails outright — `terminal` is empty, `checkedOut` is
 * 1, and the follow-up plan cannot obtain a client at all.
 */
test("a control client whose error-listener registration always throws still reaches exactly one terminal disposition", async () => {
  const client = new ResetClient();
  client.episodes = 2;
  const pool = new SingleClientPool(client);
  const brokenEmitter = new Error("the control client refused its error listener");
  client.failErrorListener = throws(brokenEmitter);

  await assert.rejects(withStrictProcessErrors(() => plan(client)), (error: unknown) => {
    return isPlanDiagnostic(error);
  });

  assert.equal(pool.connects, 1, "the client really was checked out before the failure");
  assert.deepEqual(client.terminal, ["destroy"], "exactly one terminal disposition — never zero, never two");
  assert.equal(client.releasedWith, brokenEmitter, "destructive, carrying the original failure as its reason");
  assert.deepEqual(client.reset, [], "a session whose error handling could not be installed is never reset for reuse");
  assert.ok(!client.events.includes("unlock"), "the lock was never acquired, so no unlock is attempted");
  assert.equal(pool.checkedOut, 0, "nothing is left checked out: the bounded pool is not consumed");

  // The property a leak destroys: the single-connection pool still works.
  client.failErrorListener = undefined;
  const result = await plan(client);
  assert.equal(result.pendingCount, manifest.migrations.length, "the max:1 pool remains usable");
  assert.deepEqual(client.terminal, ["destroy", "release"], "the second episode is finalized on its own terms");
});

/**
 * PB-10 Step 3 Phase 2d final review, CRITICAL 3.
 *
 * The control client's disposal used to be awaited *unguarded* inside the lock
 * owner's `finally`. An exception thrown from a `finally` discards whatever the
 * `try` was already failing with, so a disposal that rejected silently erased
 * the migration's own primary failure and reported the cleanup failure in its
 * place — a caller would see "release called on an already-released client"
 * instead of the migration error that actually ended the run.
 *
 * All four combinations are asserted, in both cleanup flavours the boundary can
 * produce: a failed advisory unlock, and a failed terminal disposition.
 */
test("primary and cleanup failures compose: the migration's own error is never replaced by a cleanup error", async () => {
  const primary = new Error("the migration itself failed");
  const disposalFailure = new Error("release called on a client which has already been released");

  // A: action succeeds, cleanup succeeds.
  {
    const client = new ResetClient();
    const result = await withStrictProcessErrors(() => plan(client));
    assert.equal(result.pendingCount, manifest.migrations.length);
    assert.deepEqual(client.terminal, ["release"], "A: one terminal disposition, healthy");
  }

  // B1: action succeeds, cleanup (the advisory unlock) fails.
  {
    const client = new ResetClient();
    client.unlockResult = false;
    await assert.rejects(withStrictProcessErrors(() => plan(client)), (error: unknown) => {
      isPlanDiagnostic(error);
      assert.ok(!(error instanceof AggregateError), "B1: a lone failure is thrown as itself, not wrapped");
      return true;
    });
    assert.deepEqual(client.terminal, ["destroy"], "B1: an unproven unlock condemns the session");
  }

  // B2: action succeeds, the terminal disposition itself fails.
  {
    const client = new ResetClient();
    client.failRelease = throws(disposalFailure);
    await assert.rejects(withStrictProcessErrors(() => plan(client)), (error: unknown) => {
      return isPlanDiagnostic(error);
    });
    assert.deepEqual(client.terminal, ["release"], "B2: exactly one terminal action was attempted");
  }

  // C: action fails, cleanup succeeds.
  {
    const client = new ResetClient();
    client.actionHook = () => { throw primary; };
    await assert.rejects(withStrictProcessErrors(() => plan(client)), (error: unknown) => {
      return isPlanDiagnostic(error);
    });
    assert.deepEqual(client.terminal, ["release"], "C: a clean session is still returned to the pool");
  }

  // D1: action fails and cleanup (the advisory unlock) fails.
  {
    const client = new ResetClient();
    client.actionHook = () => { throw primary; };
    client.unlockResult = false;
    await assert.rejects(withStrictProcessErrors(() => plan(client)), (error: unknown) => {
      assert.ok(error instanceof AggregateError, "D1: both failures are retained");
      assert.equal(error.errors.length, 2, "D1: and the cleanup failure is retained alongside it");
      assert.ok(error.errors.every(isPlanDiagnostic));
      return true;
    });
    assert.deepEqual(client.terminal, ["destroy"], "D1: exactly one terminal disposition still holds");
  }

  // D2: action fails and the terminal disposition itself fails — the exact
  // shape that used to erase the primary failure entirely.
  {
    const client = new ResetClient();
    client.actionHook = () => { throw primary; };
    client.failRelease = throws(disposalFailure);
    await assert.rejects(withStrictProcessErrors(() => plan(client)), (error: unknown) => {
      assert.ok(error instanceof AggregateError, "D2: both failures are retained");
      assert.equal(error.errors.length, 2);
      assert.ok(error.errors.every(isPlanDiagnostic));
      return true;
    });
    assert.deepEqual(client.terminal, ["release"], "D2: exactly one terminal action was attempted");
  }
});

test("the disposer is reachable only through an approved entry point, never as a module export", async () => {
  const runner = await import("../src/db/migrate/runner");
  const execute = await import("../src/db/migrate/execute");
  const forbidden = /dispose|reset|discard|disposition|baseline|acquireClient|sessionReset|AdvisoryLock/i;
  for (const [name, module_] of [["runner", runner], ["execute", execute]] as const) {
    for (const key of Object.keys(module_)) {
      assert.doesNotMatch(key, forbidden, `${name}.ts must not export a reset coordinator, lock owner or client disposer: ${key}`);
    }
  }
  // The specific capability the Phase 2d review found reachable: the schema
  // advisory-lock lifecycle owner, whose callback carried the disposer.
  assert.equal("withSchemaAdvisoryLock" in runner, false, "the lock lifecycle owner is not a runner export");
  assert.equal("withSchemaAdvisoryLock" in execute, false, "nor an execute export");
  // And no mutable registry through which one could be installed.
  for (const value of [...Object.values(runner), ...Object.values(execute)]) {
    assert.ok(
      typeof value !== "object" || value === null || !("set" in value),
      "no mutable registry is exported from the migration modules",
    );
  }
});

test("the advisory lock key is untouched by Phase 2d", () => {
  assert.deepEqual([...SCHEMA_ADVISORY_LOCK], [1398096461, 1]);
});

// ════════════════════════════════════════════════════════════════════════════
// PB-10 Step 3 Phase 2d final review, CRITICAL 1 — total error normalization
// on the CONTROL ownership path.
//
// The disposer converts a caught value to an Error from inside the `catch` that
// stands between an already-acquired client and its terminal `release()`:
//
//     } catch (error) {
//       destroy ??= errorValue(error);   // was: new Error(String(error))
//     }
//
// `String(x)` performs ToPrimitive, so a legal thrown value with no usable
// primitive conversion — `Object.create(null)` is the minimal one — made the
// conversion itself throw. The `catch` then threw, the disposal rejected before
// reaching `release()`, and the control client stayed checked out forever. The
// independent review demonstrated exactly this, with zero disposition attempts.
//
// Normalization is now total: every JavaScript value yields an Error and none
// of them can abort a disposition. These cases prove it through the real
// boundary (`runMigrationPlan` → `withSchemaAdvisoryLock` → the disposer), not
// against the conversion function in isolation, because "the conversion does
// not throw" is only interesting insofar as the client is still released.
for (const { name, make } of hostileThrowValues) {
  test(`phase2d: a control listener throwing ${name} still reaches exactly one terminal disposition`, async () => {
    const client = new ResetClient();
    const pool = new SingleClientPool(client);
    client.failErrorListener = throws(make());

    let reported: unknown;
    await assert.rejects(withStrictProcessErrors(() => plan(client)), (error: unknown) => {
      reported = error;
      return true;
    });

    // The finding itself is asserted first: zero attempts before the fix.
    assert.equal(pool.connects, 1, "the control client really was checked out before the failure");
    assert.equal(client.attempts, 1, "exactly one terminal disposition attempt — never zero, never two");
    // Whatever came back is a usable Error — never the hostile value itself,
    // and never a TypeError produced by trying to describe it.
    assert.ok(reported instanceof Error, "a usable Error reaches the caller");
    assert.deepEqual(client.terminal, ["destroy"], "and it completed, destructively");
    assert.ok(client.releasedWith instanceof Error, "the destroy reason is a real Error, not the raw hostile value");
    assert.deepEqual(client.reset, [], "a session whose error handling could not be installed is never reset for reuse");
    assert.equal(pool.checkedOut, 0, "nothing is left checked out: the bounded pool is not consumed");
  });
}

// The other half of totality: values the language *can* convert without running
// user code must stay diagnostically useful rather than being flattened into
// the safe fallback. `undefined`, `null` and `false` are included deliberately —
// they are legal throw operands, and a truthiness-based injection would quietly
// refuse to test them at all.
for (const { name, make } of diagnosticThrowValues) {
  test(`phase2d: a control listener throwing ${name} is normalized without losing its text`, async () => {
    const client = new ResetClient();
    const pool = new SingleClientPool(client);
    const thrown = make();
    client.failErrorListener = throws(thrown);

    let reported: Error | undefined;
    await assert.rejects(withStrictProcessErrors(() => plan(client)), (error: unknown) => {
      assert.ok(error instanceof Error, "a usable Error reaches the caller");
      reported = error;
      return true;
    });

    // String(x) on a primitive is defined by the language and runs no user
    // code, so the value's own text is safe to keep — and keeping it is what
    // makes the diagnostic worth having.
    assert.equal(reported?.message, "Migration plan failed", "raw primitive text is removed at the public boundary");
    assert.equal(client.attempts, 1, "exactly one terminal disposition attempt");
    assert.deepEqual(client.terminal, ["destroy"], "and it completed, destructively");
    assert.equal(pool.checkedOut, 0, "nothing is left checked out");
  });
}

test("phase2d: a hostile primary throw value composes deterministically with an ordinary cleanup failure", async () => {
  // Requirement F of the review: the *primary* failure is the unconvertible
  // one, and an ordinary cleanup Error arrives alongside it. Composition must
  // be deterministic and must not throw while building the AggregateError.
  const client = new ResetClient();
  const hostile = Object.create(null) as unknown;
  client.actionHook = () => { throw hostile; };
  client.unlockResult = false;

  await assert.rejects(withStrictProcessErrors(() => plan(client)), (error: unknown) => {
    assert.ok(error instanceof AggregateError, "both failures are retained");
    assert.equal(error.errors.length, 2, "and only those two");
    assert.ok(error.errors.every(isPlanDiagnostic), "both members are rebuilt as fixed public diagnostics");
    return true;
  });

  assert.equal(client.attempts, 1, "exactly one terminal disposition attempt");
  assert.deepEqual(client.terminal, ["destroy"], "an unproven unlock condemns the session");
});

test("phase2d: an ordinary primary failure survives a hostile cleanup throw value", async () => {
  // Requirement E, mirrored on the control path: the migration's own Error must
  // remain the primary failure *by identity* even when the cleanup that follows
  // throws something that cannot be described at all.
  const client = new ResetClient();
  const primary = new Error("the migration plan action failed");
  client.actionHook = () => { throw primary; };
  client.failRelease = throws(Object.create(null) as unknown);

  await assert.rejects(withStrictProcessErrors(() => plan(client)), (error: unknown) => {
    assert.ok(error instanceof AggregateError, "both failures are retained");
    assert.equal(error.errors.length, 2);
    assert.ok(error.errors.every(isPlanDiagnostic), "both members are rebuilt as fixed public diagnostics");
    return true;
  });

  assert.equal(client.attempts, 1, "exactly one terminal disposition attempt was still made");
});

// ════════════════════════════════════════════════════════════════════════════
// PB-10 Step 3 Phase 2d final review, CRITICAL 2 — the ownership claim must be
// published before any reentrant operation, on the CONTROL path too.
//
// Node's EventEmitter emits `newListener` *synchronously, before* the listener
// is actually added. The disposer's first act is to install its own 'error'
// absorber, so a real `newListener` handler runs inside the disposal body while
// the episode latch was still being populated. This is the genuine native
// semantic, not an invented one — `super.on` below is Node's own implementation.
test("phase2d: a native newListener handler firing inside the control disposer cannot start a second disposition", async () => {
  const client = new ResetClient();
  const pool = new SingleClientPool(client);
  let reentries = 0;
  client.on("newListener", (event: string, listener: { name?: string }) => {
    // Gated on the *disposer's own* absorber, by identity: that installation is
    // the synchronous window that existed before the disposal body's first
    // `await`, and it is the one the review re-entered. The lock owner's
    // earlier `on('error', onConnectionError)` is a different, earlier window.
    if (event !== "error" || listener?.name !== "reportSanitizedPoolError" || reentries > 0) return;
    reentries += 1;
    // The only reentrant path a control client's own emitter can reach: a
    // connection-level failure observed from inside the disposal it is part of.
    client.emit("error", new Error("the control connection died inside its own disposer"));
  });

  await withStrictProcessErrors(() => plan(client));

  assert.equal(reentries, 1, "the reentrant path really was taken, from inside the disposal body");
  assert.equal(client.attempts, 1, "one ownership episode, exactly one terminal disposition attempt");
  assert.deepEqual(client.reset, RESET, "and exactly one reset sequence, in order — never a second racing it");
  assert.equal(pool.checkedOut, 0, "nothing is left checked out");
});

test("phase2d: the same client checked out by a later episode is still disposed of independently after a reentrant one", async () => {
  // Requirement H: the latch is per-episode, so a pool that hands the very same
  // PoolClient object back out later must not find a finished disposition and
  // silently skip the new one. Proven *after* a reentrant episode, because a
  // claim that leaked across episodes would show up here and nowhere else.
  const client = new ResetClient();
  client.episodes = 2;
  const pool = new SingleClientPool(client);
  let reentries = 0;
  const onNewListener = (event: string, listener: { name?: string }): void => {
    if (event !== "error" || listener?.name !== "reportSanitizedPoolError" || reentries > 0) return;
    reentries += 1;
    client.emit("error", new Error("the control connection died inside its own disposer"));
  };
  client.on("newListener", onNewListener);

  await withStrictProcessErrors(() => plan(client));
  assert.equal(reentries, 1, "the first episode really did take the reentrant path");
  assert.equal(client.attempts, 1, "the first episode: exactly one terminal disposition attempt");

  client.off("newListener", onNewListener);
  const result = await withStrictProcessErrors(() => plan(client));
  assert.equal(result.pendingCount, manifest.migrations.length, "the max:1 pool is still usable");
  assert.equal(client.attempts, 2, "the later episode disposes of the same client object again, on its own terms");
  assert.deepEqual(client.terminal, ["release", "release"], "each episode reached its own terminal action");
  assert.equal(pool.checkedOut, 0, "and nothing is left checked out");
});
