import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Pool, PoolClient } from "pg";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import type { AppliedMigrationRow } from "../src/db/migrate/runner";
import {
  CANCELLATION_GRACE_MS,
  NONTRANSACTIONAL_WALL_CLOCK_CEILING_MS,
  SCHEMA_RUNNER_WALL_CLOCK_MS,
  TIMEOUT_CEILINGS,
  TRANSACTIONAL_WALL_CLOCK_CEILING_MS,
  assertTimeoutCeilings,
  executeMigrations,
  identityFromEnvironment,
  registeredHandlers,
  type BatchedHandler,
  type ExecuteOptions,
  type MigrationHandlers,
  type NontransactionalHandler,
  type NontransactionalState,
} from "../src/db/migrate/execute";
import {
  columnRows,
  constraintRows,
  functionRows,
  privilegeRows,
  triggerRows,
} from "./helpers/control-schema-fixture";

const RUN_ID = "10000000-0000-4000-8000-0000000000ff";
const identity = {
  sourceGitSha: "a".repeat(40),
  executorImageDigest: `sha256:${"b".repeat(64)}`,
  runnerId: "pb10-test-runner",
};

// A password-shaped literal, to prove nothing from the connection or the SQL
// body ever reaches an event, a report or an error message.
const SECRET = "sup3rs3cr3t-password";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const root = mkdtempSync(path.join(os.tmpdir(), "pb10-execute-"));
mkdirSync(path.join(root, "db", "migrations"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

// CRLF, a blank line and its own BEGIN/COMMIT: any normalisation, splitting or
// re-wrapping of a legacy payload changes these bytes and fails the checksum.
const files: Record<string, Buffer> = {
  "0001_legacy_demo.sql": Buffer.from(
    `begin;\r\n\r\ncreate table demo (id int);\r\ninsert into demo values (1); -- ${SECRET}\r\n\r\ncommit;\n`,
    "utf8",
  ),
  "0100_expand_demo.sql": Buffer.from(`alter table demo add column label text; -- ${SECRET}\n`, "utf8"),
  "0101_index_demo.sql": Buffer.from("create index concurrently demo_label_idx on demo (label);\n", "utf8"),
  "0102_backfill_demo.sql": Buffer.from("-- progress is owned by the registered batched handler\n", "utf8"),
};
for (const [filename, bytes] of Object.entries(files)) {
  writeFileSync(path.join(root, "db", "migrations", filename), bytes);
}

const timeouts = { lockMs: 5_000, statementMs: 60_000, transactionMs: 300_000, idleInTransactionMs: 60_000, wallClockMs: 900_000 };

const entries: Record<string, MigrationManifestEntry> = {
  legacy: {
    id: "0001",
    filename: "0001_legacy_demo.sql",
    sha256: sha256(files["0001_legacy_demo.sql"]),
    lifecyclePhase: "expand",
    operationCategories: ["schema"],
    executionMode: "legacy-verbatim",
    requiredRuntimeEpoch: null,
    timeouts,
  },
  transactional: {
    id: "0100",
    filename: "0100_expand_demo.sql",
    sha256: sha256(files["0100_expand_demo.sql"]),
    lifecyclePhase: "expand",
    operationCategories: ["schema"],
    executionMode: "transactional",
    requiredRuntimeEpoch: null,
    timeouts,
  },
  nontransactional: {
    id: "0101",
    filename: "0101_index_demo.sql",
    sha256: sha256(files["0101_index_demo.sql"]),
    lifecyclePhase: "expand",
    operationCategories: ["index"],
    executionMode: "nontransactional",
    requiredRuntimeEpoch: null,
    timeouts,
  },
  batched: {
    id: "0102",
    filename: "0102_backfill_demo.sql",
    sha256: sha256(files["0102_backfill_demo.sql"]),
    lifecyclePhase: "backfill",
    operationCategories: ["data-correction"],
    executionMode: "batched",
    requiredRuntimeEpoch: null,
    timeouts,
  },
};

function manifestOf(...selected: MigrationManifestEntry[]): MigrationManifest {
  return { schemaVersion: 1, legacyBoundary: "0099", migrations: selected };
}

function appliedRow(entry: MigrationManifestEntry, ordinal: number, overrides: Partial<AppliedMigrationRow> = {}): AppliedMigrationRow {
  return {
    migration_id: entry.id,
    ordinal,
    filename: entry.filename,
    manifest_checksum_sha256: entry.sha256,
    applied_checksum_sha256: entry.sha256,
    lifecycle_phase: entry.lifecyclePhase,
    operation_categories: [...entry.operationCategories],
    execution_mode: entry.executionMode,
    applied_at: "2030-01-01T00:00:00.000Z",
    run_id: RUN_ID,
    baselined: false,
    source_git_sha: identity.sourceGitSha,
    executor_image_digest: identity.executorImageDigest,
    ...overrides,
  };
}

type QueryResult = { rows: unknown[]; rowCount: number | null };
type Recorded = { client: "control" | "execution"; sql: string; values?: unknown[] };

class FakeClient extends EventEmitter {
  released = false;
  releasedWith: Error | undefined;

  constructor(readonly role: "control" | "execution", readonly log: Recorded[]) {
    super();
  }

  record(sql: string, values?: unknown[]): void {
    this.log.push({ client: this.role, sql: sql.trim(), values });
  }

  release(error?: Error): void {
    this.released = true;
    this.releasedWith = error;
  }
}

class ControlClient extends FakeClient {
  ledgerRows: AppliedMigrationRow[] = [];
  priorAttempts = 0;
  unlocked = false;
  dead: Error | undefined;
  onCancel: (() => void) | undefined;
  readonly events: Array<{ migrationId: string; sequence: number; type: string; values: unknown[] }> = [];
  readonly appliedInserts: unknown[][] = [];

  constructor(log: Recorded[]) {
    super("control", log);
  }

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.record(sql, values);
    if (this.dead) throw this.dead;
    if (sql.includes("set_config")) return { rows: [{ set_config: String(values?.[1]) }], rowCount: 1 };
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
    if (sql.includes("pg_advisory_unlock")) {
      this.unlocked = true;
      return { rows: [{ unlocked: true }], rowCount: 1 };
    }
    if (sql.includes("pg_cancel_backend")) {
      this.onCancel?.();
      return { rows: [{ pg_cancel_backend: true }], rowCount: 1 };
    }
    if (sql.includes("to_regnamespace")) return { rows: [{ present: true }], rowCount: 1 };
    if (sql.includes("to_regclass")) return { rows: [{ present: false }], rowCount: 1 };
    if (sql.includes("c.relkind in ('r', 'p')")) {
      return { rows: [{ table_name: "migration_runs" }, { table_name: "schema_migrations" }], rowCount: 2 };
    }
    if (sql.includes("pg_attribute")) return { rows: columnRows, rowCount: columnRows.length };
    if (sql.includes("pg_constraint")) return { rows: constraintRows, rowCount: constraintRows.length };
    if (sql.includes("pg_trigger")) return { rows: triggerRows, rowCount: triggerRows.length };
    if (sql.includes("p.provolatile")) return { rows: functionRows, rowCount: functionRows.length };
    if (sql.includes("control_namespace")) return { rows: privilegeRows, rowCount: 1 };
    if (sql.includes("into migration_control.migration_runs")) {
      this.events.push({
        migrationId: String(values?.[1]),
        sequence: Number(values?.[2]),
        type: String(values?.[3]),
        values: values ?? [],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("into migration_control.schema_migrations")) {
      this.appliedInserts.push(values ?? []);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("as attempts")) return { rows: [{ attempts: String(this.priorAttempts) }], rowCount: 1 };
    if (sql.includes("from migration_control.schema_migrations")) {
      return { rows: this.ledgerRows, rowCount: this.ledgerRows.length };
    }
    throw new Error(`unexpected control query: ${sql}`);
  }

  eventTypes(): string[] {
    return this.events.map(({ type }) => type);
  }
}

class ExecutionClient extends FakeClient {
  failMigrationSql: Error | undefined;
  failRollback = false;
  hangMigrationSql = false;
  readonly appliedInserts: unknown[][] = [];
  private settleHang: (() => void) | undefined;

  constructor(log: Recorded[]) {
    super("execution", log);
  }

  settlePendingOperation(): void {
    this.settleHang?.();
  }

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.record(sql, values);
    if (sql.includes("set_config")) return { rows: [{ set_config: String(values?.[1]) }], rowCount: 1 };
    if (sql === "begin" || sql === "commit") return { rows: [], rowCount: null };
    if (sql === "rollback") {
      if (this.failRollback) throw new Error("rollback failed");
      return { rows: [], rowCount: null };
    }
    if (sql.includes("pg_backend_pid")) return { rows: [{ pid: 4242 }], rowCount: 1 };
    if (sql.includes("into migration_control.schema_migrations")) {
      this.appliedInserts.push(values ?? []);
      return { rows: [], rowCount: 1 };
    }
    // Anything else is migration SQL.
    if (this.failMigrationSql) throw this.failMigrationSql;
    if (this.hangMigrationSql) {
      return new Promise<QueryResult>((resolve) => {
        this.settleHang = () => resolve({ rows: [], rowCount: null });
      });
    }
    return { rows: [], rowCount: null };
  }
}

class FakePool {
  readonly log: Recorded[] = [];
  readonly control = new ControlClient(this.log);
  readonly execution = new ExecutionClient(this.log);
  connects = 0;

  async connect(): Promise<PoolClient> {
    this.connects += 1;
    return (this.connects === 1 ? this.control : this.execution) as unknown as PoolClient;
  }

  migrationSql(): Recorded[] {
    return this.log.filter(({ client, sql }) =>
      client === "execution"
      && !sql.includes("set_config")
      && !sql.includes("pg_backend_pid")
      && !sql.includes("into migration_control.schema_migrations")
      && !["begin", "commit", "rollback"].includes(sql));
  }
}

/** Quoted literals are stripped first: catalog reads legitimately contain words like 'USAGE,CREATE'. */
const isReadOnly = (sql: string): boolean => {
  const withoutLiterals = sql.replace(/'(?:''|[^'])*'/g, "''");
  return /^(select|with)/i.test(withoutLiterals)
    && !/\b(insert|update|delete|create|alter|drop|truncate)\b/i.test(withoutLiterals);
};

const never = () => new Promise<void>(() => undefined);

function options(pool: FakePool, overrides: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    manifest: manifestOf(entries.legacy),
    identity,
    repositoryRoot: root,
    runId: RUN_ID,
    handlers: { nontransactional: new Map(), batched: new Map() },
    sleep: never,
    ...overrides,
  };
}

