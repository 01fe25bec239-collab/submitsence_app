import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Pool, PoolClient } from "pg";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import type { AppliedMigrationRow } from "../src/db/migrate/runner";
import {
  SCHEMA_RUNNER_WALL_CLOCK_MS,
  TIMEOUT_CEILINGS,
  executeMigrations,
} from "../src/db/migrate/execute";
import {
  executeMigrationsForTest,
  type TestExecuteOptions,
} from "./helpers/migration-execute";
import {
  columnRows,
  constraintRows,
  functionRows,
  privilegeRows,
  triggerRows,
} from "./helpers/control-schema-fixture";

const RUN_ID = "10000000-0000-4000-8000-0000000000ff";
const identity = {
  sourceGitSha: "5324116250977b5e8ac24bc83b6cae89ebcbd990",
  executorImageDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
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

writeFileSync(path.join(root, ".gitattributes"), "db/migrations/*.sql -text\n");
writeFileSync(
  path.join(root, "db", "migrations", "manifest.json"),
  `${JSON.stringify(manifestOf(entries.legacy, entries.transactional, entries.nontransactional, entries.batched), null, 2)}\n`,
);

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

type PriorEventFixture = {
  migration_id: string;
  run_id: string;
  event_sequence: number;
  event_type: string;
  runner_id: string | null;
  heartbeat_deadline: Date | string | null;
  source_git_sha: string | null;
  executor_image_digest: string | null;
  sqlstate: string | null;
  error_class: string | null;
  metadata: unknown;
  statement_ordinal: number | null;
};

function retryEvent(
  event_sequence: number,
  event_type: string,
  overrides: Partial<PriorEventFixture> = {},
): PriorEventFixture {
  const failed = event_type === "transaction_rolled_back" || event_type === "execution_failed";
  return {
    migration_id: "0001",
    run_id: "10000000-0000-4000-8000-000000000001",
    event_sequence,
    event_type,
    runner_id: identity.runnerId,
    heartbeat_deadline: event_type === "started" || event_type === "heartbeat"
      ? "2030-01-01T00:01:00.000Z"
      : null,
    source_git_sha: identity.sourceGitSha,
    executor_image_digest: identity.executorImageDigest,
    sqlstate: failed ? "23505" : null,
    error_class: failed ? "sql_failed" : null,
    statement_ordinal: failed ? 1 : null,
    metadata: event_type === "heartbeat"
      ? {
          execution_mode: "legacy-verbatim",
          migration_filename: entries.legacy.filename,
          migration_ordinal: 1,
          elapsed_ms: 1,
        }
      : {
          execution_mode: "legacy-verbatim",
          migration_filename: entries.legacy.filename,
          migration_ordinal: 1,
        },
    ...overrides,
  };
}

type QueryResult = { rows: unknown[]; rowCount: number | null };
type Recorded = { client: "control" | "execution"; sql: string; values?: unknown[] };

class FakeClient extends EventEmitter {
  released = false;
  releasedWith: Error | undefined;
  releaseCount = 0;

  constructor(readonly role: "control" | "execution", readonly log: Recorded[]) {
    super();
  }

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
  ledgerRows: AppliedMigrationRow[] = [];
  legacyLedgerRows: string[] | null = null;
  legacyLedgerTimestamps: unknown[] = [];
  priorEvents: PriorEventFixture[] = [];
  unlocked = false;
  dead: Error | undefined;
  onCancel: (() => void) | undefined;
  readonly events: Array<{ migrationId: string; sequence: number; type: string; values: unknown[] }> = [];
  readonly appliedInserts: unknown[][] = [];
  /**
   * When set, the advisory-unlock query blocks on a promise this test
   * controls directly (via settleUnlock), so a test can interleave a
   * control-client 'error' event with the unlock attempt at an exact,
   * deterministic point rather than racing real timing.
   */
  gateUnlock = false;
  unlockStarted = false;
  private unlockGate: (() => void) | undefined;

  settleUnlock(): void {
    assert.ok(this.unlockGate, "settleUnlock called before the unlock query was issued");
    this.unlockGate!();
  }

  constructor(log: Recorded[]) {
    super("control", log);
  }

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.record(sql, values);
    if (this.dead) throw this.dead;
    if (sql.includes("set_config")) return { rows: [{ set_config: String(values?.[1]) }], rowCount: 1 };
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
    if (sql.includes("pg_advisory_unlock")) {
      this.unlockStarted = true;
      if (this.gateUnlock) {
        await new Promise<void>((resolve) => { this.unlockGate = resolve; });
      }
      this.unlocked = true;
      return { rows: [{ unlocked: true }], rowCount: 1 };
    }
    if (sql.includes("pg_cancel_backend")) {
      this.onCancel?.();
      return { rows: [{ pg_cancel_backend: true }], rowCount: 1 };
    }
    if (sql.includes("to_regnamespace")) return { rows: [{ present: true }], rowCount: 1 };
    if (sql.includes("to_regclass")) return { rows: [{ present: this.legacyLedgerRows !== null }], rowCount: 1 };
    if (sql.includes("from public.infrastructure_schema_migrations")) {
      const rows = (this.legacyLedgerRows ?? []).map((filename, index) => ({
        filename,
        applied_at: index in this.legacyLedgerTimestamps
          ? this.legacyLedgerTimestamps[index]
          : new Date(Date.UTC(2030, 0, index + 1)),
      }));
      return { rows, rowCount: rows.length };
    }
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
    if (sql.includes("from migration_control.migration_runs")) {
      return { rows: this.priorEvents, rowCount: this.priorEvents.length };
    }
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

function options(pool: FakePool, overrides: Partial<TestExecuteOptions> = {}): TestExecuteOptions {
  return {
    manifest: manifestOf(entries.legacy),
    identity,
    repositoryRoot: root,
    runId: RUN_ID,
    ...overrides,
  };
}

const run = (pool: FakePool, overrides: Partial<TestExecuteOptions> = {}) =>
  executeMigrationsForTest(pool as unknown as Pool, options(pool, overrides));

async function expectManifestPreflightRejection(
  mutate: (fixtureRoot: string) => void,
  pattern: RegExp,
): Promise<void> {
  const parent = mkdtempSync(path.join(os.tmpdir(), "pb10-manifest-preflight-"));
  const fixtureRoot = path.join(parent, "repository");
  cpSync(root, fixtureRoot, { recursive: true });
  try {
    mutate(fixtureRoot);
    const pool = new FakePool();
    await assert.rejects(
      executeMigrationsForTest(pool as unknown as Pool, { repositoryRoot: fixtureRoot, identity }),
      pattern,
    );
    assert.equal(pool.connects, 0, "manifest rejection must precede control-client acquisition");
    assert.deepEqual(pool.control.events, []);
    assert.deepEqual(pool.migrationSql(), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

// 1 ────────────────────────────────────────────────────────────────────────────
test("direct JavaScript callers cannot inject any execution boundary input", async () => {
  for (const injected of [
    { manifest: manifestOf(entries.legacy) },
    { repositoryRoot: root },
    { identity },
    { handlers: { nontransactional: new Map(), batched: new Map() } },
    { runId: RUN_ID },
    { sql: "select 1" },
    { now: Date.now },
    { sleep: never },
  ]) {
    const pool = new FakePool();
    await assert.rejects(
      executeMigrations(pool as unknown as Pool, injected as never),
      /exactly one Pool argument/,
    );
    assert.equal(pool.connects, 0);
  }
});

test("manifest trust failures occur before any database activity", async () => {
  await expectManifestPreflightRejection(
    (fixtureRoot) => rmSync(path.join(fixtureRoot, ".gitattributes")),
    /\.gitattributes|ENOENT/,
  );
  await expectManifestPreflightRejection(
    (fixtureRoot) => rmSync(path.join(fixtureRoot, "db", "migrations", "manifest.json")),
    /manifest\.json|ENOENT/,
  );
  await expectManifestPreflightRejection((fixtureRoot) => {
    const target = path.join(fixtureRoot, "db", "migrations", "manifest.json");
    const fixtureManifest = JSON.parse(readFileSync(target, "utf8")) as MigrationManifest;
    fixtureManifest.migrations.reverse();
    writeFileSync(target, `${JSON.stringify(fixtureManifest, null, 2)}\n`);
  }, /not in numeric order/);
  await expectManifestPreflightRejection((fixtureRoot) => {
    const target = path.join(fixtureRoot, "db", "migrations", "manifest.json");
    const fixtureManifest = JSON.parse(readFileSync(target, "utf8")) as MigrationManifest;
    fixtureManifest.migrations.pop();
    writeFileSync(target, `${JSON.stringify(fixtureManifest, null, 2)}\n`);
  }, /Missing manifest entry/);
  await expectManifestPreflightRejection((fixtureRoot) => {
    const migrations = path.join(fixtureRoot, "db", "migrations");
    const original = path.join(migrations, "0001_legacy_demo.sql");
    writeFileSync(path.join(migrations, "0001_renamed_demo.sql"), readFileSync(original));
    rmSync(original);
  }, /Missing manifest entry|Unexpected manifest entry|missing migration file/);
  await expectManifestPreflightRejection((fixtureRoot) => {
    const target = path.join(fixtureRoot, "db", "migrations", "0001_legacy_demo.sql");
    writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from(" ")]));
  }, /SHA-256 mismatch/);
});

test("normal production execution verifies the committed manifest", async () => {
  const committedManifest = JSON.parse(
    readFileSync(path.resolve(__dirname, "../../db/migrations/manifest.json"), "utf8"),
  ) as MigrationManifest;
  const pool = new FakePool();
  pool.control.ledgerRows = committedManifest.migrations.map((entry, index) => appliedRow(entry, index + 1));
  const previousSha = process.env.MIGRATION_SOURCE_GIT_SHA;
  const previousDigest = process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST;
  process.env.MIGRATION_SOURCE_GIT_SHA = identity.sourceGitSha;
  process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = identity.executorImageDigest;
  try {
    const report = await executeMigrations(pool as unknown as Pool);
    assert.equal(report.outcome, "no-op");
    assert.equal(pool.connects, 1);
  } finally {
    if (previousSha === undefined) delete process.env.MIGRATION_SOURCE_GIT_SHA;
    else process.env.MIGRATION_SOURCE_GIT_SHA = previousSha;
    if (previousDigest === undefined) delete process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST;
    else process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = previousDigest;
  }
});

test("production source and build expose no injectable executor or mutable registry", () => {
  assert.throws(() => require.resolve("../src/db/migrate/execute-internal"));

  const buildRoot = mkdtempSync(path.join(os.tmpdir(), "pb10-production-build-"));
  const output = path.join(buildRoot, "backend", "dist");
  try {
    cpSync(path.resolve(__dirname, "../../.gitattributes"), path.join(buildRoot, ".gitattributes"));
    cpSync(path.resolve(__dirname, "../../db"), path.join(buildRoot, "db"), { recursive: true });
    const compiler = path.resolve(__dirname, "../node_modules/typescript/bin/tsc");
    const built = spawnSync(process.execPath, [
      compiler,
      "--project", path.resolve(__dirname, "../tsconfig.json"),
      "--outDir", output,
      "--declaration",
    ], { encoding: "utf8" });
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);

    const migrationOutput = path.join(output, "db", "migrate");
    assert.equal(existsSync(path.join(migrationOutput, "execute-internal.js")), false);
    assert.equal(existsSync(path.join(migrationOutput, "execute-internal.d.ts")), false);
    const declaration = readFileSync(path.join(migrationOutput, "execute.d.ts"), "utf8");
    assert.match(declaration, /executeMigrations\(pool: Pool\): Promise<ExecutionReport>/);
    assert.doesNotMatch(
      declaration,
      /executeVerifiedMigrations|registeredHandlers|InternalExecuteOptions|superviseOperation|SupervisedOperationContext/,
    );

    const probe = spawnSync(process.execPath, ["-e", `
      const assert = require("node:assert/strict");
      const target = require(${JSON.stringify(path.join(migrationOutput, "execute.js"))});
      assert.equal(target.executeMigrations.length, 1);
      assert.equal("registeredHandlers" in target, false);
      assert.equal("executeVerifiedMigrations" in target, false);
      // The Phase 2a cancellation state machine lives in its own internal
      // module (supervision.ts); execute.ts imports it for internal use but
      // must never re-export it as an alternate execution entry point.
      assert.equal("superviseOperation" in target, false);
      assert.equal("SupervisedOperationContext" in target, false);
      assert.ok(Object.values(target).every((value) =>
        typeof value !== "object" || value === null ||
        (!("set" in value) && !("delete" in value) && !("clear" in value))));
      assert.throws(() => require(${JSON.stringify(path.join(migrationOutput, "execute-internal.js"))}));
    `], {
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: path.resolve(__dirname, "../node_modules") },
    });
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);

    // Only execute.js/.d.ts — not every emitted file — must never export the
    // supervision internals: supervision.ts is its own internal module and
    // legitimately exports superviseOperation for execute.ts's own import and
    // for its focused unit tests; the property under test is that execute.ts
    // does not re-export it, not that no file anywhere does.
    const executeEmitted = readFileSync(path.join(migrationOutput, "execute.js"), "utf8");
    assert.doesNotMatch(
      executeEmitted,
      /exports\.(?:executeVerifiedMigrations|registeredHandlers|identityFromEnvironment|superviseOperation|SupervisedOperationContext)\b/,
    );
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
});

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

