import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import type { MigrationManifest } from "../src/db/migrate/manifest";
import {
  answerControlSchemaQuery,
  type ControlSchemaDrift,
} from "./helpers/control-schema-fixture";
import {
  SCHEMA_ADVISORY_LOCK,
  buildMigrationPlan,
  renderMigrationPlan,
  runMigrationPlan,
  verifyControlSchema,
  withSchemaAdvisoryLock,
  type AppliedMigrationRow,
} from "../src/db/migrate/runner";

const repositoryRoot = path.resolve(__dirname, "../..");
const manifest = JSON.parse(
  readFileSync(path.join(repositoryRoot, "db", "migrations", "manifest.json"), "utf8"),
) as MigrationManifest;

function applied(index: number, overrides: Partial<AppliedMigrationRow> = {}): AppliedMigrationRow {
  const entry = manifest.migrations[index];
  return {
    migration_id: entry.id,
    ordinal: index + 1,
    filename: entry.filename,
    manifest_checksum_sha256: entry.sha256,
    applied_checksum_sha256: entry.sha256,
    lifecycle_phase: entry.lifecyclePhase,
    operation_categories: [...entry.operationCategories],
    execution_mode: entry.executionMode,
    applied_at: "2030-01-01T00:00:00.000Z",
    run_id: "10000000-0000-4000-8000-000000000001",
    baselined: false,
    source_git_sha: "a".repeat(40),
    executor_image_digest: `sha256:${"b".repeat(64)}`,
    ...overrides,
  };
}

test("empty, partial, and complete valid applied prefixes produce deterministic pending plans", () => {
  const empty = buildMigrationPlan(manifest, []);
  assert.equal(empty.pendingCount, 24);
  assert.equal(empty.appliedCount, 0);

  const prefix = buildMigrationPlan(manifest, manifest.migrations.slice(0, 7).map((_, index) => applied(index)));
  assert.equal(prefix.appliedCount, 7);
  assert.deepEqual(prefix.pendingMigrations.map(({ id }) => id), manifest.migrations.slice(7).map(({ id }) => id));

  const complete = buildMigrationPlan(manifest, manifest.migrations.map((_, index) => applied(index)));
  assert.equal(complete.pendingCount, 0);
  assert.equal(complete.totalDeclaredWallClockMs, 0);
  assert.equal(renderMigrationPlan(prefix), renderMigrationPlan(buildMigrationPlan(manifest, manifest.migrations.slice(0, 7).map((_, index) => applied(index)))));
});

test("unknown and non-prefix applied histories are rejected", () => {
  assert.throws(
    () => buildMigrationPlan(manifest, [applied(0, { migration_id: "0100" })]),
    /not present in the manifest/,
  );
  assert.throws(
    () => buildMigrationPlan(manifest, [applied(1)]),
    /ordinal prefix|ordering or migration ID mismatch/,
  );
  assert.throws(
    () => buildMigrationPlan(manifest, [applied(0, { ordinal: 2 })]),
    /contiguous ordinal prefix/,
  );
});

test("applied metadata must match filename, checksums, phase, categories, and mode", () => {
  for (const [overrides, message] of [
    [{ filename: "0001_wrong.sql" }, /Filename mismatch/],
    [{ manifest_checksum_sha256: "0".repeat(64) }, /Manifest checksum mismatch/],
    [{ applied_checksum_sha256: "0".repeat(64) }, /Applied checksum mismatch/],
    [{ lifecycle_phase: "contract" }, /Lifecycle phase mismatch/],
    [{ operation_categories: ["index"] }, /Operation category mismatch/],
    [{ execution_mode: "transactional" }, /Execution mode mismatch/],
  ] as Array<[Partial<AppliedMigrationRow>, RegExp]>) {
    assert.throws(() => buildMigrationPlan(manifest, [applied(0, overrides)]), message);
  }
});

test("only baselined legacy rows may have null applied checksums", () => {
  assert.throws(
    () => buildMigrationPlan(manifest, [applied(0, { applied_checksum_sha256: null })]),
    /invalid null applied checksum/,
  );
  const plan = buildMigrationPlan(manifest, [applied(0, {
    baselined: true,
    applied_checksum_sha256: null,
  })]);
  assert.equal(plan.appliedCount, 1);

  const futureManifest: MigrationManifest = {
    ...manifest,
    migrations: [
      ...manifest.migrations,
      {
        ...manifest.migrations[0],
        id: "0100",
        filename: "0100_expand_test.sql",
        executionMode: "transactional",
      },
    ],
  };
  const rows = manifest.migrations.map((_, index) => applied(index));
  rows.push({
    ...applied(0),
    migration_id: "0100",
    ordinal: 25,
    filename: "0100_expand_test.sql",
    execution_mode: "transactional",
    baselined: true,
    applied_checksum_sha256: null,
  });
  assert.throws(() => buildMigrationPlan(futureManifest, rows), /exceeds the legacy boundary/);
});