const run = (pool: FakePool, overrides: Partial<ExecuteOptions> = {}) =>
  executeMigrations(pool as unknown as Pool, options(pool, overrides));

const handlersWith = (over: Partial<MigrationHandlers>): MigrationHandlers => ({
  nontransactional: new Map(),
  batched: new Map(),
  ...over,
});

const inspector = (...states: NontransactionalState[]): NontransactionalHandler & { calls: number } => ({
  calls: 0,
  async inspect(): Promise<NontransactionalState> {
    const state = states[Math.min(this.calls, states.length - 1)];
    this.calls += 1;
    return state;
  },
});

// 1 ────────────────────────────────────────────────────────────────────────────
test("no migration SQL runs before the lock, control schema and ledger verify", async () => {
  const pool = new FakePool();
  await run(pool);

  const controlSql = pool.log.filter(({ client }) => client === "control").map(({ sql }) => sql);
  const lockIndex = controlSql.findIndex((sql) => sql.includes("pg_try_advisory_lock"));
  const ledgerIndex = controlSql.findIndex((sql) => sql.includes("from migration_control.schema_migrations"));
  const catalogIndex = controlSql.findIndex((sql) => sql.includes("pg_constraint"));
  assert.ok(lockIndex >= 0 && lockIndex < catalogIndex && catalogIndex < ledgerIndex);

  // The execution connection is not even acquired until verification is done.
  const firstExecution = pool.log.findIndex(({ client }) => client === "execution");
  const globalLedgerIndex = pool.log.findIndex(({ sql }) => sql.includes("from migration_control.schema_migrations"));
  assert.ok(globalLedgerIndex < firstExecution, "execution connection used before ledger verification");
  assert.equal(pool.connects, 2);
});