test("ambiguous or invalid legacy timestamps fail before migration SQL or ledger writes", async () => {
  for (const [timestamps, pattern] of [
    [[
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:00:00.000Z",
    ], /ambiguous applied_at timestamps; manual reconciliation is required/],
    [["not-a-timestamp"], /invalid applied_at timestamps; manual reconciliation is required/],
    [[new Date("not-a-timestamp")], /invalid applied_at timestamps; manual reconciliation is required/],
    [[null], /invalid applied_at timestamps; manual reconciliation is required/],
    [[42], /invalid applied_at timestamps; manual reconciliation is required/],
    [[new Date(Number.POSITIVE_INFINITY)], /invalid applied_at timestamps; manual reconciliation is required/],
    [["2030-01-01T00:00:00.000Z", "not-a-timestamp"], /invalid applied_at timestamps; manual reconciliation is required/],
  ] as Array<[unknown[], RegExp]>) {
    const pool = new FakePool();
    pool.control.legacyLedgerRows = timestamps.map((_, index) => (
      [entries.legacy.filename, entries.transactional.filename][index]
    ));
    pool.control.legacyLedgerTimestamps = timestamps;
    await assert.rejects(
      run(pool, { manifest: manifestOf(entries.legacy, entries.transactional) }),
      pattern,
    );
    assert.deepEqual(pool.migrationSql(), []);
    assert.deepEqual(pool.control.appliedInserts, []);
    assert.deepEqual(pool.control.events, []);
  }
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
  for (const { values } of pool.control.events) {
    const metadata = JSON.parse(String(values[10])) as Record<string, unknown>;
    assert.equal(metadata.migration_filename, entries.legacy.filename);
    assert.equal(metadata.migration_ordinal, 1);
  }
});