test("rendered plans contain operational metadata but no SQL or connection secrets", () => {
  const rendered = renderMigrationPlan(buildMigrationPlan(manifest, []));
  assert.match(rendered, /"pendingCount": 24/);
  assert.match(rendered, /PB-10 Step 3 execution is implemented; migrate:plan remains read-only/);
  assert.doesNotMatch(rendered, /postgres(?:ql)?:\/\/|password|BEGIN;|CREATE TABLE|SELECT \*/i);
});

type QueryResult = { rows: unknown[]; rowCount: number | null };

class LockClient extends EventEmitter {
  readonly events: string[] = [];
  readonly queries: Array<{ sql: string; values?: unknown[] }> = [];
  probes: boolean[] = [true];
  diagnostics: unknown[] = [];
  unlockResult = true;
  unlockError: Error | undefined;
  releasedWith: Error | undefined;
  releaseCount = 0;
  activeQueries = 0;
  maxActiveQueries = 0;
  /**
   * When set, the pg_advisory_unlock query returns a promise this test
   * controls directly (via settleUnlock) instead of resolving immediately —
   * so a test can interleave a client 'error' event with the unlock attempt
   * at an exact, deterministic point, rather than racing real timing.
   */
  private unlockGate: { resolve: () => void; reject: (error: Error) => void } | undefined;
  unlockStarted = false;

  settleUnlock(): void {
    assert.ok(this.unlockGate, "settleUnlock called before the unlock query was issued");
    if (this.unlockError) this.unlockGate!.reject(this.unlockError);
    else this.unlockGate!.resolve();
  }

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.queries.push({ sql, values });
    this.activeQueries += 1;
    this.maxActiveQueries = Math.max(this.maxActiveQueries, this.activeQueries);
    try {
      if (sql.includes("set_config")) {
        return { rows: [{ set_config: String(values?.[1]) }], rowCount: 1 };
      }
      if (sql.includes("pg_try_advisory_lock")) {
        this.events.push("probe");
        assert.deepEqual(values, [...SCHEMA_ADVISORY_LOCK]);
        return { rows: [{ acquired: this.probes.shift() ?? false }], rowCount: 1 };
      }
      if (sql.includes("pg_stat_activity")) {
        this.events.push("diagnose");
        return { rows: this.diagnostics, rowCount: this.diagnostics.length };
      }
      if (sql.includes("pg_advisory_unlock")) {
        this.events.push("unlock");
        assert.deepEqual(values, [...SCHEMA_ADVISORY_LOCK]);
        this.unlockStarted = true;
        if (this.gateUnlock) {
          await new Promise<void>((resolve, reject) => {
            this.unlockGate = { resolve, reject };
          });
          return { rows: [{ unlocked: this.unlockResult }], rowCount: 1 };
        }
        if (this.unlockError) throw this.unlockError;
        return { rows: [{ unlocked: this.unlockResult }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    } finally {
      this.activeQueries -= 1;
    }
  }

  gateUnlock = false;

  release(error?: Error): void {
    this.releasedWith = error;
    this.releaseCount += 1;
    this.events.push(error ? "release-error" : "release");
  }
}

/** Fails if an uncaughtException or unhandledRejection fires while `run` executes. */
async function withStrictProcessErrors<T>(run: () => Promise<T>): Promise<T> {
  const uncaught: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);
  try {
    return await run();
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUnhandled);
    assert.deepEqual(uncaught, [], `unexpected uncaughtException: ${String(uncaught[0])}`);
    assert.deepEqual(unhandled, [], `unexpected unhandledRejection: ${String(unhandled[0])}`);
  }
}

test("schema lock uses exact keys and unlocks before normal release", async () => {
  const client = new LockClient();
  const result = await withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
    client.events.push("action");
    return 7;
  });
  assert.equal(result, 7);
  assert.deepEqual(client.events, ["probe", "action", "unlock", "release"]);
});

test("lock contention retries sequentially with bounded injectable timing", async () => {
  const client = new LockClient();
  client.probes = [false, false, true];
  let clock = 0;
  const sleeps: number[] = [];
  await withSchemaAdvisoryLock(client as unknown as PoolClient, async () => undefined, {
    pollMs: 5,
    budgetMs: 20,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    diagnose: () => undefined,
  });
  assert.deepEqual(sleeps, [5, 5]);
  assert.equal(client.maxActiveQueries, 1);
  assert.equal(client.events.filter((event) => event === "probe").length, 3);
});