// 2, 3, 4 ─────────────────────────────────────────────────────────────────────
test("legacy payload is sent byte-for-byte, unwrapped, and records its observed checksum", async () => {
  const pool = new FakePool();
  const report = await run(pool);

  const sent = pool.migrationSql();
  assert.equal(sent.length, 1);
  assert.deepEqual(Buffer.from(sent[0].sql === files["0001_legacy_demo.sql"].toString("utf8").trim()
    ? files["0001_legacy_demo.sql"].toString("utf8")
    : sent[0].sql, "utf8"), files["0001_legacy_demo.sql"]);
  assert.equal(sent[0].values, undefined, "legacy payload must use the simple query protocol");

  // No outer transaction was opened around the legacy file on the execution
  // connection; the file's own BEGIN/COMMIT is the only transaction.
  const executionControlStatements = pool.log
    .filter(({ client, sql }) => client === "execution" && ["begin", "commit", "rollback"].includes(sql));
  assert.deepEqual(executionControlStatements, []);

  const checksum = sha256(files["0001_legacy_demo.sql"]);
  assert.equal(report.executed[0].appliedChecksumSha256, checksum);
  assert.equal(pool.control.appliedInserts.length, 1, "legacy applied row goes through the control connection");
  assert.equal(pool.control.appliedInserts[0][4], checksum);
  assert.equal(pool.execution.appliedInserts.length, 0);
  assert.deepEqual(pool.control.eventTypes(), ["started", "operation_completed", "applied_committed", "succeeded"]);
});