// 5 ───────────────────────────────────────────────────────────────────────────
test("a stale legacy attempt fails closed and is never replayed", async () => {
  const pool = new FakePool();
  pool.control.priorEvents = [retryEvent(1, "started")];
  await assert.rejects(run(pool), /stale_legacy_attempt/);
  assert.deepEqual(pool.migrationSql(), [], "no legacy SQL may be replayed");
  assert.deepEqual(pool.control.appliedInserts, []);
});

test("only the exact confirmed SQL-failure-and-rollback history may retry", async () => {
  const safe = new FakePool();
  safe.control.priorEvents = [
    retryEvent(1, "started"),
    retryEvent(2, "heartbeat"),
    retryEvent(3, "transaction_rolled_back"),
    retryEvent(4, "execution_failed"),
  ];
  await run(safe);
  assert.equal(safe.migrationSql().length, 1);
  assert.equal(safe.control.appliedInserts.length, 1);

  const base = () => [
    retryEvent(1, "started"),
    retryEvent(2, "transaction_rolled_back"),
    retryEvent(3, "execution_failed"),
  ];
  const otherRun = "10000000-0000-4000-8000-000000000002";
  const cases: Array<[string, PriorEventFixture[]]> = [
    ["duplicate started", [retryEvent(1, "started"), retryEvent(2, "started"), retryEvent(3, "transaction_rolled_back"), retryEvent(4, "execution_failed")]],
    ["missing started", [retryEvent(1, "heartbeat"), retryEvent(2, "transaction_rolled_back"), retryEvent(3, "execution_failed")]],
    ["sequence begins above one", base().map((event) => ({ ...event, event_sequence: event.event_sequence + 1 }))],
    ["sequence gap", [retryEvent(1, "started"), retryEvent(3, "transaction_rolled_back"), retryEvent(4, "execution_failed")]],
    ["duplicate sequence", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back"), retryEvent(2, "execution_failed")]],
    ["reordered sequence", [retryEvent(1, "started"), retryEvent(3, "transaction_rolled_back"), retryEvent(2, "execution_failed")]],
    ["heartbeat after rollback", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back"), retryEvent(3, "heartbeat"), retryEvent(4, "execution_failed")]],
    ["rollback not immediately before failure", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back"), retryEvent(3, "operation_completed"), retryEvent(4, "execution_failed")]],
    ["missing rollback classification", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back", { error_class: null }), retryEvent(3, "execution_failed")]],
    ["incorrect rollback classification", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back", { error_class: "connection_lost" }), retryEvent(3, "execution_failed")]],
    ["missing SQLSTATE", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back", { sqlstate: null }), retryEvent(3, "execution_failed", { sqlstate: null })]],
    ["inconsistent SQLSTATE", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back"), retryEvent(3, "execution_failed", { sqlstate: "22012" })]],
    ["unexpected started ordinal", [retryEvent(1, "started", { statement_ordinal: 99 }), ...base().slice(1)]],
    ["unexpected heartbeat ordinal", [retryEvent(1, "started"), retryEvent(2, "heartbeat", { statement_ordinal: 1 }), retryEvent(3, "transaction_rolled_back"), retryEvent(4, "execution_failed")]],
    ["unexpected rollback ordinal", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back", { statement_ordinal: 99 }), retryEvent(3, "execution_failed")]],
    ["unexpected failure ordinal", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back"), retryEvent(3, "execution_failed", { statement_ordinal: 99 })]],
    ["missing required ordinal", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back", { statement_ordinal: null }), retryEvent(3, "execution_failed")]],
    ["ordinal when null is required", [retryEvent(1, "started", { statement_ordinal: 1 }), ...base().slice(1)]],
    ["negative ordinal", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back", { statement_ordinal: -1 }), retryEvent(3, "execution_failed")]],
    ["missing ordinal", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back", { statement_ordinal: undefined as never }), retryEvent(3, "execution_failed")]],
    ["malformed ordinal", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back", { statement_ordinal: Number.NaN }), retryEvent(3, "execution_failed")]],
    ["fractional ordinal", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back", { statement_ordinal: 1.5 }), retryEvent(3, "execution_failed")]],
    ["inconsistent ordinals", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back"), retryEvent(3, "execution_failed", { statement_ordinal: 2 })]],
    ["filename absent from historical events", base().map((event) => ({
      ...event,
      metadata: { execution_mode: "legacy-verbatim", migration_ordinal: 1 },
    }))],
    ["inconsistent filenames within one run", [
      retryEvent(1, "started"),
      retryEvent(2, "transaction_rolled_back", {
        metadata: {
          execution_mode: "legacy-verbatim",
          migration_filename: "0001_renamed_after_failure.sql",
          migration_ordinal: 1,
        },
      }),
      retryEvent(3, "execution_failed"),
    ]],
    ["inconsistent migration ordinal", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back", {
      metadata: {
        execution_mode: "legacy-verbatim",
        migration_filename: entries.legacy.filename,
        migration_ordinal: 2,
      },
    }), retryEvent(3, "execution_failed")]],
    ["malformed metadata", [retryEvent(1, "started", { metadata: { execution_mode: "transactional" } }), ...base().slice(1)]],
    ["inconsistent identity metadata", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back", { source_git_sha: "a".repeat(40) }), retryEvent(3, "execution_failed")]],
    ["mismatched migration ID", base().map((event) => ({ ...event, migration_id: "0002" }))],
    ["duplicate rollback", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back"), retryEvent(3, "transaction_rolled_back"), retryEvent(4, "execution_failed")]],
    ["duplicate terminal failure", [...base(), retryEvent(4, "execution_failed")]],
    ["event after terminal failure", [...base(), retryEvent(4, "heartbeat")]],
    ["operation completed without applied row", [retryEvent(1, "started"), retryEvent(2, "operation_completed")]],
    ["unknown COMMIT", [retryEvent(1, "started"), retryEvent(2, "execution_failed")]],
    ["connection loss", [retryEvent(1, "started"), retryEvent(2, "execution_failed", { error_class: "control_connection_lost" })]],
    ["events from another run", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back"), retryEvent(3, "execution_failed", { run_id: otherRun })]],
  ];

  for (const [name, events] of cases) {
    const ambiguous = new FakePool();
    ambiguous.control.priorEvents = events;
    await assert.rejects(run(ambiguous), /stale_legacy_attempt/);
    assert.deepEqual(ambiguous.migrationSql(), [], name);
    assert.deepEqual(ambiguous.control.appliedInserts, [], name);
  }

  const renamedFilename = new FakePool();
  renamedFilename.control.priorEvents = base();
  writeFileSync(path.join(root, "db", "migrations", "0001_renamed_after_failure.sql"), files["0001_legacy_demo.sql"]);
  await assert.rejects(
    run(renamedFilename, {
      manifest: manifestOf({ ...entries.legacy, filename: "0001_renamed_after_failure.sql" }),
    }),
    /stale_legacy_attempt/,
  );
  assert.deepEqual(renamedFilename.migrationSql(), []);
  assert.deepEqual(renamedFilename.control.appliedInserts, []);
});

test("a legacy SQL failure records confirmed rollback before failure", async () => {
  const pool = new FakePool();
  pool.execution.failMigrationSql = Object.assign(new Error("known failure"), { code: "23505" });
  await assert.rejects(run(pool), /sql_failed/);
  assert.deepEqual(pool.control.eventTypes(), ["started", "transaction_rolled_back", "execution_failed"]);
  assert.deepEqual(pool.control.events.map(({ values }) => values[11]), [null, 1, 1]);
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

test("production handlers are private and unsupported modes fail closed", async () => {
  const module = require("../src/db/migrate/execute") as Record<string, unknown>;
  assert.equal("registeredHandlers" in module, false);
  assert.ok(Object.values(module).every((value) =>
    typeof value !== "object"
    || value === null
    || (!("set" in value) && !("delete" in value) && !("clear" in value))));

  for (const entry of [entries.nontransactional, entries.batched]) {
    const pool = new FakePool();
    await assert.rejects(run(pool, { manifest: manifestOf(entry) }), /unsupported_handler/);
    assert.deepEqual(pool.migrationSql(), []);
    assert.deepEqual(pool.control.appliedInserts, []);
  }

  const injected = new FakePool();
  const handlers = { nontransactional: new Map([["0101", { inspect: async () => "valid" }]]), batched: new Map() };
  await assert.rejects(
    executeMigrations(injected as unknown as Pool, { handlers } as never),
    /exactly one Pool argument/,
  );
  assert.equal(injected.connects, 0);
});

// 15 ──────────────────────────────────────────────────────────────────────────
test("loss of the control connection aborts execution and destroys the execution client", async () => {
  const pool = new FakePool();
  pool.execution.hangMigrationSql = true;
  const lost = new Error("control connection lost");

  const pending = run(pool, {
    manifest: manifestOf(entries.transactional),
  });
  setImmediate(() => {
    pool.control.dead = lost;
    pool.control.emit("error", lost);
    pool.execution.settlePendingOperation();
  });

  await assert.rejects(pending, /control connection lost/);
  assert.ok(pool.control.releasedWith instanceof Error, "the control client is destroyed, not returned");
  assert.equal(pool.control.unlocked, false, "a lost connection must not be trusted to unlock");
  assert.equal(pool.control.releaseCount, 1, "the control client must be released exactly once — never twice");

  // The execution connection is destroyed the moment control is lost, so its
  // in-flight transaction cannot go on to COMMIT an applied row for a run that
  // has already aborted.
  assert.ok(pool.execution.releasedWith instanceof Error, "the execution client must be destroyed on control loss");
  assert.equal(pool.execution.releasedWith?.message, lost.message);
  // onControlError's own releaseExecution(controlLost) call and the outer
  // finally's releaseExecution(destroyExecution) both fire here, but the
  // idempotent releaseExecution guard in executeVerifiedMigrations must
  // collapse them into exactly one real release — never a double release
  // across that boundary.
  assert.equal(pool.execution.releaseCount, 1, "the execution client must be released exactly once — never twice");
  const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
  assert.ok(!executionSql.includes("commit"), "an orphaned transaction must never commit");
  assert.deepEqual(pool.execution.appliedInserts, []);
});

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitUntil timed out: ${description}`);
}

// 15b ─────────────────────────────────────────────────────────────────────────
// PB-10 Step 3 Phase 2a control-client ownership, through the real production
// chain: executeMigrations -> executeVerifiedMigrations ->
// withSchemaAdvisoryLock -> [a reachable mode's own destroyExecution() path]
// -> advisory unlock -> final control-client release/destruction.
// executeNontransactional/superviseOperation are not reachable here (no
// handler can be registered — see migration-execute-supervision.test.ts's
// own header comment), so this reproduces the bug's exact ordering — a
// failure that already forces execution-client destruction, followed later
// by a control-client 'error' event arriving mid-unlock — using
// transactional mode's own rollback-failure path, which calls
// context.destroyExecution() through the identical mechanism
// superviseOperation's cancellation_unverified path would.
test("both clients are destroyed exactly once when a control 'error' arrives mid-unlock during an execution-destroying failure", async () => {
  const pool = new FakePool();
  pool.execution.failMigrationSql = Object.assign(new Error("boom"), { code: "42601" });
  pool.execution.failRollback = true; // forces context.destroyExecution() in executeTransactional's catch
  pool.control.gateUnlock = true;

  const pending = run(pool, { manifest: manifestOf(entries.transactional) });

  await waitUntil(() => pool.control.unlockStarted, "the advisory unlock query to be issued");
  pool.control.emit("error", new Error("terminating connection due to administrator command"));
  pool.control.settleUnlock();

  await assert.rejects(pending, /sql_failed/);

  assert.ok(pool.execution.releasedWith instanceof Error, "the execution client must be destroyed");
  assert.equal(pool.execution.releaseCount, 1, "the execution client must be released exactly once");

  assert.ok(pool.control.releasedWith instanceof Error, "a late connection error must force a destructive control release, even after an apparently-successful unlock");
  assert.equal(pool.control.releaseCount, 1, "the control client must be released exactly once");
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
  assert.equal(pool.control.releaseCount, 1, "a healthy control client is released exactly once — never twice");
  assert.equal(pool.execution.released, true);
  assert.equal(pool.execution.releasedWith, undefined);
  assert.equal(pool.execution.releaseCount, 1, "a healthy execution client is released exactly once — never twice");
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
    "retry_count", "operation_category", "execution_mode", "migration_filename",
    "migration_ordinal", "verification", "reclaim_reason",
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
    const pool = new FakePool();
    await assert.rejects(
      run(pool, { manifest: manifestOf({ ...entries.transactional, timeouts: { ...timeouts, [key]: ceiling + 1 } }) }),
      /manifest_ceiling_exceeded/,
    );
    assert.equal(pool.connects, 1);
  }
  const pool = new FakePool();
  await assert.rejects(
    run(pool, { manifest: manifestOf({ ...entries.nontransactional, timeouts: { ...timeouts, wallClockMs: 1_800_001 } }) }),
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

test("executor identity rejects only malformed or explicit placeholder values", async () => {
  const invalid = [
    { ...identity, sourceGitSha: "" },
    { ...identity, sourceGitSha: "zzz" },
    { ...identity, sourceGitSha: identity.sourceGitSha.toUpperCase() },
    { ...identity, sourceGitSha: ` ${identity.sourceGitSha}` },
    { ...identity, sourceGitSha: "0".repeat(40) },
    { ...identity, sourceGitSha: "f".repeat(40) },
    { ...identity, sourceGitSha: "deadbeef".repeat(5) },
    { ...identity, executorImageDigest: identity.executorImageDigest.toUpperCase() },
    { ...identity, executorImageDigest: `${identity.executorImageDigest} ` },
    { ...identity, executorImageDigest: `sha256:${"0".repeat(64)}` },
    { ...identity, executorImageDigest: `sha256:${"cafebabe".repeat(8)}` },
    { ...identity, runnerId: "bad id with spaces" },
  ];
  for (const candidate of invalid) {
    const pool = new FakePool();
    await assert.rejects(
      executeMigrationsForTest(pool as unknown as Pool, {
        manifest: manifestOf(entries.legacy),
        repositoryRoot: root,
        identity: candidate,
      }),
      /identity_missing/,
    );
    assert.equal(pool.connects, 0);
  }

  for (const candidate of [
    identity,
    {
      ...identity,
      sourceGitSha: "abcdef".repeat(7),
      executorImageDigest: `sha256:${"01234567".repeat(8)}`,
    },
  ]) {
    const pool = new FakePool();
    pool.control.ledgerRows = [appliedRow(entries.legacy, 1)];
    assert.equal((await executeMigrationsForTest(pool as unknown as Pool, {
      manifest: manifestOf(entries.legacy),
      repositoryRoot: root,
      identity: candidate,
    })).outcome, "no-op");
  }
});

test("test-only injected identity is validated before client acquisition", async () => {
  const pool = new FakePool();
  await assert.rejects(
    executeMigrationsForTest(pool as unknown as Pool, {
      manifest: manifestOf(entries.legacy),
      repositoryRoot: root,
      identity: {
        sourceGitSha: "0".repeat(40),
        executorImageDigest: `sha256:${"f".repeat(64)}`,
        runnerId: null,
      },
    }),
    /identity_missing/,
  );
  assert.equal(pool.connects, 0);
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