test("lock timeout is bounded and still releases a non-lock-bearing client", async () => {
  const client = new LockClient();
  client.probes = [false, false, false, false];
  let clock = 0;
  await assert.rejects(
    withSchemaAdvisoryLock(client as unknown as PoolClient, async () => undefined, {
      pollMs: 5,
      budgetMs: 12,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      diagnose: () => undefined,
    }),
    /within 12ms/,
  );
  assert.equal(clock, 12);
  assert.deepEqual(client.events.slice(-1), ["release"]);
  assert.ok(!client.events.includes("unlock"));
});

test("contention diagnostics expose bounded classifications, never raw query text", async () => {
  const client = new LockClient();
  client.probes = [false, true];
  client.diagnostics = [{
    holder_pid: 42,
    application_name: "migration-task",
    client_identity: "127.0.0.1",
    state: "active",
    transaction_age: "00:00:01",
    query_age: "00:00:01",
    wait_event_type: null,
    command_summary: "database command",
  }];
  const seen: unknown[] = [];
  await withSchemaAdvisoryLock(client as unknown as PoolClient, async () => undefined, {
    pollMs: 1,
    budgetMs: 2,
    now: (() => {
      let clock = 0;
      return () => clock++;
    })(),
    sleep: async () => undefined,
    diagnose: (holders) => seen.push(holders),
  });
  const rendered = JSON.stringify(seen);
  assert.match(rendered, /holder_pid/);
  assert.doesNotMatch(rendered, /select .*from|secret|password/i);
  assert.ok(client.queries.some(({ sql }) => sql.includes("pg_locks") && sql.includes("pg_stat_activity")));
});

test("control-connection loss aborts and destroys the client", async () => {
  const client = new LockClient();
  await assert.rejects(
    // PB-10 Step 3 Phase 2c: a lost connection no longer cuts the action
    // short — ownership cannot end while the action may still be performing
    // mandatory durable persistence (see the ownership test below). The
    // action here therefore completes on its own, without reporting a
    // failure of its own, which is exactly the case where the connection
    // failure is the outcome the caller must see.
    withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
      client.emit("error", new Error("control connection lost"));
      await Promise.resolve();
    }),
    /control connection lost/,
  );
  assert.match(client.releasedWith?.message ?? "", /control connection lost/);
  assert.ok(!client.events.includes("unlock"));
});

/**
 * PB-10 Step 3 Phase 2c final review, blocker 1. Losing the pinned control
 * connection is exactly when the migration action performs its one mandatory
 * durable step — arming the commit_outcome_unknown replay guard over an
 * independent connection. Everything withSchemaAdvisoryLock owns (the
 * advisory lock, the pinned client, and the caller's knowledge of the
 * outcome) is what keeps a second execution from replaying a migration whose
 * outcome is unknown, so none of it may be handed back while that append is
 * still in flight. There is no deadline on that wait: a deadline that expired
 * would abandon mandatory durability work and release ownership anyway.
 *
 * The hold below is gated on an explicit signal rather than a sleep, so it is
 * unbounded by construction — longer than any grace period that could be
 * reintroduced. PB10_OWNERSHIP_HOLD_MS additionally holds it for real wall
 * clock (set it above a candidate grace, e.g. 35000, to prove the property
 * against a real timer); the default keeps the suite fast, and the emitted-API
 * assertions in migration-execute.test.ts are what permanently reject a
 * reintroduced grace constant or option.
 */
const OWNERSHIP_HOLD_MS = Number(process.env.PB10_OWNERSHIP_HOLD_MS ?? 250);