// 5 ───────────────────────────────────────────────────────────────────────────
test("a stale legacy attempt fails closed and is never replayed", async () => {
  const pool = new FakePool();
  pool.control.priorAttempts = 3;
  await assert.rejects(run(pool), /stale_legacy_attempt/);
  assert.deepEqual(pool.migrationSql(), [], "no legacy SQL may be replayed");
  assert.deepEqual(pool.control.appliedInserts, []);
});

// 6 ───────────────────────────────────────────────────────────────────────────
test("transactional SQL and its applied row commit atomically on one connection", async () => {
  const pool = new FakePool();
  const report = await run(pool, { manifest: manifestOf(entries.transactional) });

  const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
  const begin = executionSql.indexOf("begin");
  const migration = executionSql.findIndex((sql) => sql.includes("alter table demo"));
  const insert = executionSql.findIndex((sql) => sql.includes("into migration_control.schema_migrations"));
  const commit = executionSql.indexOf("commit");
  assert.ok(begin >= 0 && begin < migration && migration < insert && insert < commit, executionSql.join(" | "));

  // SET LOCAL equivalents live inside the transaction.
  const settings = pool.log
    .filter(({ client, sql }) => client === "execution" && sql.includes("set_config"))
    .map(({ values }) => (values as [string, string, boolean]).slice(0, 3));
  assert.deepEqual(settings, [
    ["lock_timeout", "5000", true],
    ["statement_timeout", "60000", true],
    ["transaction_timeout", "300000", true],
    ["idle_in_transaction_session_timeout", "60000", true],
  ]);
  assert.equal(pool.execution.appliedInserts.length, 1);
  assert.equal(pool.control.appliedInserts.length, 0);
  assert.deepEqual(pool.control.eventTypes(), ["started", "applied_committed", "succeeded"]);
  assert.equal(report.executedCount, 1);
});

// 7, 8 ────────────────────────────────────────────────────────────────────────
test("transactional failure rolls back with no applied row and durable control events", async () => {
  const pool = new FakePool();
  const failure = Object.assign(new Error(`duplicate key value violates unique constraint: ${SECRET}`), { code: "23505" });
  pool.execution.failMigrationSql = failure;

  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /sql_failed/);

  const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
  assert.ok(executionSql.includes("rollback"));
  assert.ok(!executionSql.includes("commit"));
  assert.deepEqual(pool.execution.appliedInserts, []);
  assert.deepEqual(pool.control.appliedInserts, []);
  // The rollback destroyed the transaction; the events survive because they were
  // written on the control connection in autocommit.
  assert.deepEqual(pool.control.eventTypes(), ["started", "transaction_rolled_back", "execution_failed"]);
  for (const event of pool.control.events.slice(1)) {
    assert.equal(event.values[8], "23505", "SQLSTATE is recorded");
    assert.equal(event.values[9], "sql_failed", "only a bounded error class is recorded");
  }
});

// 9 ───────────────────────────────────────────────────────────────────────────
test("a nontransactional wall-clock expiry cancels the execution backend", async () => {
  const pool = new FakePool();
  pool.execution.hangMigrationSql = true;
  pool.control.onCancel = () => pool.execution.settlePendingOperation();

  await assert.rejects(
    run(pool, {
      manifest: manifestOf(entries.nontransactional),
      handlers: handlersWith({ nontransactional: new Map([["0101", inspector("absent")]]) }),
      // Only the wall-clock budget elapses; the grace period does not.
      sleep: async (milliseconds) => { if (milliseconds !== timeouts.wallClockMs) await never(); },
    }),
    /wall_clock_exceeded/,
  );

  const cancel = pool.log.find(({ client, sql }) => client === "control" && sql.includes("pg_cancel_backend"));
  assert.ok(cancel, "the control connection must cancel the execution backend");
  assert.deepEqual(cancel?.values, [4242]);
  assert.deepEqual(pool.control.appliedInserts, []);
  assert.equal(pool.execution.releasedWith, undefined, "a confirmed cancellation reuses the connection");
});

// 10 ──────────────────────────────────────────────────────────────────────────
test("an unconfirmed cancellation destroys the execution client", async () => {
  const pool = new FakePool();
  pool.execution.hangMigrationSql = true;

  await assert.rejects(
    run(pool, {
      manifest: manifestOf(entries.nontransactional),
      handlers: handlersWith({ nontransactional: new Map([["0101", inspector("absent")]]) }),
      // Budget and grace both elapse; the operation never settles.
      sleep: async (milliseconds) => {
        if (milliseconds !== timeouts.wallClockMs && milliseconds !== CANCELLATION_GRACE_MS) await never();
      },
    }),
    /cancellation_unverified/,
  );

  assert.ok(pool.execution.releasedWith instanceof Error, "the execution client must be destroyed, not pooled");
  assert.match(pool.execution.releasedWith?.message ?? "", /cancellation_unverified/);
  assert.deepEqual(pool.control.appliedInserts, []);
});

// 11 ──────────────────────────────────────────────────────────────────────────
test("a nontransactional applied row is written only after the verifier confirms completion", async () => {
  const pool = new FakePool();
  const handler = inspector("absent", "valid");
  const report = await run(pool, {
    manifest: manifestOf(entries.nontransactional),
    handlers: handlersWith({ nontransactional: new Map([["0101", handler]]) }),
  });

  assert.equal(handler.calls, 2, "the verifier runs before and after the operation");
  const globalOrder = pool.log.map(({ sql }) => sql);
  const operation = globalOrder.findIndex((sql) => sql.includes("create index concurrently"));
  const insert = globalOrder.findIndex((sql) => sql.includes("into migration_control.schema_migrations"));
  assert.ok(operation >= 0 && operation < insert);
  assert.equal(pool.control.appliedInserts.length, 1);
  assert.equal(report.executed[0].adopted, false);
  assert.deepEqual(pool.control.eventTypes(), ["started", "operation_completed", "applied_committed", "succeeded"]);

  // statement/transaction/idle timeouts are disabled; the control connection owns the budget.
  const settings = pool.log
    .filter(({ client, sql }) => client === "execution" && sql.includes("set_config"))
    .map(({ values }) => (values as [string, string, boolean]).slice(0, 3));
  assert.deepEqual(settings, [
    ["lock_timeout", "5000", false],
    ["statement_timeout", "0", false],
    ["transaction_timeout", "0", false],
    ["idle_in_transaction_session_timeout", "0", false],
  ]);
});

// 12 ──────────────────────────────────────────────────────────────────────────
test("valid-but-unrecorded nontransactional state is adopted, not re-executed", async () => {
  const pool = new FakePool();
  const handler = inspector("valid");
  const report = await run(pool, {
    manifest: manifestOf(entries.nontransactional),
    handlers: handlersWith({ nontransactional: new Map([["0101", handler]]) }),
  });

  assert.equal(handler.calls, 1, "an adopted operation is inspected once and never re-run");
  assert.deepEqual(pool.migrationSql(), [], "no operation SQL may be replayed");
  assert.equal(report.executed[0].adopted, true);
  assert.equal(pool.control.appliedInserts.length, 1);
  assert.deepEqual(pool.control.eventTypes(), ["started", "operation_completed", "applied_committed", "succeeded"]);
});

// 13 ──────────────────────────────────────────────────────────────────────────
test("invalid or partial nontransactional state is never blindly replayed", async () => {
  const pool = new FakePool();
  await assert.rejects(
    run(pool, {
      manifest: manifestOf(entries.nontransactional),
      handlers: handlersWith({ nontransactional: new Map([["0101", inspector("invalid")]]) }),
    }),
    /verifier_state_invalid/,
  );
  assert.deepEqual(pool.migrationSql(), []);
  assert.deepEqual(pool.control.appliedInserts, []);
  assert.deepEqual(pool.control.eventTypes(), ["started", "verification_failed"]);

  // Post-execution verification failure is equally fatal and records no row.
  const second = new FakePool();
  await assert.rejects(
    run(second, {
      manifest: manifestOf(entries.nontransactional),
      handlers: handlersWith({ nontransactional: new Map([["0101", inspector("absent", "invalid")]]) }),
    }),
    /verification_failed/,
  );
  assert.deepEqual(second.control.appliedInserts, []);
});