test("ownership: a lost connection never returns, unlocks, or releases while the action is still persisting", async () => {
  await withStrictProcessErrors(async () => {
    const client = new LockClient();
    let persist!: () => void;
    const persisted = new Promise<void>((resolve) => { persist = resolve; });
    let settled = false;

    const pending = withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
      // The connection dies the moment the action starts; the durable append
      // it must still complete does not depend on this connection.
      client.emit("error", new Error("connection reset by peer"));
      await persisted;
      client.events.push("marker-persisted");
      throw new Error("[commit_outcome_unknown] migration 0100: COMMIT outcome could not be confirmed");
    });
    pending.then(() => { settled = true; }, () => { settled = true; });

    const heldUntil = Date.now() + OWNERSHIP_HOLD_MS;
    do {
      await new Promise((resolve) => setImmediate(resolve));
    } while (Date.now() < heldUntil);

    assert.equal(settled, false, "the call must still be pending while mandatory persistence is in flight");
    assert.equal(client.releaseCount, 0, "the pinned client must not be released while persistence is in flight");
    assert.ok(!client.events.includes("unlock"), "the advisory lock must not be released while persistence is in flight");
    assert.ok(!client.events.includes("marker-persisted"), "the durable marker genuinely has not been written yet");

    persist();
    await assert.rejects(pending, /commit_outcome_unknown/, "the action's own outcome is what the caller sees");
    assert.deepEqual(
      client.events.slice(-2),
      ["marker-persisted", "release-error"],
      "the durable marker is written strictly before ownership of the connection ends",
    );
    assert.ok(!client.events.includes("unlock"), "an already-uncertain connection is never depended on for a healthy unlock");
    assert.equal(client.releaseCount, 1, "released exactly once");
    assert.equal(client.listenerCount("error"), 1, "a destroyed connection is never left with zero error listeners");
  });
});

test("unlock false and unlock errors destroy the pinned client", async () => {
  for (const failure of ["false", "error"] as const) {
    const client = new LockClient();
    if (failure === "false") client.unlockResult = false;
    else client.unlockError = new Error("unlock query failed");
    await assert.rejects(
      withSchemaAdvisoryLock(client as unknown as PoolClient, async () => undefined),
      failure === "false" ? /returned false/ : /unlock query failed/,
    );
    assert.ok(client.releasedWith instanceof Error);
    assert.deepEqual(client.events.slice(-2), ["unlock", "release-error"]);
  }
});