// 14 ──────────────────────────────────────────────────────────────────────────
test("batched mode without a registered handler fails closed and never degrades", async () => {
  const pool = new FakePool();
  await assert.rejects(run(pool, { manifest: manifestOf(entries.batched) }), /unsupported_handler/);
  assert.deepEqual(pool.migrationSql(), [], "batched must not fall back to another mode");
  assert.deepEqual(pool.control.appliedInserts, []);
  assert.deepEqual(pool.control.eventTypes(), []);

  // Nontransactional is equally strict about its verifier.
  const nontransactional = new FakePool();
  await assert.rejects(
    run(nontransactional, { manifest: manifestOf(entries.nontransactional) }),
    /unsupported_handler/,
  );
  assert.deepEqual(nontransactional.migrationSql(), []);

  // The shipped registry is empty on purpose: no reviewed handler exists yet.
  assert.equal(registeredHandlers.nontransactional.size, 0);
  assert.equal(registeredHandlers.batched.size, 0);
});

test("a registered batched handler drives bounded per-batch transactions and must verify completion", async () => {
  const pool = new FakePool();
  const handler: BatchedHandler = {
    async execute(context) {
      await context.runBatch(async (client) => { await client.query("update demo set label = 'x' where label is null"); });
      await context.runBatch(async (client) => { await client.query("update demo set label = 'x' where label is null"); });
    },
    async verifyComplete() { return true; },
  };
  await run(pool, {
    manifest: manifestOf(entries.batched),
    handlers: handlersWith({ batched: new Map([["0102", handler]]) }),
  });

  const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
  assert.equal(executionSql.filter((sql) => sql === "begin").length, 2);
  assert.equal(executionSql.filter((sql) => sql === "commit").length, 2);
  assert.deepEqual(pool.control.eventTypes(), [
    "started", "operation_completed", "operation_completed", "applied_committed", "succeeded",
  ]);
  assert.deepEqual(
    pool.control.events.filter(({ type }) => type === "operation_completed")
      .map((event) => JSON.parse(String(event.values[10])).batch_number),
    [1, 2],
  );

  const incomplete = new FakePool();
  await assert.rejects(
    run(incomplete, {
      manifest: manifestOf(entries.batched),
      handlers: handlersWith({ batched: new Map([["0102", { ...handler, verifyComplete: async () => false }]]) }),
    }),
    /verification_failed/,
  );
  assert.deepEqual(incomplete.control.appliedInserts, []);
});

// 15 ──────────────────────────────────────────────────────────────────────────
test("loss of the control connection aborts execution and destroys the execution client", async () => {
  const pool = new FakePool();
  pool.execution.hangMigrationSql = true;
  const lost = new Error("control connection lost");

  const pending = run(pool, {
    manifest: manifestOf(entries.transactional),
    handlers: handlersWith({}),
  });
  setImmediate(() => {
    pool.control.dead = lost;
    pool.control.emit("error", lost);
    pool.execution.settlePendingOperation();
  });

  await assert.rejects(pending, /control connection lost/);
  assert.ok(pool.control.releasedWith instanceof Error, "the control client is destroyed, not returned");
  assert.equal(pool.control.unlocked, false, "a lost connection must not be trusted to unlock");

  // The execution connection is destroyed the moment control is lost, so its
  // in-flight transaction cannot go on to COMMIT an applied row for a run that
  // has already aborted.
  assert.ok(pool.execution.releasedWith instanceof Error, "the execution client must be destroyed on control loss");
  assert.equal(pool.execution.releasedWith?.message, lost.message);
  const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
  assert.ok(!executionSql.includes("commit"), "an orphaned transaction must never commit");
  assert.deepEqual(pool.execution.appliedInserts, []);
});

// 16 ──────────────────────────────────────────────────────────────────────────
test("the advisory lock is verifiably released before the control client returns", async () => {
  const pool = new FakePool();
  await run(pool);
  const controlSql = pool.log.filter(({ client }) => client === "control").map(({ sql }) => sql);
  assert.ok(controlSql.some((sql) => sql.includes("pg_advisory_unlock")));
  assert.equal(pool.control.unlocked, true);
  assert.equal(pool.control.released, true);
  assert.equal(pool.control.releasedWith, undefined);
  assert.equal(pool.execution.released, true);
  assert.equal(pool.execution.releasedWith, undefined);
});

// 17 ──────────────────────────────────────────────────────────────────────────
test("events, reports and errors leak no SQL bodies, parameters or secrets", async () => {
  const pool = new FakePool();
  const report = await run(pool);
  const eventPayload = JSON.stringify(pool.control.events);
  assert.doesNotMatch(eventPayload, new RegExp(SECRET));
  assert.doesNotMatch(eventPayload, /create table|insert into demo|alter table/i);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(report), /create table|postgres(?:ql)?:\/\//i);

  // Every event's metadata is confined to the mr_metadata_ck vocabulary.
  const permitted = new Set([
    "duration_ms", "elapsed_ms", "rows_affected", "statement_count", "batch_number",
    "retry_count", "operation_category", "execution_mode", "verification", "reclaim_reason",
  ]);
  for (const event of pool.control.events) {
    for (const key of Object.keys(JSON.parse(String(event.values[10])))) {
      assert.ok(permitted.has(key), `metadata key ${key} is not permitted`);
    }
  }

  // A failing migration must not surface the server's message either.
  const failing = new FakePool();
  failing.execution.failMigrationSql = Object.assign(new Error(`boom ${SECRET}`), { code: "42P01" });
  await assert.rejects(
    run(failing, { manifest: manifestOf(entries.transactional) }),
    (error: Error) => !error.message.includes(SECRET) && /sql_failed/.test(error.message),
  );
  assert.doesNotMatch(JSON.stringify(failing.control.events), new RegExp(SECRET));
});

// 18 ──────────────────────────────────────────────────────────────────────────
test("a zero-pending run performs no writes at all", async () => {
  const pool = new FakePool();
  pool.control.ledgerRows = [appliedRow(entries.legacy, 1)];
  const report = await run(pool);

  assert.equal(report.outcome, "no-op");
  assert.equal(report.executedCount, 0);
  assert.equal(pool.connects, 1, "no execution connection is opened when nothing is pending");
  assert.deepEqual(pool.control.events, []);
  assert.deepEqual(pool.control.appliedInserts, []);
  const writes = pool.log.filter(({ sql }) => !isReadOnly(sql));
  assert.deepEqual(writes.map(({ sql }) => sql), [], "a zero-pending run issues only read-only statements");
});

// 19 ──────────────────────────────────────────────────────────────────────────
test("re-running does not re-execute an already applied migration", async () => {
  const first = new FakePool();
  const manifest = manifestOf(entries.legacy, entries.transactional);
  first.control.ledgerRows = [appliedRow(entries.legacy, 1)];
  const report = await run(first, { manifest });
  assert.deepEqual(report.executed.map(({ id }) => id), ["0100"]);
  assert.equal(first.migrationSql().length, 1);

  const second = new FakePool();
  second.control.ledgerRows = [appliedRow(entries.legacy, 1), appliedRow(entries.transactional, 2)];
  const rerun = await run(second, { manifest });
  assert.equal(rerun.executedCount, 0);
  assert.equal(rerun.outcome, "no-op");
  assert.deepEqual(second.migrationSql(), []);
});

// 20 ──────────────────────────────────────────────────────────────────────────
test("checksum, filename, order and mode drift all block execution", async () => {
  const drifted = new FakePool();
  await assert.rejects(
    run(drifted, { manifest: manifestOf({ ...entries.legacy, sha256: "0".repeat(64) }) }),
    /checksum_drift/,
  );
  assert.deepEqual(drifted.migrationSql(), [], "no SQL runs once on-disk bytes drift");

  for (const [overrides, pattern] of [
    [{ filename: "0001_other_name.sql" }, /Filename mismatch/],
    [{ execution_mode: "transactional" }, /Execution mode mismatch/],
    [{ applied_checksum_sha256: "0".repeat(64) }, /Applied checksum mismatch/],
    [{ ordinal: 2 }, /contiguous ordinal prefix/],
  ] as Array<[Partial<AppliedMigrationRow>, RegExp]>) {
    const pool = new FakePool();
    pool.control.ledgerRows = [appliedRow(entries.legacy, 1, overrides)];
    await assert.rejects(run(pool, { manifest: manifestOf(entries.legacy, entries.transactional) }), pattern);
    assert.deepEqual(pool.migrationSql(), []);
  }
});