test("plan action failures still unlock before release", async () => {
  const client = new LockClient();
  await assert.rejects(
    withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
      client.events.push("plan-failed");
      throw new Error("catalog drift");
    }),
    /catalog drift/,
  );
  assert.deepEqual(client.events, ["probe", "plan-failed", "unlock", "release"]);
});

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitUntil timed out: ${description}`);
}

// PB-10 Step 3 Phase 2a control-client ownership: withSchemaAdvisoryLock is
// the real outer owner of the control connection for the entire production
// chain (executeMigrations -> executeVerifiedMigrations ->
// withSchemaAdvisoryLock -> executeNontransactional -> superviseOperation).
// superviseOperation never releases or destroys the control client itself —
// it only ever queries it (pg_cancel_backend) and, on failure, throws — so
// these scenarios are reproduced here exactly as the real action callback
// would present them: a thrown error (standing in for the
// cancellation_unverified superviseOperation raises after a failed
// pg_cancel_backend query), interleaved with the client's own 'error' event
// at a precise, deterministic point relative to the advisory-unlock cleanup
// that withSchemaAdvisoryLock performs afterward.
test("ownership: cancellation query rejects first, then a late client 'error' event during a still-pending unlock", async () => {
  await withStrictProcessErrors(async () => {
    const client = new LockClient();
    client.gateUnlock = true;
    const queryFailure = new Error("[cancellation_unverified] migration 0101: cancellation request was not accepted by PostgreSQL");

    const pending = withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
      throw queryFailure;
    });

    await waitUntil(() => client.unlockStarted, "unlock query to be issued");
    client.emit("error", new Error("terminating connection due to administrator command"));
    client.settleUnlock(); // the unlock response itself still arrives, reporting success

    await assert.rejects(pending, /cancellation_unverified/);
    assert.equal(client.releaseCount, 1, "the control client must be released exactly once");
    assert.ok(client.releasedWith instanceof Error, "a late connection error must still force a destructive release, even after an apparently-successful unlock");
    // A discarded connection intentionally keeps a (no-op) listener attached
    // rather than being left with none: it will never return to the pool,
    // so a genuinely delayed duplicate 'error' notification for the same
    // underlying failure must still land on something, not crash the
    // process. Only a healthy release removes the listener entirely.
    assert.equal(client.listenerCount("error"), 1, "a destroyed connection must never be left with zero error listeners");
  });
});

test("ownership: cancellation query rejects first, then the unlock attempt itself fails from socket termination", async () => {
  await withStrictProcessErrors(async () => {
    const client = new LockClient();
    client.gateUnlock = true;
    client.unlockError = new Error("Connection terminated unexpectedly");
    const queryFailure = new Error("[cancellation_unverified] migration 0101: cancellation request was not accepted by PostgreSQL");

    const pending = withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
      throw queryFailure;
    });

    await waitUntil(() => client.unlockStarted, "unlock query to be issued");
    client.emit("error", new Error("terminating connection due to administrator command"));
    client.settleUnlock(); // resolves the pending unlock query as a rejection (unlockError)

    await assert.rejects(pending, (error: Error) => {
      // Both the original action failure and the unlock's own failure are
      // real, independent problems; deterministic AggregateError behavior
      // must be preserved rather than silently dropping one.
      assert.ok(error instanceof AggregateError, `expected AggregateError, got: ${error.constructor.name}: ${error.message}`);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /cancellation_unverified/);
      assert.match(String(error.errors[1]), /Connection terminated unexpectedly/);
      return true;
    });
    assert.equal(client.releaseCount, 1, "the control client must be released exactly once");
    assert.ok(client.releasedWith instanceof Error);
    assert.equal(client.listenerCount("error"), 1, "a destroyed connection must never be left with zero error listeners");
  });
});

test("ownership: a control 'error' event occurs before the cancellation query itself rejects", async () => {
  await withStrictProcessErrors(async () => {
    const client = new LockClient();
    // PB-10 Step 3 Phase 2c: connectionLost is still raced against the
    // action, but winning that race no longer *returns* — it only stops
    // waiting on a connection that can no longer answer. The action keeps
    // running (this is exactly when it performs mandatory durable ambiguity
    // persistence, over an independent connection the failure does not
    // touch), and its own outcome is what surfaces: it, not the raw socket
    // error, is what knows whether the replay guard was armed and what the
    // run actually ended on. The connection failure is not discarded — it is
    // what drives the destructive release asserted below.
    const pending = withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
      client.emit("error", new Error("connection reset by peer"));
      await Promise.resolve();
      throw new Error("[cancellation_unverified] migration 0101: cancellation request was not accepted by PostgreSQL");
    });

    await assert.rejects(pending, /cancellation_unverified/);
    assert.ok(!client.events.includes("unlock"), "an already-uncertain connection must never be depended on for a healthy unlock");
    assert.equal(client.releaseCount, 1, "the control client must be released exactly once");
    assert.ok(client.releasedWith instanceof Error);
    assert.equal(client.listenerCount("error"), 1, "a destroyed connection must never be left with zero error listeners");
  });
});

test("ownership: an ordinary non-connection cancellation-query error still allows a healthy subsequent unlock", async () => {
  await withStrictProcessErrors(async () => {
    const client = new LockClient(); // no 'error' event anywhere in this scenario
    const pending = withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
      throw new Error("cancellation query failed: permission denied for function pg_cancel_backend");
    });

    await assert.rejects(pending, /permission denied/);
    assert.deepEqual(client.events, ["probe", "unlock", "release"], "an ordinary SQL-level failure, with no connection-level signal, must still unlock and release healthily");
    assert.equal(client.releaseCount, 1);
    assert.equal(client.releasedWith, undefined, "a merely logical failure must never destroy a healthy connection");
    assert.equal(client.listenerCount("error"), 0);
  });
});

test("ownership: advisory unlock fails after the action has already failed, with no connection-level signal", async () => {
  await withStrictProcessErrors(async () => {
    const client = new LockClient();
    client.unlockError = new Error("could not send data to server");
    const pending = withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
      throw new Error("cancellation query failed: syntax error");
    });

    await assert.rejects(pending, (error: Error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /syntax error/);
      assert.match(String(error.errors[1]), /could not send data to server/);
      return true;
    });
    assert.equal(client.releaseCount, 1);
    assert.ok(client.releasedWith instanceof Error);
    assert.equal(client.listenerCount("error"), 1, "a destroyed connection must never be left with zero error listeners");
  });
});

test("ownership: the healthy control path releases exactly once and leaks no listener", async () => {
  await withStrictProcessErrors(async () => {
    const client = new LockClient();
    const result = await withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
      client.events.push("action");
      return "ok";
    });
    assert.equal(result, "ok");
    assert.deepEqual(client.events, ["probe", "action", "unlock", "release"]);
    assert.equal(client.releaseCount, 1);
    assert.equal(client.releasedWith, undefined);
    assert.equal(client.listenerCount("error"), 0);
  });
});

class PlanClient extends LockClient {
  drift = false;
  /**
   * CRITICAL 1 + CRITICAL 2: overlays onto the role-separation probe, so a
   * case can present a runner that really is a superuser, really does own the
   * control schema, or really can INSERT applied rows, and prove
   * verifyControlSchema refuses it.
   */
  separation: ControlSchemaDrift["separation"];
  constraintDrift = false;
  schemaMissing = false;
  droppedTruncateTriggers = false;
  legacyLedgerPresent = false;
  legacyLedgerRows: string[] = [];
  legacyLedgerTimestamps: unknown[] = [];
  readonly ledgerRows: AppliedMigrationRow[];

  constructor(ledgerRows: AppliedMigrationRow[] = []) {
    super();
    this.ledgerRows = ledgerRows;
  }

  override async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    if (sql.includes("pg_try_advisory_lock") || sql.includes("pg_advisory_unlock") || sql.includes("pg_stat_activity")) {
      return super.query(sql, values);
    }
    this.queries.push({ sql, values });
    if (sql.includes("set_config")) return { rows: [{ set_config: String(values?.[1]) }], rowCount: 1 };
    if (sql.includes("to_regnamespace")) {
      return { rows: [{ present: !this.schemaMissing }], rowCount: 1 };
    }
    if (sql.includes("to_regclass")) {
      return { rows: [{ present: this.legacyLedgerPresent }], rowCount: 1 };
    }
    if (sql.includes("from public.infrastructure_schema_migrations")) {
      const rows = this.legacyLedgerRows.map((filename, index) => ({
        filename,
        applied_at: index in this.legacyLedgerTimestamps
          ? this.legacyLedgerTimestamps[index]
          : new Date(Date.UTC(2030, 0, index + 1)),
      }));
      return { rows, rowCount: rows.length };
    }
    const controlSchema = answerControlSchemaQuery(sql, {
      missingTables: this.drift,
      constraintDrift: this.constraintDrift,
      droppedTruncateTriggers: this.droppedTruncateTriggers,
      separation: this.separation,
    });
    if (controlSchema) return controlSchema as QueryResult;
    if (sql.includes("from migration_control.schema_migrations")) {
      return { rows: this.ledgerRows, rowCount: this.ledgerRows.length };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

test("strict control-schema verification rejects catalog drift", async () => {
  const client = new PlanClient();
  client.drift = true;
  await assert.rejects(
    verifyControlSchema(client as unknown as PoolClient),
    /exactly the two permanent ledger tables and the protected proof key/,
  );

  const constraintClient = new PlanClient();
  constraintClient.constraintDrift = true;
  await assert.rejects(verifyControlSchema(constraintClient as unknown as PoolClient), /Constraint definition drift/);

  const missingSchema = new PlanClient();
  missingSchema.schemaMissing = true;
  await assert.rejects(
    verifyControlSchema(missingSchema as unknown as PoolClient),
    /Control schema migration_control does not exist/,
  );
});

/**
 * PB-10 Step 3 Phase 2c final review, CRITICAL 1 + CRITICAL 2.
 *
 * Every unforgeability property this design provides is a property of the
 * *installation*, not of the SQL in this repository. An operator who installed
 * the old single-owner way, granted the runner ownership back, or simply
 * connects as a superuser has silently reinstated forgeable commit proof — and
 * nothing else in the codebase would notice. So the ownership model is
 * verified at runtime, against the connection the migration will actually run
 * on, before a single byte of migration SQL is sent.
 *
 * Each case flips exactly one probe field, so a regression that drops one
 * assertion cannot hide behind the others.
 */
test("verification rejects every installation whose ownership model would make commit proof forgeable", async () => {
  const cases: Array<[ControlSchemaDrift["separation"], RegExp]> = [
    [{ is_superuser: true }, /connected as a superuser/],
    [{ owns_control_schema: true }, /owns \(or is a member of the owner of\) migration_control/],
    [{ member_of_owner: true }, /owns \(or is a member of the owner of\) migration_control/],
    [{ can_insert_applied: true }, /INSERT into migration_control\.schema_migrations directly/],
    [{ can_write_binding: true }, /write migration_control\.migration_runs\.xact_id directly/],
    [{ can_read_proof_key: true }, /read migration_control\.proof_key/],
    [{ can_mutate_ledger: true }, /UPDATE, DELETE or TRUNCATE on a control ledger table/],
  ];
  for (const [separation, pattern] of cases) {
    const client = new PlanClient();
    client.separation = separation;
    await assert.rejects(
      verifyControlSchema(client as unknown as PoolClient),
      pattern,
      `${JSON.stringify(separation)} must fail closed`,
    );
  }

  // The correctly separated installation — the only one that proceeds — and
  // proof the verifier genuinely issued the probe rather than assuming it.
  const separated = new PlanClient();
  await verifyControlSchema(separated as unknown as PoolClient);
  assert.ok(
    separated.queries.some(({ sql }) => sql.includes("as is_superuser") && sql.includes("can_read_proof_key")),
    "the role-separation probe must actually be issued against the migration connection",
  );
});

test("verification rejects a ledger missing its TRUNCATE-rejection triggers", async () => {
  const client = new PlanClient();
  client.droppedTruncateTriggers = true;
  await assert.rejects(
    verifyControlSchema(client as unknown as PoolClient),
    /exactly 4 mutation-rejection triggers/,
  );

  const intact = new PlanClient();
  await verifyControlSchema(intact as unknown as PoolClient);
  const triggerQuery = intact.queries.find(({ sql }) => sql.includes("pg_trigger"));
  assert.ok(triggerQuery, "verifier must inspect pg_trigger");
});

test("canonical category order is a verified constraint, not an unordered comparison", async () => {
  const client = new PlanClient();
  await verifyControlSchema(client as unknown as PoolClient);
  const constraintQuery = client.queries.find(({ sql }) => sql.includes("pg_constraint"));
  assert.ok(constraintQuery, "verifier must inspect pg_constraint");

  // The plan stays order-sensitive on purpose: canonical ordering is enforced at
  // INSERT time by sm_categories_order_ck, so a reordered row must never be
  // silently accepted here.
  const reordered = manifest.migrations.findIndex((entry) => entry.operationCategories.length > 1);
  assert.notEqual(reordered, -1, "manifest needs a multi-category entry for this test");
  assert.throws(
    () => buildMigrationPlan(manifest, [applied(reordered, {
      operation_categories: [...manifest.migrations[reordered].operationCategories].reverse(),
    })].slice(0, 1)),
    /Operation category mismatch|contiguous ordinal prefix|ordering or migration ID mismatch/,
  );
});

test("plan fails closed when the legacy ledger diverges from an empty control ledger", async () => {
  const diverged = new PlanClient();
  diverged.legacyLedgerPresent = true;
  diverged.legacyLedgerRows = manifest.migrations.map(({ filename }) => filename);
  const pool = { connect: async () => diverged as unknown as PoolClient } as unknown as Pool;
  await assert.rejects(
    runMigrationPlan(pool, { manifest }),
    /incompatible.*legacy rows: 24, control rows: 0/,
  );
  assert.ok(diverged.queries.some(({ sql }) => /select\s+filename/i.test(sql)));
  assert.deepEqual(diverged.events.slice(-2), ["unlock", "release"]);

  const emptyLegacy = new PlanClient();
  emptyLegacy.legacyLedgerPresent = true;
  const emptyPool = { connect: async () => emptyLegacy as unknown as PoolClient } as unknown as Pool;
  assert.equal((await runMigrationPlan(emptyPool, { manifest })).pendingCount, 24);

  const baselined = new PlanClient(manifest.migrations.map((_, index) => applied(index)));
  baselined.legacyLedgerPresent = true;
  baselined.legacyLedgerRows = manifest.migrations.map(({ filename }) => filename);
  const baselinedPool = { connect: async () => baselined as unknown as PoolClient } as unknown as Pool;
  assert.equal((await runMigrationPlan(baselinedPool, { manifest })).pendingCount, 0);
  assert.ok(baselined.queries.some(({ sql }) => sql.includes("to_regclass")));
});

test("complete legacy and control ledgers must match exactly", async () => {
  const check = async (
    control: AppliedMigrationRow[],
    legacy: string[],
    pattern?: RegExp,
  ): Promise<void> => {
    const client = new PlanClient(control);
    client.legacyLedgerPresent = true;
    client.legacyLedgerRows = legacy;
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    if (pattern) await assert.rejects(runMigrationPlan(pool, { manifest }), pattern);
    else await runMigrationPlan(pool, { manifest });
  };

  await check(
    [applied(0), applied(1)],
    manifest.migrations.slice(0, 2).map(({ filename }) => filename),
  );
  await check(
    [applied(0)],
    manifest.migrations.slice(0, 2).map(({ filename }) => filename),
    /legacy rows: 2, control rows: 1/,
  );
  await check(
    [applied(0), applied(1)],
    [manifest.migrations[0].filename],
    /legacy rows: 1, control rows: 2/,
  );
  await check(
    [applied(0), applied(1)],
    [manifest.migrations[1].filename, manifest.migrations[0].filename],
    /incompatible/,
  );
  await check(
    [applied(0), applied(1)],
    [manifest.migrations[0].filename, "0002_filename_drift.sql"],
    /incompatible/,
  );
  await check(
    [applied(1)],
    [manifest.migrations[1].filename],
    /ordinal prefix|ordering or migration ID mismatch/,
  );
  await check(
    [applied(0), applied(1, { manifest_checksum_sha256: "0".repeat(64) })],
    manifest.migrations.slice(0, 2).map(({ filename }) => filename),
    /Manifest checksum mismatch/,
  );
  await check(
    [applied(0), applied(1)],
    [manifest.migrations[0].filename, manifest.migrations[0].filename],
    /incompatible/,
  );
});

test("legacy applied_at values must be valid, finite, distinct timestamps", async () => {
  const check = async (filenames: string[], timestamps: unknown[], pattern?: RegExp) => {
    const client = new PlanClient(filenames.map((_, index) => applied(index)));
    client.legacyLedgerPresent = true;
    client.legacyLedgerRows = filenames;
    client.legacyLedgerTimestamps = timestamps;
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    if (pattern) await assert.rejects(runMigrationPlan(pool, { manifest }), pattern);
    else assert.equal((await runMigrationPlan(pool, { manifest })).appliedCount, filenames.length);
  };

  const [first, second, third] = manifest.migrations;
  const tied = new Date("2030-01-01T00:00:00.000Z");
  const tiedError = /ambiguous applied_at timestamps; manual reconciliation is required/;
  await check([first.filename, second.filename], [tied, tied], tiedError);
  await check([second.filename, first.filename], [tied, tied], tiedError);
  await check([first.filename, second.filename, third.filename], [tied, tied, tied], tiedError);
  await check(
    [first.filename, second.filename, third.filename],
    [
      new Date("2030-01-01T00:00:00.000Z"),
      new Date("2030-01-02T00:00:00.000Z"),
      new Date("2030-01-03T00:00:00.000Z"),
    ],
  );
  const invalidError = /invalid applied_at timestamps; manual reconciliation is required/;
  for (const timestamps of [
    ["not-a-timestamp"],
    [new Date("not-a-timestamp")],
    [null],
    [{ date: "2030-01-01T00:00:00.000Z" }],
    [new Date(Number.POSITIVE_INFINITY)],
    ["2030-01-01T00:00:00.000Z", "not-a-timestamp"],
  ]) {
    await check(manifest.migrations.slice(0, timestamps.length).map(({ filename }) => filename), timestamps, invalidError);
  }
});

test("statement and lock timeouts are issued on the pinned client before the first probe", async () => {
  const client = new LockClient();
  await withSchemaAdvisoryLock(client as unknown as PoolClient, async () => undefined);
  const settings = client.queries
    .filter(({ sql }) => sql.includes("set_config"))
    .map(({ values }) => values as [string, string]);
  assert.deepEqual(settings, [
    ["statement_timeout", "30000"],
    ["lock_timeout", "5000"],
  ]);
  // is_local is a literal false, so the timeouts outlive each implicit transaction.
  assert.ok(client.queries.every(({ sql }) => !sql.includes("set_config") || sql.includes("false")));
  const kinds = client.queries.map(({ sql }) => sql.includes("set_config") ? "set_config" : sql.includes("pg_try_advisory_lock") ? "probe" : "other");
  assert.deepEqual(kinds.slice(0, 3), ["set_config", "set_config", "probe"]);
});

test("run plan issues only read-only catalog and ledger queries", async () => {
  const client = new PlanClient();
  const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
  const plan = await runMigrationPlan(pool, { manifest });
  assert.equal(plan.pendingCount, 24);
  const statements = client.queries.map(({ sql }) => sql.trim());
  assert.ok(statements.some((sql) => sql.includes("from migration_control.schema_migrations")));
  assert.ok(statements.every((sql) => /^(select|with)/i.test(sql)));
  assert.ok(statements.every((sql) =>
    !/\b(insert|update|delete|create|alter|drop)\b/i.test(sql.replace(/'(?:''|[^'])*'/g, "''")),
  ));
});

test("unsupported execution commands fail clearly before connecting", () => {
  const runner = path.join(repositoryRoot, "backend", "src", "db", "migrate", "runner.ts");
  const spawn = (...arguments_: string[]) => spawnSync(process.execPath, ["--import", "tsx", runner, ...arguments_], {
    cwd: path.join(repositoryRoot, "backend"),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "" },
  });

  // PB-10 Step 3 adds exactly one execution verb; every other spelling and every
  // out-of-scope lifecycle command still fails closed.
  for (const command of ["run", "apply", "clean-install", "baseline-adopt", ""]) {
    const result = spawn(command);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /supports only: plan, execute/);
  }

  // execute is recognised, but still refuses to run without a target database.
  const recognised = spawn("execute", "--json");
  assert.notEqual(recognised.status, 0);
  assert.doesNotMatch(recognised.stderr, /supports only/);
  assert.match(recognised.stderr, /DATABASE_URL is required/);
});