// Timeout and identity contracts ──────────────────────────────────────────────
test("manifest timeouts above the approved ceilings are rejected before execution", async () => {
  for (const [key, ceiling] of Object.entries(TIMEOUT_CEILINGS)) {
    assert.throws(
      () => assertTimeoutCeilings([{ ...entries.transactional, timeouts: { ...timeouts, [key]: ceiling + 1 } }]),
      /manifest_ceiling_exceeded/,
    );
  }
  assert.throws(
    () => assertTimeoutCeilings([{ ...entries.transactional, timeouts: { ...timeouts, wallClockMs: TRANSACTIONAL_WALL_CLOCK_CEILING_MS + 1 } }]),
    /manifest_ceiling_exceeded/,
  );
  // Nontransactional gets the larger cancellation budget, but not an unbounded one.
  assertTimeoutCeilings([{ ...entries.nontransactional, timeouts: { ...timeouts, wallClockMs: NONTRANSACTIONAL_WALL_CLOCK_CEILING_MS } }]);
  assert.throws(
    () => assertTimeoutCeilings([{ ...entries.nontransactional, timeouts: { ...timeouts, wallClockMs: NONTRANSACTIONAL_WALL_CLOCK_CEILING_MS + 1 } }]),
    /manifest_ceiling_exceeded/,
  );
  // Ceilings are per migration: the real 24-migration legacy set declares far
  // more worst-case headroom than the runner budget and must still execute.
  assertTimeoutCeilings(Array.from({ length: 24 }, () => entries.legacy));

  const pool = new FakePool();
  await assert.rejects(
    run(pool, { manifest: manifestOf({ ...entries.legacy, timeouts: { ...timeouts, statementMs: 60_001 } }) }),
    /manifest_ceiling_exceeded/,
  );
  assert.deepEqual(pool.migrationSql(), []);
  assert.equal(pool.connects, 1, "a ceiling breach is caught before the execution connection opens");
});

test("the schema-runner budget is enforced against elapsed time, not declared ceilings", async () => {
  const pool = new FakePool();
  let clock = 0;
  await assert.rejects(
    run(pool, {
      manifest: manifestOf(entries.legacy, entries.transactional),
      // The first migration consumes the whole budget; the second must not start.
      now: () => (clock += SCHEMA_RUNNER_WALL_CLOCK_MS),
    }),
    new RegExp(`run_budget_exceeded.*${SCHEMA_RUNNER_WALL_CLOCK_MS}ms schema-runner budget`),
  );
  // The budget is checked before each migration: the first completed and is
  // durably recorded, the second never started.
  assert.equal(pool.control.appliedInserts.length, 1);
  assert.deepEqual(pool.control.appliedInserts[0][0], entries.legacy.id);
  assert.equal(pool.migrationSql().length, 1);
});

test("executor identity is required, validated, and never invented", () => {
  assert.throws(() => identityFromEnvironment({}), /MIGRATION_SOURCE_GIT_SHA/);
  assert.throws(
    () => identityFromEnvironment({ MIGRATION_SOURCE_GIT_SHA: "zzz" }),
    /MIGRATION_SOURCE_GIT_SHA/,
  );
  assert.throws(
    () => identityFromEnvironment({ MIGRATION_SOURCE_GIT_SHA: "a".repeat(40) }),
    /MIGRATION_EXECUTOR_IMAGE_DIGEST/,
  );
  assert.throws(
    () => identityFromEnvironment({
      MIGRATION_SOURCE_GIT_SHA: "a".repeat(40),
      MIGRATION_EXECUTOR_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
      MIGRATION_RUNNER_ID: "bad id with spaces",
    }),
    /MIGRATION_RUNNER_ID/,
  );
  assert.deepEqual(
    identityFromEnvironment({
      MIGRATION_SOURCE_GIT_SHA: "a".repeat(40),
      MIGRATION_EXECUTOR_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    }),
    { sourceGitSha: "a".repeat(40), executorImageDigest: `sha256:${"b".repeat(64)}`, runnerId: null },
  );
});

test("event sequence starts at one and increases monotonically across a run", async () => {
  const pool = new FakePool();
  await run(pool, { manifest: manifestOf(entries.legacy, entries.transactional) });
  assert.deepEqual(pool.control.events.map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(pool.control.events.every(({ values }) => values[0] === RUN_ID));
  // heartbeat_deadline is permitted only on started events.
  for (const event of pool.control.events) {
    assert.equal(event.values[5] === null, event.type !== "started");
  }
});
