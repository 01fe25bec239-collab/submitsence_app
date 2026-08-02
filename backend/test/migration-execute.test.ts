import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, mock } from "node:test";
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
  answerControlSchemaQuery,
  type ControlSchemaDrift,
} from "./helpers/control-schema-fixture";
import { pgError } from "./helpers/pg-errors";
import {
  ProtectedPathError,
  ProtectedProofPath,
  type RecordedApplied,
  tokenDigest,
} from "./helpers/protected-proof-path";

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

/**
 * PB-10 Step 3 Phase 2c final review, HIGH 1: the immutable applied-ledger row
 * as the historical-checksum/commit-proof lookup reads it. Every provenance
 * field is compared against the attempt's own identity, so a fixture that
 * differs in any one of them proves nothing.
 */
type AppliedArtifactFixture = {
  run_id: string;
  ordinal: number;
  filename: string;
  applied_checksum_sha256: string | null;
  execution_mode: string;
  source_git_sha: string;
  executor_image_digest: string;
  /**
   * CRITICAL 1: the database's own classification of this row's provenance,
   * written by migration_control.record_applied_migration and constrained by
   * sm_commit_proof_mode_ck. Only a transactional attempt may carry
   * 'transaction_atomic', and only that value means "written from inside the
   * exact bound transaction, so it exists if and only if that transaction
   * committed".
   */
  commit_proof: string;
};

function artifactFor(
  entry: MigrationManifestEntry,
  run_id: string,
  overrides: Partial<AppliedArtifactFixture> = {},
): AppliedArtifactFixture {
  return {
    run_id,
    ordinal: 1,
    filename: entry.filename,
    applied_checksum_sha256: entry.sha256,
    execution_mode: entry.executionMode,
    source_git_sha: identity.sourceGitSha,
    executor_image_digest: identity.executorImageDigest,
    commit_proof: entry.executionMode === "transactional" ? "transaction_atomic" : "post_hoc_verified",
    ...overrides,
  };
}

type PriorEventFixture = {
  event_id: number;
  xact_id?: string | null;
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
    event_id: event_sequence,
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
  /**
   * Overlays onto the shared control-schema answer table so a case can install
   * a *wrong* schema — a runner that is a superuser, that owns the schema, or
   * that can INSERT applied rows directly — and prove verifyControlSchema
   * fails closed before any migration SQL runs. Empty means "correctly
   * installed with role separation".
   */
  controlSchemaDrift: ControlSchemaDrift = {};
  ledgerRows: AppliedMigrationRow[] = [];
  legacyLedgerRows: string[] | null = null;
  legacyLedgerTimestamps: unknown[] = [];
  priorEvents: PriorEventFixture[] = [];
  /**
   * PB-10 Step 3 Phase 2c: drives the ambiguous-COMMIT reconciliation query
   * (`select ... from migration_control.schema_migrations where migration_id
   * = $1 and ordinal = $2 and run_id = $3 and applied_checksum_sha256 =
   * $4`), independently of ledgerRows (the plain, no-WHERE-clause read used
   * by readAppliedRows for migrations already applied before this run
   * started). "unavailable" makes the reconciliation query itself throw.
   */
  reconciliation: "committed" | "absent" | "unavailable" = "absent";
  /**
   * PB-10 Step 3 Phase 2c final review, PART 6: rows returned by the
   * historical-artifact lookup. Empty by default — the current migration
   * file's own checksum is never an artifact.
   */
  artifacts: AppliedArtifactFixture[] | "unavailable" = [];
  /**
   * PB-10 Step 3 Phase 2c final review, CRITICAL 1: PostgreSQL's own verdict
   * per bound xid8, as pg_xact_status() reports it. "unavailable" makes the
   * lookup itself throw (an unreadable or ungranted pg_xact_status), which must
   * fail closed rather than clear anything.
   */
  xactStatus: Record<string, string | null> | "unavailable" = {};
  unlocked = false;
  dead: Error | undefined;
  onCancel: (() => void) | undefined;
  readonly events: Array<{ migrationId: string; sequence: number; type: string; values: unknown[]; xactId?: string; statementOrdinal?: number }> = [];
  readonly appliedInserts: RecordedApplied[] = [];
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

  constructor(log: Recorded[], readonly proof: ProtectedProofPath) {
    super("control", log);
  }

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.record(sql, values);
    if (this.dead) throw this.dead;
    // CRITICAL 2, half two: the durable binding, written on the control
    // connection in autocommit. The fake schema verifies the receipt against a
    // key this client cannot read and enforces both partial unique indexes, so
    // a forged, replayed or cross-attempt claim raises here exactly as it
    // would in PostgreSQL.
    if (sql.includes("migration_control.record_transaction_binding")) {
      const binding = this.proof.recordTransactionBinding(values?.[0], values?.[1], values?.[2]);
      const { attempt } = binding;
      this.events.push({
        migrationId: attempt.migrationId,
        sequence: binding.eventSequence,
        type: "heartbeat",
        // The row the protected function itself inserts, in the same column
        // order as RunLog's ordinary INSERT. Every identity field is copied
        // from the attempt's own `started` row — the caller supplies none of
        // them — which is why a binding event can never carry an identity that
        // contradicts the attempt it binds.
        values: [
          attempt.runId, attempt.migrationId, binding.eventSequence, "heartbeat", attempt.runnerId,
          null, attempt.sourceGitSha, attempt.executorImageDigest, null, null,
          JSON.stringify(attempt.metadata), null,
        ],
        xactId: binding.xactId,
      });
      return { rows: [{ record_transaction_binding: null }], rowCount: 1 };
    }
    // PB-10 Step 3 Phase 2c final review, CRITICAL: the H2 progress markers.
    // The execution role has no INSERT privilege on statement_ordinal, so a
    // marker can only appear through this protected call — which is why the
    // fake refuses a token it never armed, a marker out of lifecycle order and
    // a duplicate, exactly as the SQL does.
    if (sql.includes("migration_control.record_progress_marker")) {
      const marker = this.proof.recordProgressMarker(values?.[0], values?.[1], values?.[2]);
      const { attempt } = marker;
      this.events.push({
        migrationId: attempt.migrationId,
        sequence: marker.eventSequence,
        type: "heartbeat",
        values: [
          attempt.runId, attempt.migrationId, marker.eventSequence, "heartbeat", attempt.runnerId,
          null, attempt.sourceGitSha, attempt.executorImageDigest, null, null,
          JSON.stringify(attempt.metadata), null,
        ],
        statementOrdinal: marker.ordinal,
      });
      return { rows: [{ record_progress_marker: null }], rowCount: 1 };
    }
    // CRITICAL 1: every non-transactional mode records its applied row here.
    // The fake decides commit_proof itself; the caller cannot supply one.
    if (sql.includes("migration_control.record_applied_migration")) {
      const applied = this.proof.recordApplied(values?.[0], values?.[1], values?.[2], values?.[3], null);
      this.appliedInserts.push(applied);
      return { rows: [{ commit_proof: applied.commitProof }], rowCount: 1 };
    }
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
    const controlSchema = answerControlSchemaQuery(sql, this.controlSchemaDrift);
    if (controlSchema) return controlSchema as QueryResult;
    if (sql.includes("into migration_control.migration_runs")) {
      const eventType = String(values?.[3]);
      // The `started` row carries attempt_token_sha256 and nothing else does
      // (mr_attempt_token_ck). Arming here — from the digest the executor
      // itself wrote through its ordinary column-level INSERT privilege —
      // mirrors production exactly: the token stays in the runner's memory and
      // only its digest reaches the database.
      if (eventType === "started" && values?.[11] instanceof Buffer) {
        this.proof.arm({
          digest: (values[11] as Buffer).toString("hex"),
          runId: String(values?.[0]),
          migrationId: String(values?.[1]),
          runnerId: (values?.[4] ?? null) as string | null,
          sourceGitSha: (values?.[6] ?? null) as string | null,
          executorImageDigest: (values?.[7] ?? null) as string | null,
          metadata: JSON.parse(String(values?.[10])) as Record<string, unknown>,
        });
      }
      this.events.push({
        migrationId: String(values?.[1]),
        sequence: Number(values?.[2]),
        type: eventType,
        values: values ?? [],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("from migration_control.migration_runs")) {
      // PostgreSQL returns an absent binding as null, never undefined.
      const rows = this.priorEvents.map((event) => ({ ...event, xact_id: event.xact_id ?? null }));
      return { rows, rowCount: rows.length };
    }
    // PB-10 Step 3 Phase 2c final review, PART 6: the immutable historical
    // artifact lookup — the committed applied-ledger row whose
    // applied_checksum_sha256 proves the bytes a historical run executed.
    // Distinct from the ambiguous-COMMIT reconciliation query below (which
    // additionally binds run_id and the applied checksum).
    if (sql.includes("pg_xact_status")) {
      if (this.xactStatus === "unavailable") throw new Error("pg_xact_status is not executable by this role");
      const requested = (values?.[0] ?? []) as string[];
      const rows = requested.map((xid) => ({ xid, status: (this.xactStatus as Record<string, string | null>)[xid] ?? null }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("from migration_control.schema_migrations")
      && sql.includes("where migration_id")
      && !sql.includes("and run_id =")) {
      if (this.artifacts === "unavailable") throw new Error("artifact query failed");
      return { rows: this.artifacts, rowCount: this.artifacts.length };
    }
    if (sql.includes("from migration_control.schema_migrations") && sql.includes("where migration_id")) {
      if (this.reconciliation === "unavailable") throw new Error("reconciliation query failed");
      return this.reconciliation === "committed"
        ? { rows: [{ migration_id: values?.[0] }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
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
  /**
   * PB-10 Step 3 Phase 2c final review, CRITICAL 1: the xid8 this fake's
   * migration transaction reports from pg_current_xact_id().
   */
  xactId = "5001";
  /**
   * Tracks whether this connection is inside an open transaction, so the fake
   * protected functions see the same pg_current_xact_id() PostgreSQL would:
   * a real value between BEGIN and COMMIT/ROLLBACK, and nothing outside one.
   * That is what makes "record commit proof from outside the bound
   * transaction" fail here for the same reason it fails in the database.
   */
  private currentXact: string | null = null;
  failXactBinding = false;
  failMigrationSql: Error | undefined;
  failRollback = false;
  failCommit: Error | undefined;
  /**
   * When true, every query issued after failCommit throws too — simulating a
   * genuinely dead connection (COMMIT sent, response lost) rather than an
   * ordinary PostgreSQL rejection of COMMIT itself, which leaves the
   * connection alive and answering queries normally.
   */
  connectionDiesOnCommit = false;
  private diedAfterCommit = false;
  hangMigrationSql = false;
  readonly appliedInserts: RecordedApplied[] = [];
  private settleHang: ((outcome: { error?: unknown }) => void) | undefined;

  constructor(log: Recorded[], readonly proof: ProtectedProofPath) {
    super("execution", log);
  }

  /** Resolves a hung migration-SQL call; pass an error to reject it instead (e.g. simulating SQLSTATE 57014). */
  settlePendingOperation(error?: unknown): void {
    this.settleHang?.({ error });
  }

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.record(sql, values);
    if (this.diedAfterCommit) throw new Error("connection terminated unexpectedly");
    if (sql.includes("set_config")) return { rows: [{ set_config: String(values?.[1]) }], rowCount: 1 };
    if (sql === "begin") {
      this.currentXact = this.xactId;
      return { rows: [], rowCount: null };
    }
    if (sql === "commit") {
      if (this.failCommit) {
        if (this.connectionDiesOnCommit) this.diedAfterCommit = true;
        throw this.failCommit;
      }
      this.currentXact = null;
      return { rows: [], rowCount: null };
    }
    if (sql === "rollback") {
      if (this.failRollback) throw new Error("rollback failed");
      this.currentXact = null;
      return { rows: [], rowCount: null };
    }
    if (sql === "select 1") return { rows: [{ "?column?": 1 }], rowCount: 1 };
    if (sql.includes("pg_backend_pid")) return { rows: [{ pid: 4242 }], rowCount: 1 };
    // CRITICAL 2, half one. The transaction id is read from this connection's
    // own state, never from the arguments — a caller cannot name a
    // transaction it is not running in, here or in PostgreSQL.
    if (sql.includes("migration_control.claim_transaction")) {
      if (this.failXactBinding) throw new Error("could not read the transaction id");
      return { rows: [{ claim: this.proof.claimTransaction(values?.[0], this.currentXact) }], rowCount: 1 };
    }
    // CRITICAL 1: a transactional attempt's applied row, recorded from inside
    // the bound transaction. commit_proof is the fake schema's verdict, not
    // this client's.
    if (sql.includes("migration_control.record_applied_migration")) {
      const applied = this.proof.recordApplied(values?.[0], values?.[1], values?.[2], values?.[3], this.currentXact);
      this.appliedInserts.push(applied);
      return { rows: [{ commit_proof: applied.commitProof }], rowCount: 1 };
    }
    // Anything else is migration SQL.
    if (this.failMigrationSql) throw this.failMigrationSql;
    if (this.hangMigrationSql) {
      return new Promise<QueryResult>((resolve, reject) => {
        this.settleHang = (outcome) => {
          if (outcome.error) reject(outcome.error);
          else resolve({ rows: [], rowCount: null });
        };
      });
    }
    return { rows: [], rowCount: null };
  }
}

class FakePool extends EventEmitter {
  readonly log: Recorded[] = [];
  /**
   * One protected schema shared by both connections, because there is one
   * database. An attempt armed on the control connection is the same attempt
   * the execution connection claims a transaction for.
   */
  readonly proof = new ProtectedProofPath();
  readonly control = new ControlClient(this.log, this.proof);
  readonly execution = new ExecutionClient(this.log, this.proof);
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
      && !sql.includes("migration_control.claim_transaction")
      && !sql.includes("migration_control.record_applied_migration")
      && !["begin", "commit", "rollback", "select 1"].includes(sql));
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

// PB-10 Step 3 Phase 2c final review: executeMigrations(pool) must be the
// sole *callable* production migration-execution entry point at the emitted
// build level, not merely by documented convention. The former multi-file
// arrangement (batched.ts, execution-context.ts, supervision.ts, each its
// own separately compiled module with its own exported internals) has been
// merged directly into execute.ts as module-private declarations: every
// internal helper those files used to export — the batch executor, RunLog,
// insertAppliedRow, assertNoUnresolvedCommitAmbiguity,
// reconcileAmbiguousCommit, independentControlAcquirer,
// appendAmbiguityDurably, the cancellation-supervision state machine, and
// their supporting types — is now a plain, non-exported declaration inside
// this one file. Those three files no longer exist at all, so there is
// nothing left for tsc to separately compile or emit, and no deep-import
// path (a former dist/db/migrate/batched.js or execution-context.js
// equivalent) can expose them, regardless of what any other module does.
test("production build exposes exactly the approved public surface, and no other migrate module provides an alternate entry point", () => {
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

    // C: complete emitted-file inventory for the migrate module.
    const emittedFiles = require("node:fs").readdirSync(migrationOutput).sort();
    const forbiddenNames = ["batched.js", "batched.d.ts", "execution-context.js", "execution-context.d.ts", "supervision.js", "supervision.d.ts"];
    for (const name of forbiddenNames) {
      assert.equal(emittedFiles.includes(name), false, `${name} must not exist in the emitted build — its implementation is now module-private inside execute.js`);
      assert.throws(() => require.resolve(path.join(migrationOutput, name)), `deep-importing ${name} must fail: the file does not exist`);
    }

    // D/F: runtime export keys for every emitted migrate .js file — none
    // exposes an alternate executor, reconciliation helper, connection
    // acquirer, event/ledger writer, or registry. Each is `require()`d in a
    // clean child process (NODE_PATH pointed at this project's real
    // node_modules, since the disposable build directory has none of its
    // own) and its `Object.keys(exports)` inspected directly, rather than
    // merely regexed.
    const forbiddenNamePattern = "executeBatched|superviseOperation|superviseCallback|SupervisedOperationContext|RunLog|insertAppliedRow|assertNoUnresolvedCommitAmbiguity|reconcileAmbiguousCommit|independentControlAcquirer|appendAmbiguityDurably|CommitReconciliation|MigrationContext|MigrationHandlers|registeredHandlers|executeVerifiedMigrations|InternalExecuteOptions|CONNECTION_LOSS_SETTLE_GRACE_MS|settleGraceMs";
    const emittedJsFiles = emittedFiles.filter((name: string) => name.endsWith(".js"));
    const probe = spawnSync(process.execPath, ["-e", `
      const assert = require("node:assert/strict");
      const path = require("node:path");
      const forbidden = new RegExp(${JSON.stringify(forbiddenNamePattern)});
      const files = ${JSON.stringify(emittedJsFiles)};
      const migrationOutput = ${JSON.stringify(migrationOutput)};
      for (const name of files) {
        const target = require(path.join(migrationOutput, name));
        for (const key of Object.keys(target)) {
          assert.doesNotMatch(key, forbidden, name + " exports a forbidden internal symbol: " + key);
        }
        for (const [key, value] of Object.entries(target)) {
          if (typeof value === "function" && name === "execute.js") {
            assert.ok(
              ["executeMigrations", "inspectConcurrentIndex", "renderExecutionReport", "MigrationExecutionError"].includes(key),
              "execute.js exports an unapproved callable: " + key,
            );
          }
          assert.ok(
            typeof value !== "object" || value === null || (!("set" in value) && !("delete" in value) && !("clear" in value)),
            name + " exports a mutable registry-shaped value: " + key,
          );
        }
      }

      // I: execute.js exports exactly the previously approved public runtime surface.
      const executeTarget = require(path.join(migrationOutput, "execute.js"));
      const approvedRuntimeKeys = new Set([
        "ERROR_CLASSES", "MigrationExecutionError", "CANCELLATION_GRACE_MS",
        "TIMEOUT_CEILINGS", "TRANSACTIONAL_WALL_CLOCK_CEILING_MS", "NONTRANSACTIONAL_WALL_CLOCK_CEILING_MS",
        "SCHEMA_RUNNER_WALL_CLOCK_MS", "inspectConcurrentIndex", "renderExecutionReport", "executeMigrations",
      ]);
      assert.deepEqual(new Set(Object.keys(executeTarget)), approvedRuntimeKeys, "execute.js's runtime export set must be exactly the approved public surface");
      // G: executeMigrations is the sole callable production execution entry
      // point, and still accepts exactly one Pool argument.
      assert.equal(executeTarget.executeMigrations.length, 1);
      assert.equal(typeof executeTarget.executeMigrations, "function");

      // H: no environment bypass, registry, hook, or alternate subpath.
      assert.equal(executeTarget.executeMigrations.toString().includes("NODE_ENV"), false);
      assert.equal(executeTarget.executeMigrations.toString().includes("process.env.CI"), false);
      assert.equal("registeredHandlers" in executeTarget, false);
      assert.equal("executeVerifiedMigrations" in executeTarget, false);

      // The handler registry is two pure lookup functions, never a container:
      // nothing loaded in the same process can add a handler to it, and in
      // the emitted production build both refuse every id — so every
      // nontransactional/batched manifest entry still fails closed on
      // unsupported_handler. (The batched regression suites substitute this
      // one module through the test adapter's Module._load interception,
      // which exists only in the test process and is not reachable from
      // anything here.)
      const handlersTarget = require(path.join(migrationOutput, "handlers.js"));
      assert.deepEqual(
        new Set(Object.keys(handlersTarget)),
        new Set(["nontransactionalHandlerFor", "batchedHandlerFor"]),
        "handlers.js exposes exactly two lookup functions and nothing else",
      );
      for (const id of ["0100", "0102", "9999", ""]) {
        assert.equal(handlersTarget.batchedHandlerFor(id), undefined, "the emitted production build registers no batched handler");
        assert.equal(handlersTarget.nontransactionalHandlerFor(id), undefined, "the emitted production build registers no nontransactional handler");
      }
      console.log("PROBE_OK");
    `], {
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: path.resolve(__dirname, "../node_modules") },
    });
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    assert.match(probe.stdout, /PROBE_OK/);

    // E/I: execute.d.ts preserves the approved public declaration surface,
    // and inspecting the declaration text itself proves the internal
    // functions/types are absent as externally importable runtime seams.
    const declaration = readFileSync(path.join(migrationOutput, "execute.d.ts"), "utf8");
    assert.match(declaration, /executeMigrations\(pool: Pool\): Promise<ExecutionReport>/);
    assert.doesNotMatch(declaration, new RegExp(forbiddenNamePattern));

    // PB-10 Step 3 Phase 2c final review, blocker 2: production timing must
    // never be reachable — or even nameable — from the emitted build. A
    // connection-loss settlement grace and its `settleGraceMs` override were
    // emitted as real runtime and declaration API; both are gone, and neither
    // may come back. The runtime-export probe above cannot catch
    // `settleGraceMs`, which was a type-only property on an exported options
    // interface, so every emitted .js and .d.ts in the module is inspected as
    // text here. Deterministic timing belongs exclusively to the test adapter
    // and test harness (see test/helpers/migration-execute.ts and
    // PB10_OWNERSHIP_HOLD_MS in migration-runner.test.ts), never to a
    // production option.
    const timingHookPattern = /CONNECTION_LOSS_SETTLE_GRACE_MS|settleGraceMs/;
    for (const name of emittedFiles.filter((file: string) => file.endsWith(".js") || file.endsWith(".d.ts"))) {
      const emitted = readFileSync(path.join(migrationOutput, name), "utf8");
      assert.doesNotMatch(emitted, timingHookPattern, `${name} must not expose or reference a connection-loss timing hook`);
    }
    const lockDeclaration = readFileSync(path.join(migrationOutput, "runner.d.ts"), "utf8");
    assert.match(lockDeclaration, /interface SchemaLockOptions/, "the declaration actually inspected is the one declaring the lock options");
    assert.doesNotMatch(lockDeclaration, timingHookPattern, "SchemaLockOptions must declare no test-only timing override");

    assert.throws(() => require.resolve("../src/db/migrate/execute-internal"));

    const srcRoot = path.resolve(__dirname, "../src");
    assert.equal(existsSync(path.join(srcRoot, "index.ts")), false, "no top-level barrel file exists to re-export internals");
    const migrateDir = path.join(srcRoot, "db", "migrate");
    assert.equal(existsSync(path.join(migrateDir, "index.ts")), false, "no db/migrate barrel file exists to re-export internals");
    assert.equal(existsSync(path.join(migrateDir, "batched.ts")), false, "batched.ts no longer exists as a separate source file");
    assert.equal(existsSync(path.join(migrateDir, "execution-context.ts")), false, "execution-context.ts no longer exists as a separate source file");
    assert.equal(existsSync(path.join(migrateDir, "supervision.ts")), false, "supervision.ts no longer exists as a separate source file");

    const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")) as Record<string, unknown>;
    assert.equal("exports" in packageJson, false, "package.json must not declare a subpath export map exposing internals");
    assert.equal("main" in packageJson, false, "package.json must not declare a main field pointing at an internal module");
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
  // CRITICAL 1: the applied checksum is copied by the protected function from
  // the attempt's own `started` row — the caller never supplies it — and a
  // legacy-verbatim attempt owns no migration transaction, so the database
  // classifies the row post_hoc_verified and never as atomic commit proof.
  assert.equal(pool.control.appliedInserts[0].attempt.metadata.checksum_sha256, checksum);
  assert.equal(pool.control.appliedInserts[0].manifestChecksum, entries.legacy.sha256);
  assert.equal(pool.control.appliedInserts[0].commitProof, "post_hoc_verified");
  assert.equal(pool.execution.appliedInserts.length, 0);
  assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "heartbeat", "operation_completed", "applied_committed", "succeeded"],
    "H2: the durable-work marker is committed before the payload is issued");
  for (const { values } of pool.control.events) {
    const metadata = JSON.parse(String(values[10])) as Record<string, unknown>;
    assert.equal(metadata.migration_filename, entries.legacy.filename);
    assert.equal(metadata.migration_ordinal, 1);
  }
});

// 5 ───────────────────────────────────────────────────────────────────────────
/**
 * PB-10 Step 3 Phase 2c final review, CRITICAL 2: legacy-verbatim used to have
 * a retry evaluator all of its own — an exact hand-shaped event sequence that,
 * if matched, permitted automatic replay. That made the mode with the least
 * provable commit boundary the one with the weakest gate, and it accepted a
 * pattern of *labels* as proof of a rollback. It is gone: legacy-verbatim now
 * goes through the same canonical fence as every other mode, and because its
 * payload owns its own BEGIN/COMMIT there is no transaction to bind and no
 * artifact written atomically with it — so no legacy history can ever prove
 * itself, and recovery is an operator resolution.
 */
test("a stale legacy attempt fails closed and is never replayed", async () => {
  const pool = new FakePool();
  pool.control.priorEvents = [retryEvent(1, "started")];
  await assert.rejects(run(pool), /commit_outcome_unknown/);
  assert.deepEqual(pool.migrationSql(), [], "no legacy SQL may be replayed");
  assert.deepEqual(pool.control.appliedInserts, []);
});

test("legacy-verbatim has no automatic retry path: even a confirmed rollback history blocks", async () => {
  // Exactly the history the deleted legacy FSM accepted as safe to replay.
  const previouslyAccepted = [
    retryEvent(1, "started"),
    retryEvent(2, "heartbeat"),
    retryEvent(3, "transaction_rolled_back"),
    retryEvent(4, "execution_failed"),
  ];
  const otherRun = "10000000-0000-4000-8000-000000000002";
  const cases: Array<[string, PriorEventFixture[]]> = [
    ["the previously accepted confirmed-rollback shape", previouslyAccepted],
    ["a bare armed attempt", [retryEvent(1, "started")]],
    ["duplicate started", [retryEvent(1, "started"), retryEvent(2, "started"), retryEvent(3, "transaction_rolled_back"), retryEvent(4, "execution_failed")]],
    ["missing started", [retryEvent(1, "heartbeat"), retryEvent(2, "transaction_rolled_back"), retryEvent(3, "execution_failed")]],
    ["sequence gap", [retryEvent(1, "started"), retryEvent(3, "transaction_rolled_back"), retryEvent(4, "execution_failed")]],
    ["duplicate sequence", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back"), retryEvent(2, "execution_failed")]],
    ["unknown COMMIT", [retryEvent(1, "started"), retryEvent(2, "execution_failed")]],
    ["connection loss", [retryEvent(1, "started"), retryEvent(2, "execution_failed", { error_class: "control_connection_lost" })]],
    ["events from another run", [retryEvent(1, "started"), retryEvent(2, "transaction_rolled_back"), retryEvent(3, "execution_failed", { run_id: otherRun })]],
  ];

  for (const [name, events] of cases) {
    const ambiguous = new FakePool();
    ambiguous.control.priorEvents = events;
    await assert.rejects(run(ambiguous), /commit_outcome_unknown/, name);
    assert.deepEqual(ambiguous.migrationSql(), [], name);
    assert.deepEqual(ambiguous.control.appliedInserts, [], name);
  }

  // A rename cannot launder a blocked history into a fresh one either.
  const renamedFilename = new FakePool();
  renamedFilename.control.priorEvents = previouslyAccepted;
  writeFileSync(path.join(root, "db", "migrations", "0001_renamed_after_failure.sql"), files["0001_legacy_demo.sql"]);
  await assert.rejects(
    run(renamedFilename, {
      manifest: manifestOf({ ...entries.legacy, filename: "0001_renamed_after_failure.sql" }),
    }),
    /commit_outcome_unknown/,
  );
  assert.deepEqual(renamedFilename.migrationSql(), []);
  assert.deepEqual(renamedFilename.control.appliedInserts, []);
});

test("a legacy SQL failure records confirmed rollback before failure", async () => {
  const pool = new FakePool();
  pool.execution.failMigrationSql = pgError("known failure", "23505");
  await assert.rejects(run(pool), /sql_failed/);
  assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "heartbeat", "transaction_rolled_back", "execution_failed"]);
  // H2: the two protected markers carry statement_ordinal 1 and 2. Nothing
  // else does — the ordinary INSERT path cannot name the column at all, so the
  // failure rows that historically carried a decorative ordinal now carry none.
  assert.deepEqual(
    pool.control.events.map(({ statementOrdinal }) => statementOrdinal ?? null),
    [null, 1, 2, null, null],
  );
  assert.deepEqual(pool.control.appliedInserts, []);
});

// 6 ───────────────────────────────────────────────────────────────────────────
test("transactional SQL and its applied row commit atomically on one connection", async () => {
  const pool = new FakePool();
  const report = await run(pool, { manifest: manifestOf(entries.transactional) });

  const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
  const begin = executionSql.indexOf("begin");
  // CRITICAL 2: the transaction is claimed from inside itself, immediately
  // after BEGIN and strictly before any migration SQL, so PostgreSQL's own
  // verdict on this exact transaction exists before anything can fail.
  const claim = executionSql.findIndex((sql) => sql.includes("claim_transaction"));
  const migration = executionSql.findIndex((sql) => sql.includes("alter table demo"));
  const insert = executionSql.findIndex((sql) => sql.includes("record_applied_migration"));
  const commit = executionSql.indexOf("commit");
  assert.ok(
    begin >= 0 && begin < claim && claim < migration && migration < insert && insert < commit,
    executionSql.join(" | "),
  );

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
  // CRITICAL 1: the applied row was recorded from inside the exact bound
  // transaction, so the database — not this process — classified it as atomic
  // commit proof. Any other classification for a transactional attempt is
  // refused by the evaluator.
  assert.equal(pool.execution.appliedInserts[0].commitProof, "transaction_atomic");
  const binding = pool.proof.bindingFor(RUN_ID, entries.transactional.id);
  assert.equal(binding?.xactId, pool.execution.xactId, "the durable binding names the real migration transaction");
  assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "applied_committed", "succeeded"]);
  assert.equal(pool.control.events[1].xactId, pool.execution.xactId);
  assert.equal(report.executedCount, 1);
});

// 7, 8 ────────────────────────────────────────────────────────────────────────
test("transactional failure rolls back with no applied row and durable control events", async () => {
  const pool = new FakePool();
  const failure = pgError(`duplicate key value violates unique constraint: ${SECRET}`, "23505");
  pool.execution.failMigrationSql = failure;

  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /sql_failed/);

  const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
  assert.ok(executionSql.includes("rollback"));
  assert.ok(!executionSql.includes("commit"));
  assert.deepEqual(pool.execution.appliedInserts, []);
  assert.deepEqual(pool.control.appliedInserts, []);
  // The rollback destroyed the transaction; the events survive because they were
  // written on the control connection in autocommit.
  assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "transaction_rolled_back", "execution_failed"]);
  // Past started and the transaction binding: both terminal rows.
  for (const event of pool.control.events.slice(2)) {
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

// PB-10 Step 3 Phase 2c final review: batched mode has zero real production
// migrations (registeredHandlers.batched is hardcoded empty), and
// executeBatched is now module-private inside execute.ts with no direct-call
// test seam — see this file's own "production build exposes exactly the
// approved public surface" test for why. What remains genuinely provable
// through executeMigrations(pool) is that batched-mode manifest entries are
// still subject to the exact same shared commit_outcome_unknown
// reconciliation guard every other execution mode uses (the guard runs
// before the mode-specific handler lookup, so it applies uniformly even to
// a mode with no reviewed handler yet).
test("batched: an armed, unreconciled commit_outcome_unknown for a batched-mode migration blocks the next attempt before BEGIN — the shared reconciliation guard applies even to a mode with no registered handler", async () => {
  const pool = new FakePool();
  const armedForBatched: PriorEventFixture = {
    event_id: 2,
    migration_id: entries.batched.id,
    run_id: "10000000-0000-4000-8000-000000000098",
    event_sequence: 2,
    event_type: "execution_failed",
    runner_id: identity.runnerId,
    heartbeat_deadline: null,
    source_git_sha: identity.sourceGitSha,
    executor_image_digest: identity.executorImageDigest,
    sqlstate: null,
    error_class: "commit_outcome_unknown",
    metadata: {
      execution_mode: "batched",
      migration_filename: entries.batched.filename,
      migration_ordinal: 1,
      checksum_sha256: entries.batched.sha256,
    },
    statement_ordinal: null,
  };
  pool.control.priorEvents = [armedForBatched];
  await assert.rejects(run(pool, { manifest: manifestOf(entries.batched) }), /commit_outcome_unknown/);
  assert.deepEqual(pool.migrationSql(), [], "execution must never begin while an unreconciled ambiguity is armed, even for a mode with no registered handler");
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
  pool.execution.failMigrationSql = pgError("boom", "42601");
  // Phase 2c blocker 4: rollback failing here means ROLLBACK is never
  // proven, so this now fails closed as commit_outcome_unknown, not
  // sql_failed — forces context.destroyExecution() in executeTransactional's
  // catch either way.
  pool.execution.failRollback = true;
  pool.control.gateUnlock = true;

  const pending = run(pool, { manifest: manifestOf(entries.transactional) });

  await waitUntil(() => pool.control.unlockStarted, "the advisory unlock query to be issued");
  pool.control.emit("error", new Error("terminating connection due to administrator command"));
  pool.control.settleUnlock();

  await assert.rejects(pending, /commit_outcome_unknown/);

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
    "migration_ordinal", "verification", "reclaim_reason", "checksum_sha256",
    "resolved_event_id", "resolved_run_id", "resolved_checksum_sha256",
  ]);
  for (const event of pool.control.events) {
    for (const key of Object.keys(JSON.parse(String(event.values[10])))) {
      assert.ok(permitted.has(key), `metadata key ${key} is not permitted`);
    }
  }

  // A failing migration must not surface the server's message either.
  const failing = new FakePool();
  failing.execution.failMigrationSql = pgError(`boom ${SECRET}`, "42P01");
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
  assert.deepEqual(pool.control.appliedInserts[0].attempt.migrationId, entries.legacy.id);
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
  assert.deepEqual(pool.control.events.map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(pool.control.events.every(({ values }) => values[0] === RUN_ID));
  // heartbeat_deadline is permitted only on started events. The transaction
  // binding is a heartbeat and deliberately carries none: it records what
  // PostgreSQL will be asked about later, not liveness.
  for (const event of pool.control.events) {
    assert.equal(event.values[5] === null, event.type !== "started");
  }
  // CRITICAL 2: exactly one binding, on the one mode that owns a migration
  // transaction, and it is the *only* row carrying an xact_id. RunLog's own
  // INSERT can never name that column at all — the execution role's
  // column-level INSERT privilege excludes it — so a binding exists only as
  // the output of migration_control.record_transaction_binding.
  const bindings = pool.control.events.filter(({ xactId }) => xactId !== undefined);
  assert.deepEqual(bindings.map(({ type }) => type), ["heartbeat"], "exactly one transaction binding, on the transactional migration");
  assert.equal(bindings[0].xactId, "5001");
  assert.equal(bindings[0].migrationId, entries.transactional.id);
  // The arming digest is on the `started` rows and nowhere else
  // (mr_attempt_token_ck).
  assert.deepEqual(
    pool.control.events.filter(({ values }) => values[11] !== null).map(({ type }) => type),
    ["started", "started"],
  );
});

/**
 * PB-10 Step 3 Phase 2b: whole-migration wall-clock supervision.
 *
 * process.hrtime.bigint is mocked directly (the same technique Date.now
 * already uses above) to drive the monotonic deadline deterministically;
 * options.sleep replaces node:timers/promises' setTimeout inside execute.ts
 * so superviseOperation/superviseCallback's Promise.race is driven by a
 * controllable resolver queue instead of a real timer, exactly like
 * migration-execute-supervision.test.ts already does for superviseOperation
 * in isolation — these tests drive the exact same state machine end-to-end
 * through executeMigrations(pool).
 */
const QUERY_CANCELED = pgError("canceling statement due to user request", "57014");

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
  const pending: Array<() => void> = [];
  const durations: number[] = [];
  let notifyFirstSleep: (() => void) | undefined;
  const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => {
    durations.push(milliseconds);
    pending.push(resolve);
    if (pending.length === 1) notifyFirstSleep?.();
  });
  return {
    sleep,
    durations,
    callCount(): number {
      return pending.length;
    },
    fire(index: number): void {
      const resolve = pending[index];
      assert.ok(resolve, `no sleep() call recorded at index ${index}`);
      resolve();
    },
    /** Resolves as soon as the production code actually invokes sleep() for the first time. */
    waitForFirstSleep(): Promise<void> {
      if (pending.length > 0) return Promise.resolve();
      return new Promise((resolve) => { notifyFirstSleep = resolve; });
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * superviseOperation is reached via real fs.readFile calls and other awaits
 * whose completion order is not deterministic under load, so this waits on
 * the sleep controller's own barrier (resolved exactly when the production
 * code invokes context.sleep) rather than polling a fixed number of event
 * loop turns. The 10s timer is only a watchdog against a genuine hang, never
 * the synchronization mechanism itself.
 */
async function tickUntilFirstSleep(sleepController: ReturnType<typeof controllableSleep>): Promise<void> {
  let timedOut = false;
  const watchdog = new Promise<void>((resolve) => {
    setTimeout(() => { timedOut = true; resolve(); }, 10_000).unref();
  });
  await Promise.race([sleepController.waitForFirstSleep(), watchdog]);
  assert.ok(!timedOut && sleepController.callCount() > 0, "the wall-clock supervision sleep was never reached");
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

// 1 ────────────────────────────────────────────────────────────────────────────
test("transactional migration completes within budget", async () => {
  const pool = new FakePool();
  const report = await run(pool, { manifest: manifestOf(entries.transactional) });
  assert.equal(report.executedCount, 1);
  assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "applied_committed", "succeeded"]);
  assert.equal(pool.execution.releaseCount, 1);
  assert.equal(pool.execution.releasedWith, undefined, "a healthy connection is released without an error");
});

// 2, 16 ───────────────────────────────────────────────────────────────────────
test("a wallClockMs budget smaller than the declared PostgreSQL ceilings becomes the effective control-side timeout", async () => {
  const pool = new FakePool();
  const sleepController = controllableSleep();
  const tightEntry: MigrationManifestEntry = {
    ...entries.transactional,
    timeouts: { ...timeouts, wallClockMs: 1_000 },
  };
  const restore = mockMonotonic(0); // no real elapsed time between checks
  try {
    await run(pool, { manifest: manifestOf(tightEntry), sleep: sleepController.sleep });
  } finally {
    restore.restore();
  }
  const settings = pool.log
    .filter(({ client, sql }) => client === "execution" && sql.includes("set_config"))
    .map(({ values }) => (values as [string, string, boolean]).slice(0, 2));
  assert.deepEqual(settings, [
    ["lock_timeout", "5000"],
    ["statement_timeout", "60000"],
    ["transaction_timeout", "300000"],
    ["idle_in_transaction_session_timeout", "60000"],
  ]);
  assert.equal(sleepController.durations[0], 1_000, "the smaller remaining migration budget is the effective supervisor timeout");
});

// 3 ────────────────────────────────────────────────────────────────────────────
test("transactional budget expires before the migration statement begins: no statement runs, rollback is attempted and proven", async () => {
  const pool = new FakePool();
  const tightEntry: MigrationManifestEntry = {
    ...entries.transactional,
    timeouts: { ...timeouts, wallClockMs: 1_000 },
  };
  // call 1: deadline base (0ms) -> deadline = 1000ms
  // call 2: pre-begin check (100ms) -> remaining 900ms, proceeds
  // call 3: pre-statement check (2000ms) -> remaining -1000ms, fails closed
  const restore = mockMonotonic(0, 100, 2_000);
  try {
    await assert.rejects(run(pool, { manifest: manifestOf(tightEntry) }), /wall_clock_exceeded/);
  } finally {
    restore.restore();
  }
  const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
  assert.ok(executionSql.includes("begin"));
  assert.ok(executionSql.includes("rollback"));
  assert.ok(!executionSql.includes("commit"));
  assert.ok(!executionSql.some((sql) => sql.includes("alter table demo")), "the migration statement never ran");
  assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "transaction_rolled_back", "execution_failed"]);
  for (const event of pool.control.events.slice(2)) {
    assert.equal(event.values[9], "wall_clock_exceeded");
  }
  assert.equal(pool.execution.releaseCount, 1);
});

// 4, 5 ────────────────────────────────────────────────────────────────────────
test("transactional SQL cancelled and confirmed via 57014: confirmed rollback produces the established wall-clock failure", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    pool.execution.hangMigrationSql = true;
    const sleepController = controllableSleep();

    const pending = run(pool, { manifest: manifestOf(entries.transactional), sleep: sleepController.sleep });
    await tickUntilFirstSleep(sleepController);
    sleepController.fire(0); // wall-clock budget expires, cancellation requested
    await tick();
    pool.execution.settlePendingOperation(QUERY_CANCELED); // confirmed within grace

    await assert.rejects(pending, /wall_clock_exceeded/);
    const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
    assert.ok(executionSql.includes("rollback"));
    assert.ok(!executionSql.includes("commit"));
    assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "transaction_rolled_back", "execution_failed"]);
    assert.equal(pool.execution.releaseCount, 1);
    assert.equal(pool.execution.releasedWith, undefined, "confirmed cancellation plus confirmed rollback leaves a healthy, reusable connection");
  });
});

// 6 ────────────────────────────────────────────────────────────────────────────
test("transactional rollback failure after confirmed cancellation: non-retryable, never claims rollback, durably blocks replay", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    pool.execution.hangMigrationSql = true;
    pool.execution.failRollback = true;
    const sleepController = controllableSleep();

    const pending = run(pool, { manifest: manifestOf(entries.transactional), sleep: sleepController.sleep });
    await tickUntilFirstSleep(sleepController);
    sleepController.fire(0);
    await tick();
    pool.execution.settlePendingOperation(QUERY_CANCELED);

    // Phase 2c blocker 4: a cancellation whose own ROLLBACK cannot be
    // confirmed is exactly as ambiguous as an unconfirmed COMMIT — it must
    // durably arm commit_outcome_unknown, never the narrower
    // cancellation_unverified class, which assertNoUnresolvedCommitAmbiguity
    // does not recognise and would otherwise leave this migration eligible
    // for blind replay.
    await assert.rejects(pending, /commit_outcome_unknown/);
    assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "execution_failed"], "rollback is never claimed when it could not be confirmed");
    assert.equal(pool.control.events[pool.control.events.length - 1].values[9], "commit_outcome_unknown");
    assert.equal(pool.execution.releaseCount, 1);
    assert.ok(pool.execution.releasedWith, "an unproven rollback destroys the connection rather than reusing it");
  });
});

test("transactional rollback failure after confirmed cancellation durably blocks the next attempt before BEGIN is ever sent", async () => {
  const pool = new FakePool();
  pool.control.priorEvents = [{
    event_id: 2,
    migration_id: entries.transactional.id,
    run_id: "10000000-0000-4000-8000-000000000002",
    event_sequence: 2,
    event_type: "execution_failed",
    runner_id: identity.runnerId,
    heartbeat_deadline: null,
    source_git_sha: identity.sourceGitSha,
    executor_image_digest: identity.executorImageDigest,
    sqlstate: null,
    error_class: "commit_outcome_unknown",
    metadata: { execution_mode: "transactional", migration_filename: entries.transactional.filename, migration_ordinal: 1 },
    statement_ordinal: null,
  }];
  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
  const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
  assert.deepEqual(executionSql, [], "no BEGIN and no migration SQL are ever sent while a cancellation-driven ambiguity is unreconciled");
});

// PB-10 Step 3 Phase 2c: ambiguous post-COMMIT connection failure ──────────────
// Requirement #1: transactional COMMIT succeeds — covered above ("transactional
// migration completes within budget").
// Requirement #2: transactional failure before COMMIT retains sql_failed +
// rollback — covered above ("transactional failure rolls back with no applied
// row and durable control events").

// 3 ────────────────────────────────────────────────────────────────────────────
test("a connection error before COMMIT (e.g. during the applied-ledger insert) is unaffected by the commitStarted boundary", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    const originalQuery = pool.execution.query.bind(pool.execution);
    pool.execution.query = async (sql: string, values?: unknown[]) => {
      if (sql.includes("migration_control.record_applied_migration")) throw new Error("connection reset by peer");
      return originalQuery(sql, values);
    };
    await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /sql_failed/);
    const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
    assert.ok(executionSql.includes("rollback"), "COMMIT was never sent, so rollback is attempted exactly as before Phase 2c");
    assert.ok(!executionSql.includes("commit"), "COMMIT must never be sent once the ledger insert itself failed");
    assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "transaction_rolled_back", "execution_failed"]);
  });
});

// 6 ────────────────────────────────────────────────────────────────────────────
test("transactional COMMIT: an authoritative PostgreSQL ErrorResponse rejection retains sql_failed + rollback, unchanged", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    // A genuine SQLSTATE (.code) is what makes this an authoritative server
    // ErrorResponse — Phase 2c blocker 2: connection liveness alone (a
    // "select 1" probe) is never sufficient proof that COMMIT was rejected.
    pool.execution.failCommit = pgError("could not serialize access due to concurrent update", "40001");
    await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /sql_failed/);
    const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
    assert.ok(executionSql.includes("commit"), "COMMIT was actually sent");
    assert.ok(!executionSql.includes("select 1"), "connection liveness is never probed as proof of anything (Phase 2c blocker 2)");
    assert.ok(executionSql.includes("rollback"), "PostgreSQL's authoritative rejection of COMMIT proves no commit occurred, so rollback follows exactly as any other SQL failure");
    assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "transaction_rolled_back", "execution_failed"]);
    assert.equal(pool.control.events[2].values[9], "sql_failed");
    assert.equal(pool.control.events[3].values[9], "sql_failed");
    assert.equal(pool.execution.releaseCount, 1);
    assert.equal(pool.execution.releasedWith, undefined, "a proven rollback on a live connection leaves it healthy and reusable");
  });
});

// Phase 2c blocker 2 ─────────────────────────────────────────────────────────
test("transactional COMMIT: a non-authoritative rejection (no SQLSTATE) is never treated as proof of PostgreSQL rejecting COMMIT, even though the connection keeps answering queries", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    // No .code at all — a client-side query timeout or generic local
    // rejection, exactly the shape node-postgres produces when it gives up
    // on a query client-side rather than relaying a server ErrorResponse.
    // connectionDiesOnCommit is left false on purpose: the connection stays
    // healthy and answers "select 1" — proving liveness cannot substitute
    // for authoritative proof.
    pool.execution.failCommit = new Error("Query read timeout");
    pool.control.reconciliation = "absent";
    await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
    const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
    assert.ok(!executionSql.includes("rollback"), "no rollback is ever attempted for a non-authoritative rejection: COMMIT may have already landed");
    assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "execution_failed"]);
    assert.equal(pool.control.events[2].values[9], "commit_outcome_unknown");
    assert.ok(pool.execution.releasedWith, "the connection is discarded, not reused, once COMMIT's outcome is unknown");
  });
});

// Phase 2c blocker 2 ─────────────────────────────────────────────────────────
test("transactional COMMIT: a non-authoritative rejection reconciled as committed still succeeds, never trusting the live connection's own say-so", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    pool.execution.failCommit = new Error("Query read timeout");
    pool.control.reconciliation = "committed";
    const report = await run(pool, { manifest: manifestOf(entries.transactional) });
    assert.equal(report.executedCount, 1, "reconciliation, not connection liveness, is what proves the commit");
    assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "applied_committed", "succeeded"]);
  });
});

// 4 ────────────────────────────────────────────────────────────────────────────
test("transactional COMMIT sent, response lost, ledger reconciliation proves it committed: the migration succeeds", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    pool.execution.failCommit = new Error("connection reset by peer");
    pool.execution.connectionDiesOnCommit = true;
    pool.control.reconciliation = "committed";
    const report = await run(pool, { manifest: manifestOf(entries.transactional) });
    assert.equal(report.executedCount, 1, "reconciliation proved the migration committed, so the run reports it as executed");
    assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "applied_committed", "succeeded"]);
    assert.ok(!pool.control.eventTypes().includes("execution_failed"), "no failure event is ever recorded once reconciliation proves success");
    assert.ok(!pool.control.eventTypes().includes("transaction_rolled_back"), "no rollback is ever claimed once reconciliation proves success");
    assert.equal(pool.execution.releaseCount, 1);
    assert.ok(pool.execution.releasedWith, "the suspect connection is still destroyed even though the outcome resolved to success");
  });
});

// 5, 7, 8, 10, 15 ────────────────────────────────────────────────────────────────
test("transactional COMMIT sent, response lost, reconciliation finds no row: commit_outcome_unknown, never sql_failed or rolled back", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    pool.execution.failCommit = new Error(`connection reset by peer: ${SECRET}`);
    pool.execution.connectionDiesOnCommit = true;
    pool.control.reconciliation = "absent";
    const rejection = await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
    void rejection;
    assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "execution_failed"], "no duplicate terminal event, no rollback event");
    assert.equal(pool.control.events[2].values[9], "commit_outcome_unknown");
    assert.notEqual(pool.control.events[2].values[9], "sql_failed");
    assert.notEqual(pool.control.events[2].values[9], "transaction_rolled_back");
    const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
    assert.ok(!executionSql.includes("rollback"), "no rollback is ever attempted once COMMIT may have already succeeded");
    assert.equal(pool.execution.releaseCount, 1, "the execution connection is destroyed exactly once");
    assert.ok(pool.execution.releasedWith, "the connection is discarded, not reused, once COMMIT's outcome is unknown");
    const leaked = JSON.stringify(pool.control.events).includes(SECRET);
    assert.equal(leaked, false, "the raw connection error's message never reaches a ledger event");
  });
});

// 16 ───────────────────────────────────────────────────────────────────────────
test("transactional COMMIT sent, response lost, reconciliation itself fails: fails closed the same way as an absent row", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    pool.execution.failCommit = new Error("connection reset by peer");
    pool.execution.connectionDiesOnCommit = true;
    pool.control.reconciliation = "unavailable";
    await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
    assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "execution_failed"]);
    assert.equal(pool.control.events[2].values[9], "commit_outcome_unknown");
  });
});

// 9 ────────────────────────────────────────────────────────────────────────────
test("an unreconciled commit_outcome_unknown from a previous run blocks the next attempt before BEGIN is ever sent", async () => {
  const pool = new FakePool();
  pool.control.priorEvents = [{
    migration_id: entries.transactional.id,
    run_id: "10000000-0000-4000-8000-000000000002",
    event_sequence: 2,
    event_type: "execution_failed",
    runner_id: identity.runnerId,
    heartbeat_deadline: null,
    source_git_sha: identity.sourceGitSha,
    executor_image_digest: identity.executorImageDigest,
    sqlstate: null,
    error_class: "commit_outcome_unknown",
    metadata: { execution_mode: "transactional", migration_filename: entries.transactional.filename, migration_ordinal: 1 },
    statement_ordinal: null,
  }];
  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
  const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
  assert.deepEqual(executionSql, [], "no BEGIN, no migration SQL, and no COMMIT are ever sent while the ambiguity is unreconciled");
  assert.deepEqual(pool.control.eventTypes(), [], "the guard throws before a fresh started event is ever recorded");
});

// Phase 2c CRITICAL C1 ───────────────────────────────────────────────────────
// The advisory lock is session-scoped, so a genuinely dead control session
// stops fencing replay immediately. The durable fence is therefore the ledger
// itself: a `started` row with no exactly-correlated terminal event under its
// own run_id blocks the next attempt before BEGIN. (The real-PostgreSQL half —
// a terminated backend, a released lock, and a concurrent second execution
// during in-flight marker persistence — is in
// migration-execute-commit-ambiguity.pg.test.ts.)

const abandonedStart = (overrides: Partial<PriorEventFixture> = {}): PriorEventFixture => ({
  event_id: 1,
  migration_id: entries.transactional.id,
  run_id: "10000000-0000-4000-8000-000000000042",
  event_sequence: 1,
  event_type: "started",
  runner_id: identity.runnerId,
  heartbeat_deadline: "2030-01-01T00:01:00.000Z",
  source_git_sha: identity.sourceGitSha,
  executor_image_digest: identity.executorImageDigest,
  sqlstate: null,
  error_class: null,
  metadata: {
    execution_mode: "transactional",
    migration_filename: entries.transactional.filename,
    migration_ordinal: 1,
    checksum_sha256: entries.transactional.sha256,
  },
  statement_ordinal: null,
  ...overrides,
});

test("C1: a started attempt with no terminal event blocks the next attempt before BEGIN", async () => {
  const pool = new FakePool();
  pool.control.priorEvents = [abandonedStart()];
  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
  const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
  assert.deepEqual(executionSql, [], "no BEGIN is ever sent while an earlier attempt's outcome is unaccounted for");
  assert.deepEqual(pool.control.eventTypes(), [], "and nothing is recorded for the refused attempt");
});

test("C1: only a terminal event under the started run's own run_id clears the in-flight fence", async () => {
  const started = abandonedStart();
  const other = "10000000-0000-4000-8000-000000000043";
  const terminal = (event_type: string, overrides: Partial<PriorEventFixture> = {}): PriorEventFixture =>
    ({ ...started, event_id: 2, event_sequence: 2, event_type, heartbeat_deadline: null, ...overrides });

  for (const [label, events] of [
    ["a heartbeat", [started, terminal("heartbeat", { heartbeat_deadline: "2030-01-01T00:02:00.000Z" })]],
    ["an operation_completed", [started, terminal("operation_completed")]],
    ["a succeeded belonging to a different run", [started, terminal("succeeded", { run_id: other })]],
    ["an execution_failed belonging to a different run", [started, terminal("execution_failed", { run_id: other, error_class: "sql_failed" })]],
    ["an execution_failed that is itself ambiguous", [started, terminal("execution_failed", { error_class: "commit_outcome_unknown" })]],
    // PB-10 Step 3 Phase 2c final review, PART 4: the *label* is not the
    // proof. Each of these carries an allowed terminal label with none of the
    // durable predecessor evidence the production writer emits alongside it.
    ["a succeeded with no applied_committed evidence", [started, terminal("succeeded")]],
    ["an execution_failed/sql_failed with no confirmed rollback", [started, terminal("execution_failed", { error_class: "sql_failed", sqlstate: "23505" })]],
    ["an execution_failed/wall_clock_exceeded with no confirmed rollback", [started, terminal("execution_failed", { error_class: "wall_clock_exceeded", sqlstate: "57014" })]],
    ["a rollback whose class disagrees with the failure it is offered as proof of", [
      started,
      terminal("transaction_rolled_back", { error_class: "wall_clock_exceeded", sqlstate: "57014" }),
      terminal("execution_failed", { event_id: 3, event_sequence: 3, error_class: "sql_failed", sqlstate: "57014" }),
    ]],
    ["a rollback whose sqlstate disagrees with the failure it is offered as proof of", [
      started,
      terminal("transaction_rolled_back", { error_class: "sql_failed", sqlstate: "40001" }),
      terminal("execution_failed", { event_id: 3, event_sequence: 3, error_class: "sql_failed", sqlstate: "23505" }),
    ]],
    // A batched completion verifier runs after batches have already committed
    // on their own transaction boundaries, so it proves nothing about what
    // landed and is never accepted as terminal proof.
    ["verification_failed", [started, terminal("verification_failed", { error_class: "verification_failed" })]],
  ] as Array<[string, PriorEventFixture[]]>) {
    const blocked = new FakePool();
    blocked.control.priorEvents = events;
    await assert.rejects(
      run(blocked, { manifest: manifestOf(entries.transactional) }),
      /commit_outcome_unknown/,
      `${label} must not clear the in-flight fence`,
    );
    assert.deepEqual(blocked.migrationSql(), [], `${label}: no migration SQL may run`);
  }

  // ── CRITICAL 1: fabricated predecessors, inserted by hand, prove nothing ──
  //
  // Each of these is a *perfectly* correlated pair — same run, same runner,
  // same build identity, same checksum, same error class, same SQLSTATE,
  // correct ordering — and each is exactly what one hand-written INSERT can
  // produce. None of them may clear the attempt, because none of them is
  // backed by the applied-ledger artifact or by PostgreSQL's own verdict on a
  // bound transaction.
  const fabrications: Array<[string, PriorEventFixture[], Record<string, string | null>]> = [
    ["applied_committed + succeeded with no committed applied row", [
      started,
      terminal("applied_committed"),
      terminal("succeeded", { event_id: 3, event_sequence: 3 }),
    ], {}],
    ["transaction_rolled_back + execution_failed with no transaction binding", [
      started,
      terminal("transaction_rolled_back", { error_class: "sql_failed", sqlstate: "23505" }),
      terminal("execution_failed", { event_id: 3, event_sequence: 3, error_class: "sql_failed", sqlstate: "23505" }),
    ], {}],
    ["a rollback pair whose bound transaction PostgreSQL says committed", [
      started,
      terminal("heartbeat", { event_id: 2, event_sequence: 2, xact_id: "8001" }),
      terminal("transaction_rolled_back", { event_id: 3, event_sequence: 3, error_class: "sql_failed", sqlstate: "23505" }),
      terminal("execution_failed", { event_id: 4, event_sequence: 4, error_class: "sql_failed", sqlstate: "23505" }),
    ], { 8001: "committed" }],
    ["a rollback pair whose bound transaction is still in progress", [
      started,
      terminal("heartbeat", { event_id: 2, event_sequence: 2, xact_id: "8002" }),
      terminal("transaction_rolled_back", { event_id: 3, event_sequence: 3, error_class: "sql_failed", sqlstate: "23505" }),
      terminal("execution_failed", { event_id: 4, event_sequence: 4, error_class: "sql_failed", sqlstate: "23505" }),
    ], { 8002: "in progress" }],
    ["a rollback pair whose binding PostgreSQL can no longer classify", [
      started,
      terminal("heartbeat", { event_id: 2, event_sequence: 2, xact_id: "8003" }),
      terminal("transaction_rolled_back", { event_id: 3, event_sequence: 3, error_class: "sql_failed", sqlstate: "23505" }),
      terminal("execution_failed", { event_id: 4, event_sequence: 4, error_class: "sql_failed", sqlstate: "23505" }),
    ], { 8003: null }],
    ["a binding forged after the rollback it claims to cover", [
      started,
      terminal("transaction_rolled_back", { event_id: 2, event_sequence: 2, error_class: "sql_failed", sqlstate: "23505" }),
      terminal("execution_failed", { event_id: 3, event_sequence: 3, error_class: "sql_failed", sqlstate: "23505" }),
      terminal("heartbeat", { event_id: 4, event_sequence: 4, xact_id: "8004" }),
    ], { 8004: "aborted" }],
    ["a second binding inserted alongside the genuine one", [
      started,
      terminal("heartbeat", { event_id: 2, event_sequence: 2, xact_id: "8005" }),
      terminal("heartbeat", { event_id: 3, event_sequence: 3, xact_id: "8006" }),
      terminal("transaction_rolled_back", { event_id: 4, event_sequence: 4, error_class: "sql_failed", sqlstate: "23505" }),
      terminal("execution_failed", { event_id: 5, event_sequence: 5, error_class: "sql_failed", sqlstate: "23505" }),
    ], { 8005: "aborted", 8006: "aborted" }],
  ];
  for (const [label, events, xactStatus] of fabrications) {
    const blocked = new FakePool();
    blocked.control.priorEvents = events;
    blocked.control.xactStatus = xactStatus;
    await assert.rejects(
      run(blocked, { manifest: manifestOf(entries.transactional) }),
      /commit_outcome_unknown/,
      `${label} must not clear the in-flight fence`,
    );
    assert.deepEqual(blocked.migrationSql(), [], `${label}: no migration SQL may run`);
  }

  // ── and the two genuine outcomes, which do clear ──────────────────────────
  const succeeded = new FakePool();
  succeeded.control.priorEvents = [
    started,
    terminal("applied_committed"),
    terminal("succeeded", { event_id: 3, event_sequence: 3 }),
  ];
  succeeded.control.artifacts = [artifactFor(entries.transactional, started.run_id)];
  assert.equal(
    (await run(succeeded, { manifest: manifestOf(entries.transactional) })).executedCount,
    1,
    "a success backed by the immutable applied-ledger row accounts for its attempt",
  );

  const rolledBack = new FakePool();
  rolledBack.control.priorEvents = [
    started,
    terminal("heartbeat", { event_id: 2, event_sequence: 2, xact_id: "8100" }),
    terminal("transaction_rolled_back", { event_id: 3, event_sequence: 3, error_class: "sql_failed", sqlstate: "23505" }),
    terminal("execution_failed", { event_id: 4, event_sequence: 4, error_class: "sql_failed", sqlstate: "23505" }),
  ];
  rolledBack.control.xactStatus = { 8100: "aborted" };
  assert.equal(
    (await run(rolledBack, { manifest: manifestOf(entries.transactional) })).executedCount,
    1,
    "a rollback PostgreSQL itself confirms aborted accounts for its attempt",
  );
});

test("CRITICAL 1: one real transaction outcome proves at most one attempt", async () => {
  const RUN_ONE = "10000000-0000-4000-8000-0000000000d1";
  const RUN_TWO = "10000000-0000-4000-8000-0000000000d2";
  const attempt = (run_id: string, base: number, xact_id: string): PriorEventFixture[] => [
    { ...abandonedStart({ run_id }), event_id: base + 1, event_sequence: 1 },
    { ...abandonedStart({ run_id }), event_id: base + 2, event_sequence: 2, event_type: "heartbeat", heartbeat_deadline: null, xact_id },
    { ...abandonedStart({ run_id }), event_id: base + 3, event_sequence: 3, event_type: "transaction_rolled_back", heartbeat_deadline: null, error_class: "sql_failed", sqlstate: "23505" },
    { ...abandonedStart({ run_id }), event_id: base + 4, event_sequence: 4, event_type: "execution_failed", heartbeat_deadline: null, error_class: "sql_failed", sqlstate: "23505" },
  ];

  // The same aborted transaction id copied onto a second attempt: neither
  // attempt may use it, because one COMMIT/ROLLBACK is one attempt's outcome.
  const reused = new FakePool();
  reused.control.priorEvents = [...attempt(RUN_ONE, 0, "8200"), ...attempt(RUN_TWO, 10, "8200")];
  reused.control.xactStatus = { 8200: "aborted" };
  await assert.rejects(
    run(reused, { manifest: manifestOf(entries.transactional) }),
    /2 previous attempt\(s\) block replay/,
    "a reused outcome proof clears neither attempt",
  );

  // Distinct genuine bindings clear both.
  const distinct = new FakePool();
  distinct.control.priorEvents = [...attempt(RUN_ONE, 0, "8201"), ...attempt(RUN_TWO, 10, "8202")];
  distinct.control.xactStatus = { 8201: "aborted", 8202: "aborted" };
  assert.equal((await run(distinct, { manifest: manifestOf(entries.transactional) })).executedCount, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// PB-10 Step 3 Phase 2c final review, CRITICAL 2: one canonical attempt
// identity and one correlation implementation for all four execution modes.
// ══════════════════════════════════════════════════════════════════════════

/** An armed `started` row for any mode, as RunLog now writes one. */
function armedFor(
  entry: MigrationManifestEntry,
  run_id: string,
  overrides: Partial<PriorEventFixture> = {},
  metadata: Record<string, unknown> = {},
): PriorEventFixture {
  return {
    event_id: 1,
    migration_id: entry.id,
    run_id,
    event_sequence: 1,
    event_type: "started",
    runner_id: identity.runnerId,
    heartbeat_deadline: "2030-01-01T00:01:00.000Z",
    source_git_sha: identity.sourceGitSha,
    executor_image_digest: identity.executorImageDigest,
    sqlstate: null,
    error_class: null,
    metadata: {
      execution_mode: entry.executionMode,
      migration_filename: entry.filename,
      migration_ordinal: 1,
      checksum_sha256: entry.sha256,
      ...metadata,
    },
    statement_ordinal: null,
    xact_id: null,
    ...overrides,
  };
}

const ALL_MODES = [entries.legacy, entries.transactional, entries.nontransactional, entries.batched];

/**
 * PB-10 Step 3 Phase 2c, H2: the two progress markers, as the executor commits
 * them — ordinary `heartbeat` rows carrying statement_ordinal 1 ("this
 * attempt's writer records progress") and 2 ("durable work was issued").
 */
function progressMarkerFor(
  entry: MigrationManifestEntry,
  run_id: string,
  ordinal: 1 | 2,
  overrides: Partial<PriorEventFixture> = {},
): PriorEventFixture {
  return {
    ...armedFor(entry, run_id),
    event_id: ordinal + 1,
    event_sequence: ordinal + 1,
    event_type: "heartbeat",
    heartbeat_deadline: null,
    statement_ordinal: ordinal,
    ...overrides,
  };
}

/** started + "writer records progress", with no durable work issued. */
const armedOnly = (entry: MigrationManifestEntry, run_id: string): PriorEventFixture[] =>
  [armedFor(entry, run_id), progressMarkerFor(entry, run_id, 1)];

/** started + both markers: the attempt reached durable work. */
const reachedDurableWork = (entry: MigrationManifestEntry, run_id: string): PriorEventFixture[] =>
  [...armedOnly(entry, run_id), progressMarkerFor(entry, run_id, 2)];

test("CRITICAL 2: all four execution modes are gated by the same canonical fence", async () => {
  for (const entry of ALL_MODES) {
    const pool = new FakePool();
    // H2: an attempt that got as far as issuing durable work. No mode has
    // authoritative evidence about what it left behind, so every mode's Stage 2
    // evaluator refuses and the central error is identical.
    pool.control.priorEvents = reachedDurableWork(entry, RUN_A);
    // The fence runs before mode-specific work of any kind — including the
    // unsupported-handler refusal nontransactional/batched would otherwise
    // reach, and including legacy-verbatim, which no longer has an evaluator
    // of its own.
    await assert.rejects(
      run(pool, { manifest: manifestOf(entry) }),
      /commit_outcome_unknown/,
      `${entry.executionMode} must block on the canonical fence`,
    );
    assert.deepEqual(pool.migrationSql(), [], `${entry.executionMode}: nothing may run`);
    assert.deepEqual(pool.control.events, [], `${entry.executionMode}: nothing may be recorded`);
  }
});

test("CRITICAL 2: a started row without a checksum is never a modern attempt, in any mode", async () => {
  for (const entry of ALL_MODES) {
    const armed = armedFor(entry, RUN_A);
    const withoutChecksum: PriorEventFixture = {
      ...armed,
      metadata: {
        execution_mode: entry.executionMode,
        migration_filename: entry.filename,
        migration_ordinal: 1,
      },
    };
    const pool = new FakePool();
    pool.control.priorEvents = [withoutChecksum];
    await assert.rejects(
      run(pool, { manifest: manifestOf(entry) }),
      /category=legacy_unprovable/,
      `${entry.executionMode}: a checksum-less armed row cannot be a complete modern attempt`,
    );
  }
});

test("CRITICAL 2: a later event that omits or contradicts the checksum cannot clear a modern attempt", async () => {
  const base = abandonedStart();
  const bound = { ...base, event_id: 2, event_sequence: 2, event_type: "heartbeat", heartbeat_deadline: null, xact_id: "8400" };
  const rollback = { ...base, event_id: 3, event_sequence: 3, event_type: "transaction_rolled_back", heartbeat_deadline: null, error_class: "sql_failed", sqlstate: "23505" };
  const failure = { ...base, event_id: 4, event_sequence: 4, event_type: "execution_failed", heartbeat_deadline: null, error_class: "sql_failed", sqlstate: "23505" };
  const withoutChecksum = { execution_mode: "transactional", migration_filename: entries.transactional.filename, migration_ordinal: 1 };
  const wrongChecksum = { ...withoutChecksum, checksum_sha256: "a".repeat(64) };

  for (const [label, events] of [
    ["the terminal omits it", [base, bound, rollback, { ...failure, metadata: withoutChecksum }]],
    ["the rollback predecessor omits it", [base, bound, { ...rollback, metadata: withoutChecksum }, failure]],
    ["the binding omits it", [base, { ...bound, metadata: withoutChecksum }, rollback, failure]],
    ["the terminal contradicts it", [base, bound, rollback, { ...failure, metadata: wrongChecksum }]],
    ["the binding contradicts it", [base, { ...bound, metadata: wrongChecksum }, rollback, failure]],
  ] as Array<[string, PriorEventFixture[]]>) {
    const pool = new FakePool();
    pool.control.priorEvents = events;
    pool.control.xactStatus = { 8400: "aborted" };
    await assert.rejects(
      run(pool, { manifest: manifestOf(entries.transactional) }),
      /commit_outcome_unknown/,
      `${label} must not clear`,
    );
  }
});

test("CRITICAL 2: batch identity is a within-attempt identifier and never resolves the attempt", async () => {
  const batchArmed = armedFor(entries.batched, RUN_A);
  const batchMetadata = (batch_number: unknown): Record<string, unknown> => ({
    execution_mode: "batched",
    migration_filename: entries.batched.filename,
    migration_ordinal: 1,
    checksum_sha256: entries.batched.sha256,
    batch_number,
  });

  for (const [label, events] of [
    // A `started` row may not claim a batch identity: batches begin after it.
    ["a started row carrying batch_number", [armedFor(entries.batched, RUN_A, {}, { batch_number: 1 })]],
    ["a batch event with a zero batch number", [batchArmed, { ...batchArmed, event_id: 2, event_sequence: 2, event_type: "operation_completed", heartbeat_deadline: null, metadata: batchMetadata(0) }]],
    ["a batch event with a fractional batch number", [batchArmed, { ...batchArmed, event_id: 2, event_sequence: 2, event_type: "operation_completed", heartbeat_deadline: null, metadata: batchMetadata(1.5) }]],
    ["a batch event with a non-numeric batch number", [batchArmed, { ...batchArmed, event_id: 2, event_sequence: 2, event_type: "operation_completed", heartbeat_deadline: null, metadata: batchMetadata("1") }]],
    // A batch's own rollback says nothing about batches that already committed.
    ["a per-batch rollback pair", [
      batchArmed,
      { ...batchArmed, event_id: 2, event_sequence: 2, event_type: "transaction_rolled_back", heartbeat_deadline: null, error_class: "sql_failed", sqlstate: "23505", metadata: batchMetadata(3) },
      { ...batchArmed, event_id: 3, event_sequence: 3, event_type: "execution_failed", heartbeat_deadline: null, error_class: "sql_failed", sqlstate: "23505", metadata: batchMetadata(3) },
    ]],
  ] as Array<[string, PriorEventFixture[]]>) {
    const pool = new FakePool();
    pool.control.priorEvents = events;
    await assert.rejects(
      run(pool, { manifest: manifestOf(entries.batched) }),
      /commit_outcome_unknown/,
      `${label} must not clear or resolve the attempt`,
    );
  }

  // batch_number belongs to batched mode alone.
  const foreign = new FakePool();
  foreign.control.priorEvents = [
    abandonedStart(),
    { ...abandonedStart(), event_id: 2, event_sequence: 2, event_type: "operation_completed", heartbeat_deadline: null, metadata: { execution_mode: "transactional", migration_filename: entries.transactional.filename, migration_ordinal: 1, checksum_sha256: entries.transactional.sha256, batch_number: 1 } },
  ];
  await assert.rejects(
    run(foreign, { manifest: manifestOf(entries.transactional) }),
    /commit_outcome_unknown/,
    "a batch identity on a non-batched attempt is malformed history",
  );
});

test("CRITICAL 1: an unreadable pg_xact_status fails closed rather than clearing", async () => {
  const started = abandonedStart();
  const pool = new FakePool();
  pool.control.priorEvents = [
    started,
    { ...started, event_id: 2, event_sequence: 2, event_type: "heartbeat", heartbeat_deadline: null, xact_id: "8300" },
    { ...started, event_id: 3, event_sequence: 3, event_type: "transaction_rolled_back", heartbeat_deadline: null, error_class: "sql_failed", sqlstate: "23505" },
    { ...started, event_id: 4, event_sequence: 4, event_type: "execution_failed", heartbeat_deadline: null, error_class: "sql_failed", sqlstate: "23505" },
  ];
  pool.control.xactStatus = "unavailable";
  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
  assert.deepEqual(pool.migrationSql(), []);
});

test("C1: an abandoned start is cleared only by an exactly correlated operator resolution", async () => {
  const started = abandonedStart();
  const resolution = (overrides: Record<string, unknown> = {}): PriorEventFixture => ({
    ...validResolution(),
    event_id: 2,
    metadata: {
      ...(validResolution().metadata as Record<string, unknown>),
      resolved_event_id: started.event_id,
      resolved_run_id: started.run_id,
      resolved_runner_id: started.runner_id,
      ...overrides,
    },
  });

  const wrong = new FakePool();
  wrong.control.priorEvents = [started, resolution({ resolved_run_id: "10000000-0000-4000-8000-000000000099" })];
  await assert.rejects(run(wrong, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);

  const exact = new FakePool();
  exact.control.priorEvents = [started, resolution()];
  const report = await run(exact, { manifest: manifestOf(entries.transactional) });
  assert.equal(report.executedCount, 1, "an exactly correlated stale_reclaimed row clears an abandoned start");
});

// Phase 2c blocker 5 ─────────────────────────────────────────────────────────
// assertNoUnresolvedCommitAmbiguity walks the *entire* history, not just the
// last row: only a strictly validated stale_reclaimed event for this exact
// migration/ordinal/filename/mode can clear an armed ambiguity, and every
// other later event type must leave the block standing.

/**
 * PB-10 Step 3 Phase 2c final review, PART 2: an ambiguity event without its
 * own exact `started` predecessor is malformed history, not an armed attempt,
 * so the armed fixture below is the real two-row history a run actually
 * writes. The attempt's immutable identity — and therefore the target a
 * resolution must name — is established by this `started` row.
 */
const ambiguousStart: PriorEventFixture = {
  event_id: 1,
  migration_id: entries.transactional.id,
  run_id: "10000000-0000-4000-8000-000000000002",
  event_sequence: 1,
  event_type: "started",
  runner_id: identity.runnerId,
  heartbeat_deadline: "2030-01-01T00:01:00.000Z",
  source_git_sha: identity.sourceGitSha,
  executor_image_digest: identity.executorImageDigest,
  sqlstate: null,
  error_class: null,
  metadata: {
    execution_mode: "transactional",
    migration_filename: entries.transactional.filename,
    migration_ordinal: 1,
    checksum_sha256: entries.transactional.sha256,
  },
  statement_ordinal: null,
};

const ambiguousEvent: PriorEventFixture = {
  event_id: 2,
  migration_id: entries.transactional.id,
  run_id: "10000000-0000-4000-8000-000000000002",
  event_sequence: 2,
  event_type: "execution_failed",
  runner_id: identity.runnerId,
  heartbeat_deadline: null,
  source_git_sha: identity.sourceGitSha,
  executor_image_digest: identity.executorImageDigest,
  sqlstate: null,
  error_class: "commit_outcome_unknown",
  metadata: {
    execution_mode: "transactional",
    migration_filename: entries.transactional.filename,
    migration_ordinal: 1,
    checksum_sha256: entries.transactional.sha256,
  },
  statement_ordinal: null,
};

/**
 * PB-10 Step 3 Phase 2c blocker 5: a valid resolution must exactly correlate
 * to the specific armed ambiguity through dedicated structured fields — the
 * same build identity that produced it (source SHA + image digest), and
 * exact-match resolved_event_id/resolved_run_id/resolved_checksum_sha256
 * fields naming it — never free-form text inside reclaim_reason, which
 * mr_metadata_ck itself restricts to a fixed operational-category enum and
 * therefore carries no identity information at all. Defaults here correlate
 * to `ambiguousEvent` above; tests exercising a mismatch override
 * source_git_sha/executor_image_digest/metadata directly.
 */
function validResolution(overrides: Partial<PriorEventFixture> = {}): PriorEventFixture {
  return {
    event_id: 3,
    migration_id: entries.transactional.id,
    run_id: "10000000-0000-4000-8000-000000000003",
    event_sequence: 1,
    event_type: "stale_reclaimed",
    runner_id: "pb10-operator-alice",
    heartbeat_deadline: null,
    source_git_sha: identity.sourceGitSha,
    executor_image_digest: identity.executorImageDigest,
    sqlstate: null,
    error_class: null,
    metadata: {
      execution_mode: "transactional",
      migration_filename: entries.transactional.filename,
      migration_ordinal: 1,
      reclaim_reason: "operator_approved",
      checksum_sha256: entries.transactional.sha256,
      resolved_event_id: ambiguousStart.event_id,
      resolved_run_id: ambiguousStart.run_id,
      resolved_runner_id: identity.runnerId,
      resolved_checksum_sha256: entries.transactional.sha256,
    },
    statement_ordinal: null,
    ...overrides,
  };
}

test("blocker 5: a valid stale_reclaimed event correctly clears the guard and lets the next attempt proceed", async () => {
  const pool = new FakePool();
  pool.control.priorEvents = [ambiguousStart, ambiguousEvent, validResolution()];
  const report = await run(pool, { manifest: manifestOf(entries.transactional) });
  assert.equal(report.executedCount, 1, "a correctly identified stale_reclaimed event clears the block");
});

const unrelatedLaterEvents: Array<[string, Partial<PriorEventFixture>]> = [
  ["a started event", { event_type: "started", heartbeat_deadline: "2030-01-01T00:01:00.000Z", error_class: null, sqlstate: null }],
  ["a heartbeat event", { event_type: "heartbeat", heartbeat_deadline: "2030-01-01T00:01:00.000Z", error_class: null, sqlstate: null }],
  ["an unrelated execution_failed event (different error class)", { event_type: "execution_failed", error_class: "sql_failed", sqlstate: "23505" }],
  ["an operation_completed event", { event_type: "operation_completed", error_class: null, sqlstate: null }],
  ["a stale_reclaimed event with a malformed run_id (not a UUID)", { event_type: "stale_reclaimed", run_id: "not-a-uuid" }],
  ["a malformed stale_reclaimed event (wrong migration_ordinal)", { metadata: { ...validResolution().metadata, migration_ordinal: 99 } }],
  ["a malformed stale_reclaimed event (wrong filename)", { metadata: { ...validResolution().metadata, migration_filename: "9999_other.sql" } }],
  ["a malformed stale_reclaimed event (wrong execution_mode)", { metadata: { ...validResolution().metadata, execution_mode: "batched" } }],
  ["a malformed stale_reclaimed event (missing reclaim_reason)", { metadata: { ...validResolution().metadata, reclaim_reason: undefined } }],
  ["a malformed stale_reclaimed event (empty reclaim_reason)", { metadata: { ...validResolution().metadata, reclaim_reason: "" } }],
  ["a malformed stale_reclaimed event (no runner_id/operator identity)", { runner_id: null }],
  ["a malformed stale_reclaimed event (placeholder source_git_sha)", { source_git_sha: "0000000" }],
  // PB-10 Step 3 Phase 2c blocker 5: a syntactically well-formed resolution
  // whose run id, source SHA, image digest or checksum simply doesn't match
  // the *armed* ambiguity must never clear it — "well-formed" is not
  // "correct", and none of these are substring/reorder tricks against
  // reclaim_reason (which no longer carries any identity at all).
  ["a stale_reclaimed event with a well-formed but unrelated source_git_sha", { source_git_sha: "1111111111111111111111111111111111111111" }],
  ["a stale_reclaimed event with a well-formed but unrelated executor_image_digest", { executor_image_digest: `sha256:${"1".repeat(64)}` }],
  ["a stale_reclaimed event whose resolved_run_id names the wrong run id (a fresh run id by itself is not enough)", { metadata: { ...validResolution().metadata, resolved_run_id: "10000000-0000-4000-8000-000000000099" } }],
  ["a stale_reclaimed event whose resolved_event_id names the wrong event id", { metadata: { ...validResolution().metadata, resolved_event_id: 999 } }],
  ["a stale_reclaimed event whose resolved_checksum_sha256 does not match the migration's checksum", { metadata: { ...validResolution().metadata, resolved_checksum_sha256: "1".repeat(64) } }],
  ["a stale_reclaimed event whose checksum_sha256 does not match the migration's checksum", { metadata: { ...validResolution().metadata, checksum_sha256: "1".repeat(64) } }],
  ["a stale_reclaimed event missing resolved_event_id entirely", { metadata: { ...validResolution().metadata, resolved_event_id: undefined } }],
  ["a stale_reclaimed event missing resolved_run_id entirely", { metadata: { ...validResolution().metadata, resolved_run_id: undefined } }],
  ["a stale_reclaimed event with a duplicated/extra unrecognised correlation field", { metadata: { ...validResolution().metadata, extra_correlation_field: ambiguousEvent.run_id } }],
  ["a stale_reclaimed event whose own run_id is a malformed UUID even though metadata otherwise matches", { run_id: "not-a-uuid-at-all" }],
];

for (const [label, overrides] of unrelatedLaterEvents) {
  test(`blocker 5: ${label} appended after an unresolved ambiguity never clears the guard`, async () => {
    const pool = new FakePool();
    pool.control.priorEvents = [ambiguousStart, ambiguousEvent, validResolution(overrides)];
    await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
    assert.deepEqual(pool.log.filter(({ client }) => client === "execution"), [], "execution must never begin while any unrelated later event is mistaken for a resolution");
  });
}

// PB-10 Step 3 Phase 2c final review, HIGH 3: Codex demonstrated that an
// adversarial *armed* event carrying the wrong checksum could still be
// cleared by a resolution that only matched the *current* migration, not
// what the armed event itself actually recorded. These prove the fix:
// isValidResolution now requires the armed event's own metadata to be
// well-formed and to match the current migration first (isWellFormedArmedEvent),
// and compares the resolution's resolved_checksum_sha256 against the armed
// event's own stored checksum_sha256 — never merely against the current
// migration's checksum in isolation.
test("blocker 5 (final review): an armed event whose own recorded checksum does not match the current migration can never be cleared, even by an otherwise-exact resolution", async () => {
  const pool = new FakePool();
  const wrongChecksumArmed: PriorEventFixture = {
    ...ambiguousEvent,
    metadata: { ...ambiguousEvent.metadata, checksum_sha256: "f".repeat(64) },
  };
  // A resolution naming the wrong-checksum armed event exactly (event id,
  // run id) and correctly matching the *current* migration's real checksum
  // — this must still fail, because the armed event's own checksum is
  // corrupt/wrong and can never be trusted as a valid identity to resolve.
  pool.control.priorEvents = [ambiguousStart, wrongChecksumArmed, validResolution()];
  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
  assert.deepEqual(pool.log.filter(({ client }) => client === "execution"), []);
});

test("blocker 5 (final review): a resolution whose resolved_checksum_sha256 matches the current migration but not the armed event's own recorded checksum is rejected", async () => {
  const pool = new FakePool();
  // The armed event itself is well-formed and matches the current
  // migration (checksum_sha256 === entries.transactional.sha256), but the
  // resolution's resolved_checksum_sha256 claims a *different* value that
  // also happens to be a syntactically valid sha256 — this is exactly the
  // "matches the current migration but not the armed event" trick the
  // release requirement calls out; the field must be compared against the
  // armed event's own stored checksum, not just accepted because it looks
  // like a real one.
  const misleadingResolution = validResolution({
    metadata: { ...validResolution().metadata, resolved_checksum_sha256: "a".repeat(64) },
  });
  pool.control.priorEvents = [ambiguousStart, ambiguousEvent, misleadingResolution];
  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
  assert.deepEqual(pool.log.filter(({ client }) => client === "execution"), []);
});

test("blocker 5 (final review): an armed event with an extra unrecognised metadata field is never well-formed enough to resolve", async () => {
  const pool = new FakePool();
  const pollutedArmed: PriorEventFixture = {
    ...ambiguousEvent,
    metadata: { ...ambiguousEvent.metadata, unexpected_field: "surprise" },
  };
  pool.control.priorEvents = [ambiguousStart, pollutedArmed, validResolution()];
  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
});

test("blocker 5 (final review): an armed event whose execution_mode does not match the current migration can never be cleared", async () => {
  const pool = new FakePool();
  const wrongModeArmed: PriorEventFixture = {
    ...ambiguousEvent,
    metadata: { ...ambiguousEvent.metadata, execution_mode: "batched" },
  };
  pool.control.priorEvents = [ambiguousStart, wrongModeArmed, validResolution()];
  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
});

test("blocker 5: a second, later ambiguity re-arms the guard even after an earlier one was validly resolved", async () => {
  const pool = new FakePool();
  const secondAmbiguity: PriorEventFixture = { ...ambiguousEvent, run_id: "10000000-0000-4000-8000-000000000004", event_sequence: 4 };
  pool.control.priorEvents = [ambiguousStart, ambiguousEvent, validResolution(), secondAmbiguity];
  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
});

// Phase 2c blocker 6 ─────────────────────────────────────────────────────────
// executeMigrations -> executeVerifiedMigrations -> execution client
// acquisition -> ambiguous COMMIT -> destructive release -> a delayed second
// socket/client error must never surface as an uncaught exception, an
// unhandled rejection, or an unintended pool-level "error" — and must never
// return the dead client to the pool for reuse.
test("blocker 6: a late second socket error after an ambiguous-COMMIT destructive release never becomes an uncaught exception", async () => {
  const uncaught: unknown[] = [];
  const onUncaughtException = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaughtException);
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    pool.execution.failCommit = new Error("connection reset by peer"); // no .code: non-authoritative
    pool.control.reconciliation = "absent";

    await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);

    assert.equal(pool.execution.releaseCount, 1, "exactly one destructive release");
    assert.ok(pool.execution.releasedWith, "the dead client is never returned for reuse");

    // pg-pool re-emits a raw socket-level failure discovered after release as
    // its own client-level 'error' event on the same client object; this is
    // exactly what production's execution.on("error", ...) guard exists for.
    pool.execution.emit("error", new Error("read ECONNRESET"));
    await new Promise((resolve) => setImmediate(resolve));
  });
  process.removeListener("uncaughtException", onUncaughtException);
  assert.deepEqual(uncaught, [], `no uncaught exception from a delayed second client error: ${String(uncaught[0])}`);
});

test("blocker 6: repeated ambiguous-COMMIT cycles never accumulate error listeners on the execution client", async () => {
  await withStrictUnhandledRejection(async () => {
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const pool = new FakePool();
      pool.execution.failCommit = new Error("connection reset by peer");
      pool.control.reconciliation = "absent";
      await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), /commit_outcome_unknown/);
      assert.ok(
        pool.execution.listenerCount("error") <= 1,
        `execution client must never accumulate more than its own single guard listener (cycle ${cycle}, got ${pool.execution.listenerCount("error")})`,
      );
    }
  });
});

// 11 ───────────────────────────────────────────────────────────────────────────
test("no later migration runs once an earlier one hits an unresolved ambiguous COMMIT", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    pool.execution.failCommit = new Error("connection reset by peer");
    pool.execution.connectionDiesOnCommit = true;
    pool.control.reconciliation = "absent";
    await assert.rejects(
      run(pool, { manifest: manifestOf(entries.transactional, entries.nontransactional) }),
      /commit_outcome_unknown/,
    );
    const ranSql = pool.migrationSql().map(({ sql }) => sql);
    assert.ok(!ranSql.some((sql) => sql.includes("create index concurrently")), "the second migration's SQL never runs once the first hits an unresolved ambiguity");
  });
});

// 9 ────────────────────────────────────────────────────────────────────────────
test("legacy-verbatim cancellation is never retryable and never claims rollback, confirmed or unverified", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    pool.execution.hangMigrationSql = true;
    const sleepController = controllableSleep();

    const pending = run(pool, { sleep: sleepController.sleep });
    await tickUntilFirstSleep(sleepController);
    sleepController.fire(0);
    await tick();
    pool.execution.settlePendingOperation(QUERY_CANCELED); // confirmed cancellation

    await assert.rejects(pending, /cancellation_unverified/);
    const executionSql = pool.log.filter(({ client }) => client === "execution").map(({ sql }) => sql);
    assert.ok(!executionSql.includes("rollback"), "the legacy payload's internal COMMIT boundary is opaque, so rollback is never claimed");
    assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "heartbeat", "execution_failed"]);
    assert.equal(pool.execution.releaseCount, 1);
    assert.ok(pool.execution.releasedWith);
  });
});

// 10 ───────────────────────────────────────────────────────────────────────────
test("legacy-verbatim unverified cancellation (pg_cancel_backend rejected) destroys the connection immediately", async () => {
  await withStrictUnhandledRejection(async () => {
    const pool = new FakePool();
    pool.execution.hangMigrationSql = true;
    pool.control.onCancel = () => { throw new Error("should not reach onCancel success path"); };
    // Make the control connection's cancel query fail outright.
    const originalQuery = pool.control.query.bind(pool.control);
    pool.control.query = async (sql: string, values?: unknown[]) => {
      if (sql.includes("pg_cancel_backend")) throw new Error("control connection unavailable");
      return originalQuery(sql, values);
    };
    const sleepController = controllableSleep();

    const pending = run(pool, { sleep: sleepController.sleep });
    await tickUntilFirstSleep(sleepController);
    sleepController.fire(0);

    await assert.rejects(pending, /cancellation_unverified/);
    assert.deepEqual(pool.control.eventTypes(), ["started", "heartbeat", "heartbeat", "execution_failed"]);
    assert.equal(pool.execution.releaseCount, 1);
    assert.ok(pool.execution.releasedWith);
  });
});

// 17 ───────────────────────────────────────────────────────────────────────────
test("wall-clock enforcement is independent of Date.now(): mocking Date.now backwards does not disturb the deadline", async () => {
  const pool = new FakePool();
  const nowMock = mock.method(Date, "now", () => 0); // frozen/backwards calendar clock
  try {
    const report = await run(pool, { manifest: manifestOf(entries.transactional) });
    assert.equal(report.executedCount, 1, "a frozen Date.now must not affect monotonic deadline enforcement");
  } finally {
    nowMock.mock.restore();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// PB-10 Step 3 Phase 2c final review — the history evaluator's design, not
// isolated special cases:
//
//   PART 1  one canonical immutable attempt identity, one correlation function
//   PART 2  strict per-run ordering and completeness (no gaps, no duplicates,
//           no event without its required predecessor)
//   PART 3  duplicate started rows are validated, never ignored
//   PART 4  terminal events must carry durable proof, not a trusted label
//   PART 5  manual resolution targets the original runner (resolved_runner_id)
//   PART 6  the current file's checksum is never proof of historical bytes
//   PART 7  complete-modern / legacy-provable / legacy-unprovable / malformed
// ══════════════════════════════════════════════════════════════════════════

const RUN_A = "10000000-0000-4000-8000-00000000000a";
const RUN_B = "10000000-0000-4000-8000-00000000000b";
const OPERATOR_RUN = "10000000-0000-4000-8000-0000000000c1";

/** A transactional-mode ledger row for the migration under test. */
function historyEvent(
  run_id: string,
  event_sequence: number,
  event_type: string,
  overrides: Partial<PriorEventFixture> = {},
): PriorEventFixture {
  return {
    event_id: 0, // replaced by historyOf below, so ids follow ledger order
    migration_id: entries.transactional.id,
    run_id,
    event_sequence,
    event_type,
    runner_id: identity.runnerId,
    heartbeat_deadline: event_type === "started" ? "2030-01-01T00:01:00.000Z" : null,
    source_git_sha: identity.sourceGitSha,
    executor_image_digest: identity.executorImageDigest,
    sqlstate: null,
    error_class: null,
    // CRITICAL 2: RunLog stamps checksum_sha256 on every event of every mode,
    // so every row of a modern attempt carries it and a row that omits it is
    // not a row of that attempt.
    metadata: {
      execution_mode: "transactional",
      migration_filename: entries.transactional.filename,
      migration_ordinal: 1,
      checksum_sha256: entries.transactional.sha256,
    },
    statement_ordinal: null,
    xact_id: null,
    ...overrides,
  };
}

/**
 * CRITICAL 1: the xid8 a bound attempt records, and PostgreSQL's verdict on it.
 * ABORTED_XID is the default binding used by provenRollback; historyPool reports
 * it as 'aborted' unless a test says otherwise.
 */
const ABORTED_XID = "7001";
const COMMITTED_XID = "7002";

const bindingOf = (run_id: string, sequence: number, xact_id: string = ABORTED_XID): PriorEventFixture =>
  historyEvent(run_id, sequence, "heartbeat", { xact_id });

/** Assigns ledger-order event ids, exactly as bigserial would. */
function historyOf(...events: PriorEventFixture[]): PriorEventFixture[] {
  return events.map((event, index) => ({ ...event, event_id: index + 1 }));
}

const startedOf = (run_id: string, sequence = 1): PriorEventFixture => historyEvent(run_id, sequence, "started");

const ambiguityOf = (run_id: string, sequence: number): PriorEventFixture =>
  historyEvent(run_id, sequence, "execution_failed", { error_class: "commit_outcome_unknown" });

/**
 * started -> transaction binding -> transaction_rolled_back -> execution_failed:
 * the only shape a rollback can clear through, and only when PostgreSQL itself
 * reports the bound transaction as aborted.
 */
const provenRollback = (
  run_id: string,
  errorClass = "sql_failed",
  sqlstate = "23505",
  xact_id: string = ABORTED_XID,
): PriorEventFixture[] => [
  startedOf(run_id),
  bindingOf(run_id, 2, xact_id),
  historyEvent(run_id, 3, "transaction_rolled_back", { error_class: errorClass, sqlstate }),
  historyEvent(run_id, 4, "execution_failed", { error_class: errorClass, sqlstate }),
];

/** started -> applied_committed -> succeeded, the proven-success shape. */
const provenSuccess = (run_id: string): PriorEventFixture[] => [
  startedOf(run_id),
  historyEvent(run_id, 2, "applied_committed"),
  historyEvent(run_id, 3, "succeeded", { metadata: {
    execution_mode: "transactional",
    migration_filename: entries.transactional.filename,
    migration_ordinal: 1,
    checksum_sha256: entries.transactional.sha256,
    duration_ms: 7,
  } }),
];

/**
 * CRITICAL 1: `succeeded` clears only alongside the immutable applied-ledger row
 * that COMMIT itself produced. (In production a migration with that row is not
 * pending at all, so this branch is defence in depth rather than a routine
 * path — which is exactly why a bare `succeeded` label must never clear.)
 */
const successArtifacts = (run_id: string): AppliedArtifactFixture[] =>
  [artifactFor(entries.transactional, run_id)];

/**
 * An exactly targeted operator resolution for one attempt, addressed by the
 * immutable identity its `started` row established — including
 * resolved_runner_id, the runner identity persisted on that attempt, which is
 * a different thing from the `runner_id` column naming the resolution's author.
 */
function resolutionFor(
  target: PriorEventFixture,
  sequence = 1,
  overrides: { metadata?: Record<string, unknown>; row?: Partial<PriorEventFixture> } = {},
): PriorEventFixture {
  return {
    event_id: 900 + sequence,
    migration_id: entries.transactional.id,
    run_id: OPERATOR_RUN,
    event_sequence: sequence,
    event_type: "stale_reclaimed",
    runner_id: "pb10-operator-alice",
    heartbeat_deadline: null,
    source_git_sha: identity.sourceGitSha,
    executor_image_digest: identity.executorImageDigest,
    sqlstate: null,
    error_class: null,
    metadata: {
      execution_mode: "transactional",
      migration_filename: entries.transactional.filename,
      migration_ordinal: 1,
      reclaim_reason: "heartbeat_expired",
      checksum_sha256: entries.transactional.sha256,
      resolved_event_id: target.event_id,
      resolved_run_id: target.run_id,
      resolved_runner_id: target.runner_id,
      resolved_checksum_sha256: entries.transactional.sha256,
      ...overrides.metadata,
    },
    statement_ordinal: null,
    ...overrides.row,
  };
}

type HistoryPool = {
  events: PriorEventFixture[];
  artifacts?: ControlClient["artifacts"];
  xactStatus?: ControlClient["xactStatus"];
};

const historyPool = (input: PriorEventFixture[] | HistoryPool): FakePool => {
  const pool = new FakePool();
  const { events, artifacts, xactStatus } = Array.isArray(input)
    ? { events: input, artifacts: undefined, xactStatus: undefined }
    : input;
  pool.control.priorEvents = events;
  if (artifacts !== undefined) pool.control.artifacts = artifacts;
  pool.control.xactStatus = xactStatus ?? { [ABORTED_XID]: "aborted", [COMMITTED_XID]: "committed" };
  return pool;
};

async function expectBlocked(input: PriorEventFixture[] | HistoryPool, why: string, category?: string): Promise<void> {
  const pool = historyPool(input);
  await assert.rejects(
    run(pool, { manifest: manifestOf(entries.transactional) }),
    (error: unknown) => {
      assert.ok(error instanceof Error, why);
      assert.match(error.message, /commit_outcome_unknown/, why);
      if (category) assert.match(error.message, new RegExp(`category=${category}`), `${why}: expected category=${category}, got ${error.message}`);
      // The diagnostic is machine-readable and carries no SQL, credentials or row values.
      assert.doesNotMatch(error.message, /password|select |insert |sup3rs3cr3t/i, "the diagnostic stays sanitized");
      return true;
    },
    why,
  );
  assert.deepEqual(pool.migrationSql(), [], `${why}: no migration SQL may run`);
  assert.deepEqual(pool.control.eventTypes(), [], `${why}: nothing is recorded for the refused attempt`);
}

async function expectClear(input: PriorEventFixture[] | HistoryPool, why: string): Promise<void> {
  const pool = historyPool(input);
  const report = await run(pool, { manifest: manifestOf(entries.transactional) });
  assert.equal(report.executedCount, 1, why);
}

// ── PART 2: history ordering and completeness ────────────────────────────

test("PART 2 (1): a sequence gap inside one attempt fails closed", async () => {
  await expectBlocked(
    [{ ...startedOf(RUN_A), event_id: 1 }, { ...historyEvent(RUN_A, 3, "applied_committed"), event_id: 2 }],
    "1 -> 3 is a missing event, not a valid ordering",
    "malformed_or_conflicting",
  );
  // …and the gap is not excused by a subsequent proof-carrying terminal.
  await expectBlocked(
    [
      { ...startedOf(RUN_A), event_id: 1 },
      { ...historyEvent(RUN_A, 3, "applied_committed"), event_id: 2 },
      { ...historyEvent(RUN_A, 4, "succeeded"), event_id: 3 },
    ],
    "a proof-carrying terminal cannot clear an unorderable attempt",
    "malformed_or_conflicting",
  );
});

test("PART 2 (2/3): a duplicate event_sequence fails closed whether or not its data agrees", async () => {
  for (const [label, duplicate] of [
    ["identical data", historyEvent(RUN_A, 1, "started")],
    ["conflicting data", historyEvent(RUN_A, 1, "started", { runner_id: "pb10-other-runner" })],
  ] as Array<[string, PriorEventFixture]>) {
    await expectBlocked(
      [{ ...startedOf(RUN_A), event_id: 1 }, { ...duplicate, event_id: 2 }],
      `a reused event_sequence with ${label} is outside the ledger's unique (run_id, event_sequence) contract`,
      "malformed_or_conflicting",
    );
  }
});

test("PART 2 (4): a decreasing event_sequence fails closed", async () => {
  await expectBlocked(
    [{ ...startedOf(RUN_A, 2), event_id: 1 }, { ...historyEvent(RUN_A, 1, "applied_committed"), event_id: 2 }],
    "sequences never decrease within a run",
    "malformed_or_conflicting",
  );
});

test("PART 2 (5/6): a terminal or ambiguity event with no started predecessor fails closed", async () => {
  for (const [label, orphan] of [
    ["succeeded", historyEvent(RUN_A, 1, "succeeded")],
    ["applied_committed", historyEvent(RUN_A, 1, "applied_committed")],
    ["execution_failed/sql_failed", historyEvent(RUN_A, 1, "execution_failed", { error_class: "sql_failed", sqlstate: "23505" })],
    ["commit_outcome_unknown", ambiguityOf(RUN_A, 1)],
    ["transaction_rolled_back", historyEvent(RUN_A, 1, "transaction_rolled_back", { error_class: "sql_failed", sqlstate: "23505" })],
  ] as Array<[string, PriorEventFixture]>) {
    await expectBlocked(historyOf(orphan), `an ${label} with no started predecessor is malformed history`, "malformed_or_conflicting");
  }
});

test("PART 2: a run's sequence is per-run, not per-migration — interleaved migrations are a valid ordering", async () => {
  // One executeMigrations(pool) invocation shares one run id across every
  // migration it touches, so this migration's own rows legitimately carry
  // non-contiguous sequences. The evaluator must accept the run's *whole*
  // stream, and this history is fully accounted for.
  const other = (sequence: number, event_type: string, extra: Partial<PriorEventFixture> = {}): PriorEventFixture => ({
    ...historyEvent(RUN_A, sequence, event_type, extra),
    migration_id: entries.nontransactional.id,
    metadata: {
      execution_mode: "nontransactional",
      migration_filename: entries.nontransactional.filename,
      migration_ordinal: 2,
    },
  });
  await expectClear(
    {
      events: historyOf(
        other(1, "started"),
        other(2, "operation_completed"),
        other(3, "succeeded"),
        startedOf(RUN_A, 4),
        historyEvent(RUN_A, 5, "applied_committed"),
        historyEvent(RUN_A, 6, "succeeded"),
      ),
      artifacts: successArtifacts(RUN_A),
    },
    "an interleaved but gapless run stream is a valid, fully accounted-for history",
  );
});

// ── PART 3: conflicting duplicate started rows ───────────────────────────

test("PART 3 (7-11): a duplicate started row with any conflicting immutable field fails closed", async () => {
  const conflicts: Array<[string, Partial<PriorEventFixture>]> = [
    ["checksum", { metadata: { execution_mode: "transactional", migration_filename: entries.transactional.filename, migration_ordinal: 1, checksum_sha256: "a".repeat(64) } }],
    ["runner_id", { runner_id: "pb10-other-runner" }],
    ["execution mode", { metadata: { execution_mode: "batched", migration_filename: entries.transactional.filename, migration_ordinal: 1, checksum_sha256: entries.transactional.sha256 } }],
    ["migration ordinal", { metadata: { execution_mode: "transactional", migration_filename: entries.transactional.filename, migration_ordinal: 9, checksum_sha256: entries.transactional.sha256 } }],
    ["filename", { metadata: { execution_mode: "transactional", migration_filename: "9999_other.sql", migration_ordinal: 1, checksum_sha256: entries.transactional.sha256 } }],
    ["source_git_sha", { source_git_sha: "1".repeat(40) }],
    ["executor_image_digest", { executor_image_digest: `sha256:${"1".repeat(64)}` }],
    ["batch identity", { metadata: { execution_mode: "transactional", migration_filename: entries.transactional.filename, migration_ordinal: 1, checksum_sha256: entries.transactional.sha256, batch_number: 4 } }],
  ];
  for (const [label, overrides] of conflicts) {
    // The conflicting duplicate is refused even when followed by an
    // otherwise-perfect proof-carrying terminal for the same run.
    await expectBlocked(
      historyOf(
        startedOf(RUN_A),
        historyEvent(RUN_A, 2, "started", overrides),
        historyEvent(RUN_A, 3, "applied_committed"),
        historyEvent(RUN_A, 4, "succeeded"),
      ),
      `a duplicate started row differing in ${label} is conflicting history`,
      "malformed_or_conflicting",
    );
    // …and no operator resolution can clear a malformed attempt either.
    const started = historyOf(startedOf(RUN_A), historyEvent(RUN_A, 2, "started", overrides));
    await expectBlocked(
      [...started, resolutionFor(started[0])],
      `a resolution never clears an attempt whose ${label} history conflicts`,
      "malformed_or_conflicting",
    );
  }
});

// ── PART 4: proof-carrying terminal events ───────────────────────────────

test("PART 4 (12/13/14): an allowed terminal label with no durable predecessor evidence stays blocking", async () => {
  for (const errorClass of ["sql_failed", "wall_clock_exceeded", "verification_failed", "verifier_state_invalid", "unsupported_handler"]) {
    await expectBlocked(
      historyOf(startedOf(RUN_A), historyEvent(RUN_A, 2, "execution_failed", { error_class: errorClass, sqlstate: "23505" })),
      `execution_failed/${errorClass} inserted without its rollback evidence proves nothing`,
      "complete_modern",
    );
  }
  await expectBlocked(
    historyOf(startedOf(RUN_A), historyEvent(RUN_A, 2, "succeeded")),
    "a succeeded with no applied_committed evidence proves nothing",
    "complete_modern",
  );
});

test("PART 4 (15): exact confirmed rollback evidence clears only the correlated attempt", async () => {
  await expectClear(historyOf(...provenRollback(RUN_A)), "a proven rollback accounts for its own attempt");
  await expectClear(
    { events: historyOf(...provenSuccess(RUN_A)), artifacts: successArtifacts(RUN_A) },
    "a proven success accounts for its own attempt",
  );
  // Run B's proven rollback says nothing about run A.
  await expectBlocked(
    historyOf(startedOf(RUN_A), ...provenRollback(RUN_B)),
    "run B's proof clears run B only",
    "complete_modern",
  );
});

test("PART 4 (16/17/18): uncertain outcomes stay blocking however they are labelled", async () => {
  for (const errorClass of ["cancellation_unverified", "control_connection_lost", "ledger_insert_failed", "rollback_failed", "checksum_drift", "run_budget_exceeded", null]) {
    // Even *with* a rollback row carrying the same class: these classes are
    // never rollback-provable, so the pairing is not proof.
    await expectBlocked(
      historyOf(
        startedOf(RUN_A),
        historyEvent(RUN_A, 2, "transaction_rolled_back", { error_class: errorClass, sqlstate: "57014" }),
        historyEvent(RUN_A, 3, "execution_failed", { error_class: errorClass, sqlstate: "57014" }),
      ),
      `error_class=${String(errorClass)} is never an authoritative non-commit proof`,
      "complete_modern",
    );
  }
  await expectBlocked(
    historyOf(startedOf(RUN_A), ambiguityOf(RUN_A, 2)),
    "commit_outcome_unknown always blocks",
    "complete_modern",
  );
  // A commit_outcome_unknown strengthens the attempt: a later proof-carrying
  // terminal for the same run can no longer clear it.
  await expectBlocked(
    historyOf(
      startedOf(RUN_A),
      ambiguityOf(RUN_A, 2),
      historyEvent(RUN_A, 3, "transaction_rolled_back", { error_class: "sql_failed", sqlstate: "23505" }),
      historyEvent(RUN_A, 4, "execution_failed", { error_class: "sql_failed", sqlstate: "23505" }),
    ),
    "an ambiguous attempt is past the point any terminal event can speak for it",
    "complete_modern",
  );
});

test("PART 4 (19/20): a terminal event that contradicts the attempt's identity clears nothing", async () => {
  const contradictions: Array<[string, Partial<PriorEventFixture>]> = [
    ["checksum", { metadata: { execution_mode: "transactional", migration_filename: entries.transactional.filename, migration_ordinal: 1, checksum_sha256: "a".repeat(64) } }],
    ["runner id", { runner_id: "pb10-other-runner" }],
    ["source_git_sha", { source_git_sha: "1".repeat(40) }],
    ["executor_image_digest", { executor_image_digest: `sha256:${"1".repeat(64)}` }],
    ["execution mode", { metadata: { execution_mode: "batched", migration_filename: entries.transactional.filename, migration_ordinal: 1, checksum_sha256: entries.transactional.sha256 } }],
    ["filename", { metadata: { execution_mode: "transactional", migration_filename: "9999_other.sql", migration_ordinal: 1, checksum_sha256: entries.transactional.sha256 } }],
  ];
  for (const [label, overrides] of contradictions) {
    await expectBlocked(
      historyOf(
        startedOf(RUN_A),
        historyEvent(RUN_A, 2, "transaction_rolled_back", { error_class: "sql_failed", sqlstate: "23505", ...overrides }),
        historyEvent(RUN_A, 3, "execution_failed", { error_class: "sql_failed", sqlstate: "23505" }),
      ),
      `rollback evidence with a different ${label} does not belong to this attempt`,
      "malformed_or_conflicting",
    );
  }
});

// ── C1 regressions that must stay fixed: independent attempts ────────────

test("C1: distinct valid run ids are tracked independently and a newer success hides nothing", async () => {
  await expectBlocked(
    historyOf(startedOf(RUN_A), ...provenSuccess(RUN_B)),
    "run A remains blocking even though run B provably succeeded afterwards",
    "complete_modern",
  );
  await expectBlocked(
    historyOf(startedOf(RUN_A), ambiguityOf(RUN_A, 2), ...provenSuccess(RUN_B)),
    "run A's ambiguity remains blocking",
    "complete_modern",
  );
  const twoAttempts = historyPool(historyOf(startedOf(RUN_A), startedOf(RUN_B)));
  await assert.rejects(
    run(twoAttempts, { manifest: manifestOf(entries.transactional) }),
    /2 previous attempt\(s\) block replay/,
    "both attempts are counted, never collapsed into one armed slot",
  );
  await expectClear(
    {
      events: historyOf(
        startedOf(RUN_A),
        ...provenSuccess(RUN_B),
        bindingOf(RUN_A, 2),
        historyEvent(RUN_A, 3, "transaction_rolled_back", { error_class: "sql_failed", sqlstate: "23505" }),
        historyEvent(RUN_A, 4, "execution_failed", { error_class: "sql_failed", sqlstate: "23505" }),
      ),
      artifacts: successArtifacts(RUN_B),
    },
    "replay proceeds only once every attempt has its own proof",
  );
});

// ── PART 5: manual resolution targets the original runner ────────────────

test("PART 5 (21/22/23/24): resolution correlates against the target attempt's own runner identity", async () => {
  const [started] = historyOf(startedOf(RUN_A));
  const history = [started];

  await expectClear([...history, resolutionFor(started)], "an exactly targeted resolution succeeds");

  for (const [label, metadata] of [
    ["a wrong target runner id", { resolved_runner_id: "pb10-other-runner" }],
    ["no target runner id at all", { resolved_runner_id: undefined }],
    ["a target runner id copied from the resolution's own author", { resolved_runner_id: "pb10-operator-alice" }],
    ["a wrong target event id", { resolved_event_id: 99 }],
    ["a wrong target run id", { resolved_run_id: RUN_B }],
    ["a wrong target checksum", { resolved_checksum_sha256: "a".repeat(64) }],
    ["a wrong migration filename", { migration_filename: "9999_other.sql" }],
    ["a wrong migration ordinal", { migration_ordinal: 9 }],
    ["a wrong execution mode", { execution_mode: "batched" }],
    ["no reclaim_reason", { reclaim_reason: undefined }],
    ["an unrecognised extra correlation field", { operation_category: "schema" }],
  ] as Array<[string, Record<string, unknown>]>) {
    await expectBlocked([...history, resolutionFor(started, 1, { metadata })], `a resolution with ${label} is rejected`);
  }

  for (const [label, row] of [
    ["no author identity", { runner_id: null }],
    ["a malformed author identity", { runner_id: "not a runner id!" }],
    ["an unrelated build identity", { source_git_sha: "1".repeat(40) }],
    ["a malformed own run id", { run_id: "not-a-uuid" }],
  ] as Array<[string, Partial<PriorEventFixture>]>) {
    await expectBlocked([...history, resolutionFor(started, 1, { row })], `a resolution with ${label} is rejected`);
  }

  // The author's own runner id is deliberately free to differ from the
  // target's: it identifies who acted, and never participates in correlation.
  await expectClear(
    [...history, resolutionFor(started, 1, { row: { runner_id: "pb10-operator-bob" } })],
    "a different, valid author identity does not affect target correlation",
  );
});

test("PART 5 (25): one resolution clears exactly one attempt", async () => {
  const history = historyOf(startedOf(RUN_A), ambiguityOf(RUN_A, 2), startedOf(RUN_B));
  const [startedA, , startedB] = history;

  await expectBlocked([...history, resolutionFor(startedA, 1)], "run B stays blocked");
  await expectBlocked([...history, resolutionFor(startedB, 1)], "run A stays blocked");
  await expectClear(
    [...history, resolutionFor(startedA, 1), resolutionFor(startedB, 2)],
    "each armed attempt needs its own exact resolution",
  );
  // A single resolution row can never account for two attempts, even when
  // both attempts are otherwise identical in every field it names.
  await expectBlocked(
    [...historyOf(startedOf(RUN_A), startedOf(RUN_B)), resolutionFor(historyOf(startedOf(RUN_A))[0], 1)],
    "one row, one attempt",
  );
});

test("PART 5: a resolution never reaches another migration with similar metadata", async () => {
  const [started] = historyOf(startedOf(RUN_A));
  const foreign = resolutionFor(started, 1, { row: { migration_id: entries.batched.id } });
  await expectBlocked([started, foreign], "a resolution recorded against another migration id clears nothing");
});

// ── PART 6/7: historical bytes are never assumed ─────────────────────────

const legacyStart = (overrides: Partial<PriorEventFixture> = {}): PriorEventFixture => ({
  ...startedOf(RUN_A),
  event_id: 1,
  metadata: {
    execution_mode: "transactional",
    migration_filename: entries.transactional.filename,
    migration_ordinal: 1,
  },
  ...overrides,
});

test("PART 6 (26/27/29): a historical attempt with no checksum is never resolved with the current file's checksum", async () => {
  const armed = legacyStart();
  await expectBlocked([armed], "a legacy attempt with unprovable bytes blocks replay", "legacy_unprovable");
  await expectBlocked(
    [armed, resolutionFor(armed)],
    "the current migration file's checksum is not evidence of what the historical run executed",
    "legacy_unprovable",
  );
  // Nor with any other syntactically valid checksum an operator might supply.
  await expectBlocked(
    [armed, resolutionFor(armed, 1, { metadata: { checksum_sha256: "a".repeat(64), resolved_checksum_sha256: "a".repeat(64) } })],
    "an operator-asserted checksum is not historical evidence either",
    "legacy_unprovable",
  );
});

test("HIGH 1 (28): only the immutable applied-ledger artifact proves historical bytes", async () => {
  // A checksum on a later ledger event is exactly what an untrusted writer can
  // insert, so it is no longer a proof source at all — correlation makes a row
  // *addressed to* an attempt, never *provenance for* it.
  const persistedOnEvent = historyOf(
    legacyStart(),
    historyEvent(RUN_A, 2, "execution_failed", { error_class: "commit_outcome_unknown" }),
  );
  await expectBlocked(persistedOnEvent, "the ambiguity requires an operator resolution", "legacy_unprovable");
  await expectBlocked(
    [...persistedOnEvent, resolutionFor(persistedOnEvent[0])],
    "a checksum carried by a later event never becomes proof of historical bytes",
    "legacy_unprovable",
  );

  // The committed applied-ledger row for that exact run is the one accepted
  // artifact: immutable (INSERT-only, mutation- and truncate-proof), already
  // persisted, and produced by the historical attempt's own committed operation.
  const artifactHistory = historyOf(legacyStart());
  await expectClear(
    {
      events: [...artifactHistory, resolutionFor(artifactHistory[0])],
      artifacts: [artifactFor(entries.transactional, RUN_A)],
    },
    "the immutable applied-ledger artifact proves the historical bytes",
  );
});

test("HIGH 1: an artifact whose provenance is not this attempt's proves nothing", async () => {
  const history = historyOf(legacyStart());
  const cases: Array<[string, Partial<AppliedArtifactFixture>]> = [
    ["another run id", { run_id: RUN_B }],
    ["another ordinal", { ordinal: 2 }],
    ["another filename", { filename: entries.nontransactional.filename }],
    ["another execution mode", { execution_mode: "nontransactional" }],
    ["another source git sha", { source_git_sha: "b".repeat(40) }],
    ["another executor image digest", { executor_image_digest: `sha256:${"b".repeat(64)}` }],
    ["a baselined row with no applied checksum", { applied_checksum_sha256: null }],
  ];
  for (const [label, overrides] of cases) {
    await expectBlocked(
      {
        events: [...history, resolutionFor(history[0])],
        artifacts: [artifactFor(entries.transactional, RUN_A, overrides)],
      },
      `an artifact with ${label} is not this attempt's provenance`,
    );
  }
});

test("HIGH 1 (30): contradictory or duplicated historical evidence fails closed", async () => {
  const history = historyOf(legacyStart());
  // More than one applied row for this migration: ambiguous evidence is not
  // evidence, whichever of them would have "matched".
  await expectBlocked(
    {
      events: [...history, resolutionFor(history[0])],
      artifacts: [
        artifactFor(entries.transactional, RUN_A),
        artifactFor(entries.transactional, RUN_A, { applied_checksum_sha256: "a".repeat(64) }),
      ],
    },
    "two candidate artifacts cannot prove one checksum",
    "malformed_or_conflicting",
  );
  // An unreadable artifact source never becomes proof.
  await expectBlocked(
    { events: [...history, resolutionFor(history[0])], artifacts: "unavailable" },
    "evidence that cannot be read is not evidence",
    "legacy_unprovable",
  );
});

test("PART 7: a historical attempt with no runner identity is legacy-unprovable, not resolvable", async () => {
  const armed = legacyStart({
    runner_id: null,
    metadata: {
      execution_mode: "transactional",
      migration_filename: entries.transactional.filename,
      migration_ordinal: 1,
      checksum_sha256: entries.transactional.sha256,
    },
  });
  await expectBlocked([armed], "no artifact can prove a runner identity that was never written", "legacy_unprovable");
  await expectBlocked(
    [armed, resolutionFor(armed, 1, { metadata: { resolved_runner_id: undefined } })],
    "a resolution that omits the target runner identity is refused",
    "legacy_unprovable",
  );
  // Its own proof-carrying terminal still accounts for it: normal execution
  // history is unaffected by the manual-recovery restriction.
  await expectClear(
    historyOf(
      armed,
      bindingOf(RUN_A, 2),
      historyEvent(RUN_A, 3, "transaction_rolled_back", { error_class: "sql_failed", sqlstate: "23505", runner_id: null }),
      historyEvent(RUN_A, 4, "execution_failed", { error_class: "sql_failed", sqlstate: "23505", runner_id: null }),
    ).map((event) => (event.event_type === "heartbeat" ? { ...event, runner_id: null } : event)),
    "a legacy attempt's own bound-and-aborted rollback still clears it",
  );
});

test("PART 7: a started row that cannot establish an identity is armed and never clearable", async () => {
  for (const [label, malformed] of [
    ["a run id that is not a UUID", legacyStart({ run_id: "not-a-uuid" })],
    ["metadata that is not an object", legacyStart({ metadata: "corrupt" })],
    ["metadata missing the filename", legacyStart({ metadata: { execution_mode: "transactional", migration_ordinal: 1 } })],
    ["a checksum that disagrees with the current migration", legacyStart({ metadata: { execution_mode: "transactional", migration_filename: entries.transactional.filename, migration_ordinal: 1, checksum_sha256: "a".repeat(64) } })],
    ["a malformed runner id", legacyStart({ runner_id: "not a runner id!" })],
    ["a placeholder source_git_sha", legacyStart({ source_git_sha: "0".repeat(40) })],
    ["an unrecognised metadata key", legacyStart({ metadata: { execution_mode: "transactional", migration_filename: entries.transactional.filename, migration_ordinal: 1, checksum_sha256: entries.transactional.sha256, verification: "passed" } })],
  ] as Array<[string, PriorEventFixture]>) {
    await expectBlocked([malformed], `${label} fails closed`, "malformed_or_conflicting");
    await expectBlocked([malformed, resolutionFor(malformed)], `${label} is not resolvable`, "malformed_or_conflicting");
  }
});

test("PART 7: the blocked-attempt diagnostic names every unresolved attempt, its event id and its category", async () => {
  const pool = historyPool([
    ...historyOf(startedOf(RUN_A), ambiguityOf(RUN_A, 2)),
    { ...legacyStart({ run_id: RUN_B }), event_id: 3 },
  ]);
  await assert.rejects(run(pool, { manifest: manifestOf(entries.transactional) }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /2 previous attempt\(s\) block replay/);
    assert.match(error.message, /event_id=1 run_id=10000000-0000-4000-8000-00000000000a category=complete_modern reason=commit_outcome_unknown/);
    assert.match(error.message, /event_id=3 run_id=10000000-0000-4000-8000-00000000000b category=legacy_unprovable/);
    assert.doesNotMatch(error.message, /sup3rs3cr3t|password/i);
    return true;
  });
});

// ── H3: the documented default configuration stays recoverable ───────────

const defaultConfigIdentity = { ...identity, runnerId: null };

test("H3: with MIGRATION_RUNNER_ID unset, a new attempt still records everything exact recovery needs", async () => {
  const pool = new FakePool();
  await run(pool, { manifest: manifestOf(entries.transactional), identity: defaultConfigIdentity });
  const started = pool.control.events.find(({ type }) => type === "started");
  assert.ok(started, "the attempt recorded a started event");
  const runnerId = String(started.values[4]);
  assert.match(runnerId, /^pb10-runner-[0-9a-f]{32}$/, "runner_id is generated, non-null and well-formed");
  assert.notEqual(runnerId, started.values[0], "the generated runner id is never the run id");
  const metadata = JSON.parse(String(started.values[10])) as Record<string, unknown>;
  assert.equal(metadata.checksum_sha256, entries.transactional.sha256, "the checksum recovery correlates against is persisted");
});

test("H3: a crash after started is recoverable from the ledger's own durable values", async () => {
  const crashed = new FakePool();
  crashed.execution.failMigrationSql = new Error("backend terminated");
  await assert.rejects(run(crashed, { manifest: manifestOf(entries.transactional), identity: defaultConfigIdentity }));
  const started = crashed.control.events.find(({ type }) => type === "started")!;
  const recordedRunner = String(started.values[4]);

  // Exactly what an operator reads back out of migration_control.migration_runs.
  const armed = { ...startedOf(RUN_A), event_id: 1, runner_id: recordedRunner };
  await expectClear([armed, resolutionFor(armed)], "exact recovery succeeds under the documented default configuration");
  await expectBlocked(
    [armed, resolutionFor(armed, 1, { metadata: { resolved_runner_id: "pb10-runner-00000000000000000000000000000000" } })],
    "a wrong target runner id is rejected even when every other field is exact",
  );
});

test("H3: db/README.md's documented recovery example matches the runtime validation exactly", async () => {
  const readme = readFileSync(path.resolve(__dirname, "../../db/README.md"), "utf8");
  const section = readme.slice(readme.indexOf("### Unresolved attempts and manual recovery"));
  assert.ok(section.length > 0, "the recovery procedure is documented");
  assert.doesNotMatch(section, /never invents identity/, "the obsolete claim is gone");

  // The documented resolution metadata key set is exactly what the runtime accepts.
  const documentedKeys = [...section.matchAll(/^\s*'([a-z0-9_]+)',/gm)].map(([, key]) => key);
  const exampleKeys = documentedKeys.slice(documentedKeys.indexOf("execution_mode"));
  assert.ok(exampleKeys.includes("resolved_runner_id"), "resolved_runner_id is documented");
  const [started] = historyOf(startedOf(RUN_A));
  const documented: PriorEventFixture = {
    ...resolutionFor(started),
    metadata: Object.fromEntries(exampleKeys.map((key) => [key, ({
      execution_mode: entries.transactional.executionMode,
      migration_filename: entries.transactional.filename,
      migration_ordinal: 1,
      reclaim_reason: "heartbeat_expired",
      checksum_sha256: entries.transactional.sha256,
      resolved_event_id: started.event_id,
      resolved_run_id: started.run_id,
      resolved_runner_id: started.runner_id,
      resolved_checksum_sha256: entries.transactional.sha256,
    } as Record<string, unknown>)[key]])),
  };
  await expectClear([started, documented], "a resolution built from the documented example clears exactly its target");

  for (const reason of ["heartbeat_expired", "connection_lost", "operator_approved"]) {
    assert.ok(section.includes(reason), `${reason} is documented`);
    await expectClear(
      [started, { ...documented, metadata: { ...(documented.metadata as Record<string, unknown>), reclaim_reason: reason } }],
      `the documented reclaim_reason ${reason} is accepted`,
    );
  }

  // The documented recovery query exposes every identifier correlation needs.
  for (const column of ["event_id", "run_id", "runner_id", "source_git_sha", "executor_image_digest", "checksum_sha256"]) {
    assert.ok(section.includes(column), `the documented recovery query surfaces ${column}`);
  }

  // The documented evidence rules are the implemented ones.
  for (const documentedClaim of [
    "transaction_rolled_back",
    "applied_committed",
    "legacy_unprovable",
    "legacy_provable",
    "complete_modern",
    "malformed_or_conflicting",
  ]) {
    assert.ok(section.includes(documentedClaim), `${documentedClaim} is documented`);
  }
  // The deleted modules may only be named to state that they no longer
  // exist — never as a path a reader could import or a test could target.
  assert.doesNotMatch(readme, /migrate\/(batched|supervision|execution-context)\.ts/, "no deleted module is referenced as a path");
  assert.doesNotMatch(readme, /migration-batched\.test\.ts|migration-execute-supervision\.test\.ts/, "no deleted test file is referenced");
  assert.match(readme, /there is no `batched\.ts`, `execution-context\.ts` or `supervision\.ts`/, "their absence is stated explicitly");

  const [, documentedShape] = /`pb10-runner-<(\d+) hex>`/.exec(readme) ?? [];
  const pool = new FakePool();
  await run(pool, { manifest: manifestOf(entries.transactional), identity: defaultConfigIdentity });
  const startedEvent = pool.control.events.find(({ type }) => type === "started")!;
  assert.match(String(startedEvent.values[4]), new RegExp(`^pb10-runner-[0-9a-f]{${documentedShape}}$`), "the generated runner id matches the documented shape");
});

// ══════════════════════════════════════════════════════════════════════════
// PB-10 Step 3 Phase 2c, HIGH 2 — mode-specific safe recovery.
//
// Stage 1 (the central safety gate) still owns every structural invariant and
// is the only thing that may block. Stage 2 (the four mode evaluators) is the
// only thing that may permit a replay, and only for a history Stage 1 marked
// eligible. These regressions pin both halves and, crucially, the boundary
// between them: a malformed, ambiguous or active history is never handed to a
// mode evaluator at all.
// ══════════════════════════════════════════════════════════════════════════

const H2_RUN = "10000000-0000-4000-8000-00000000f001";

/** A verifier that records whether it was consulted at all. */
function recordingVerifier(state: NontransactionalState | "throw") {
  const calls: number[] = [];
  return {
    calls,
    handler: {
      inspect: async () => {
        calls.push(1);
        if (state === "throw") throw new Error("verifier exploded");
        return state;
      },
    } as NontransactionalHandler,
  };
}

function verifierFor(entry: MigrationManifestEntry, state: NontransactionalState | "throw") {
  const { calls, handler } = recordingVerifier(state);
  return { calls, nontransactionalHandlers: new Map([[entry.id, handler]]) };
}

// ── Stage 1: the central gate, and what it refuses to delegate ────────────

test("H2 Stage 1: an armed attempt that never issued durable work is authoritatively safe to retry in every verifier-led and batched mode", async () => {
  // Transactional is deliberately excluded: it has no durable-work marker,
  // because the protected binding protocol is its authoritative evidence.
  for (const entry of [entries.legacy, entries.nontransactional, entries.batched]) {
    const pool = new FakePool();
    pool.control.priorEvents = armedOnly(entry, H2_RUN);
    const attempt = run(pool, { manifest: manifestOf(entry) });
    if (entry.executionMode === "legacy-verbatim") {
      // Legacy needs no handler, so it runs to completion.
      assert.equal((await attempt).executedCount, 1, "a legacy attempt that never issued its payload retries");
    } else {
      // The other two have no reviewed handler in this fixture, so they get
      // past the fence and fail on the handler lookup instead — which is the
      // proof that Stage 2 permitted the replay.
      await assert.rejects(attempt, /unsupported_handler/, `${entry.executionMode} must pass the fence`);
    }
  }
});

test("H2 Stage 1: an attempt that reached durable work blocks in every mode with no authoritative evidence", async () => {
  for (const entry of ALL_MODES) {
    const pool = new FakePool();
    pool.control.priorEvents = reachedDurableWork(entry, H2_RUN);
    await assert.rejects(
      run(pool, { manifest: manifestOf(entry) }),
      /commit_outcome_unknown/,
      `${entry.executionMode} must block once durable work began`,
    );
    assert.deepEqual(pool.migrationSql(), [], `${entry.executionMode}: nothing may run`);
  }
});

test("H2 Stage 1: malformed central history is never overridden by a mode verifier, which is never even consulted", async () => {
  for (const entry of [entries.legacy, entries.nontransactional]) {
    const pool = new FakePool();
    // A duplicate `started` row: outside the ledger's writer contract, so the
    // attempt is malformed_or_conflicting and unclearable.
    pool.control.priorEvents = [
      armedFor(entry, H2_RUN),
      { ...armedFor(entry, H2_RUN), event_id: 2, event_sequence: 2 },
    ];
    const { calls, nontransactionalHandlers } = verifierFor(entry, "absent");
    await assert.rejects(
      run(pool, { manifest: manifestOf(entry), nontransactionalHandlers }),
      /duplicate_started_not_permitted_by_ledger_contract/,
      `${entry.executionMode}: malformed history blocks`,
    );
    assert.deepEqual(calls, [], `${entry.executionMode}: the verifier must never run against malformed history`);
  }
});

test("H2 Stage 1: an unresolved commit_outcome_unknown is never overridden by a mode verifier", async () => {
  const entry = entries.nontransactional;
  const pool = new FakePool();
  pool.control.priorEvents = [
    armedFor(entry, H2_RUN),
    {
      ...armedFor(entry, H2_RUN),
      event_id: 2,
      event_sequence: 2,
      event_type: "execution_failed",
      heartbeat_deadline: null,
      error_class: "commit_outcome_unknown",
    },
  ];
  const { calls, nontransactionalHandlers } = verifierFor(entry, "absent");
  await assert.rejects(
    run(pool, { manifest: manifestOf(entry), nontransactionalHandlers }),
    /reason=commit_outcome_unknown/,
  );
  assert.deepEqual(calls, [], "an ambiguous attempt is past the point any verifier can speak for it");
});

test("H2 Stage 1: a manual-resolution record that clears no attempt clears nothing and blocks nothing extra", async () => {
  const entry = entries.legacy;
  const pool = new FakePool();
  const unmatched: PriorEventFixture = {
    ...armedFor(entry, H2_RUN),
    event_id: 1,
    event_sequence: 1,
    event_type: "stale_reclaimed",
    heartbeat_deadline: null,
    metadata: {
      execution_mode: entry.executionMode,
      migration_filename: entry.filename,
      migration_ordinal: 1,
      checksum_sha256: entry.sha256,
      reclaim_reason: "operator note",
      resolved_event_id: 999,
      resolved_run_id: "10000000-0000-4000-8000-00000000f999",
      resolved_runner_id: identity.runnerId,
      resolved_checksum_sha256: entry.sha256,
    },
  };
  // Alone, a resolution that names no attempt is inert: it never clears
  // anything, and it never bricks a migration that is otherwise replayable.
  const inert = new FakePool();
  inert.control.priorEvents = [unmatched];
  assert.equal((await run(inert, { manifest: manifestOf(entry) })).executedCount, 1);

  // With a real unresolved attempt present, it still clears nothing — the
  // attempt it failed to name stays blocked exactly as before.
  pool.control.priorEvents = [
    ...reachedDurableWork(entry, H2_RUN),
    // Its own run id, so it has its own gapless event_sequence stream of one.
    { ...unmatched, event_id: 3, event_sequence: 1, run_id: "10000000-0000-4000-8000-00000000f00b" },
  ];
  await assert.rejects(
    run(pool, { manifest: manifestOf(entry) }),
    /recovery_verifier_unavailable/,
  );
});

// ── Stage 2A: transactional ───────────────────────────────────────────────

/** started + binding, and optionally more, for a transactional attempt. */
function boundTransactionalAttempt(run_id: string, xactId: string, extra: PriorEventFixture[] = []): PriorEventFixture[] {
  const entry = entries.transactional;
  return [
    armedFor(entry, run_id),
    {
      ...armedFor(entry, run_id),
      event_id: 2,
      event_sequence: 2,
      event_type: "heartbeat",
      heartbeat_deadline: null,
      xact_id: xactId,
    },
    ...extra,
  ];
}

const TRANSACTIONAL_CASES: Array<[string, string | null | "unavailable", RegExp | "retries"]> = [
  ["PostgreSQL reports the bound transaction aborted, but the attempt claimed no outcome", "aborted",
    /STILL_ACTIVE:armed_attempt_has_claimed_no_outcome/],
  ["PostgreSQL reports the bound transaction committed", "committed", /bound_transaction_committed_without_commit_proof/],
  ["PostgreSQL reports the bound transaction still in progress", "in progress", /STILL_ACTIVE:bound_transaction_still_in_progress/],
  ["PostgreSQL discarded the transaction's status", null, /bound_transaction_status_unavailable/],
  ["pg_xact_status is unreadable by this role", "unavailable", /bound_transaction_status_unavailable/],
];

for (const [label, status, expectation] of TRANSACTIONAL_CASES) {
  test(`H2 Stage 2 transactional: ${label}`, async () => {
    const pool = new FakePool();
    pool.control.priorEvents = boundTransactionalAttempt(H2_RUN, "9100");
    pool.control.xactStatus = status === "unavailable" ? "unavailable" : { 9100: status };
    const attempt = run(pool, { manifest: manifestOf(entries.transactional) });
    if (expectation === "retries") {
      // The H2 gain: an attempt whose transaction PostgreSQL confirms aborted
      // retries even though it died before it could write its own rollback
      // labels.
      assert.equal((await attempt).executedCount, 1);
    } else {
      await assert.rejects(attempt, expectation);
      assert.deepEqual(pool.migrationSql(), []);
    }
  });
}

test("H2 Stage 2 transactional: an aborted binding plus any correlated terminal row is authoritatively safe to retry", async () => {
  // The H2 gain: pre-H2 this needed the writer's full transaction_rolled_back +
  // execution_failed pair with matching classes and SQLSTATEs, so an attempt
  // that aborted and then died before it could finish describing itself stayed
  // blocked forever despite PostgreSQL holding a conclusive answer.
  const pool = new FakePool();
  pool.control.priorEvents = boundTransactionalAttempt(H2_RUN, "9105", [{
    ...armedFor(entries.transactional, H2_RUN),
    event_id: 3,
    event_sequence: 3,
    event_type: "execution_failed",
    heartbeat_deadline: null,
    error_class: "verification_failed",
    sqlstate: null,
  }]);
  pool.control.xactStatus = { 9105: "aborted" };
  assert.equal((await run(pool, { manifest: manifestOf(entries.transactional) })).executedCount, 1);
});

test("H2 Stage 2 transactional: an attempt with no exclusively owned binding is never retried", async () => {
  const pool = new FakePool();
  pool.control.priorEvents = [armedFor(entries.transactional, H2_RUN)];
  await assert.rejects(
    run(pool, { manifest: manifestOf(entries.transactional) }),
    /no_exclusive_transaction_binding/,
  );
});

test("H2 Stage 2 transactional: an aborted binding is refused when a durable applied row contradicts it", async () => {
  const pool = new FakePool();
  pool.control.priorEvents = boundTransactionalAttempt(H2_RUN, "9101");
  pool.control.xactStatus = { 9101: "aborted" };
  // An applied row for this exact attempt: PostgreSQL says the transaction
  // aborted, the ledger says it landed. Never resolved in our favour.
  pool.control.artifacts = [{
    run_id: H2_RUN,
    ordinal: 1,
    filename: entries.transactional.filename,
    applied_checksum_sha256: entries.transactional.sha256,
    execution_mode: "transactional",
    source_git_sha: identity.sourceGitSha,
    executor_image_digest: identity.executorImageDigest,
    commit_proof: "post_hoc_verified",
  }];
  await assert.rejects(
    run(pool, { manifest: manifestOf(entries.transactional) }),
    /applied_row_lacks_transaction_atomic_proof/,
  );
});

// ── Stage 2B: batched ─────────────────────────────────────────────────────

function batchEvent(run_id: string, event_id: number, event_type: string, batch_number: number): PriorEventFixture {
  const entry = entries.batched;
  return {
    ...armedFor(entry, run_id),
    event_id,
    event_sequence: event_id,
    event_type,
    heartbeat_deadline: null,
    metadata: {
      execution_mode: "batched",
      migration_filename: entry.filename,
      migration_ordinal: 1,
      checksum_sha256: entry.sha256,
      batch_number,
    },
  };
}

const BATCHED_CASES: Array<[string, PriorEventFixture[], RegExp | "retries"]> = [
  ["no batch was ever scheduled", armedOnly(entries.batched, H2_RUN), "retries"],
  [
    "the attempt predates progress recording entirely",
    [armedFor(entries.batched, H2_RUN)],
    /batch_progress_unprovable_for_this_attempt/,
  ],
  [
    "a batch opened a transaction and its commit outcome is unprovable",
    reachedDurableWork(entries.batched, H2_RUN),
    /batch_began_without_provable_commit_outcome/,
  ],
  [
    "one batch committed before the failure",
    [
      ...reachedDurableWork(entries.batched, H2_RUN),
      batchEvent(H2_RUN, 4, "operation_completed", 1),
      batchEvent(H2_RUN, 5, "transaction_rolled_back", 2),
    ],
    /at_least_one_batch_committed/,
  ],
  [
    "every batch committed and the completion verifier then failed",
    [
      ...reachedDurableWork(entries.batched, H2_RUN),
      batchEvent(H2_RUN, 4, "operation_completed", 1),
      batchEvent(H2_RUN, 5, "operation_completed", 2),
      {
        ...armedFor(entries.batched, H2_RUN),
        event_id: 6,
        event_sequence: 6,
        event_type: "verification_failed",
        heartbeat_deadline: null,
        error_class: "verification_failed",
      },
    ],
    /at_least_one_batch_committed/,
  ],
  [
    "the same batch reports two completions",
    [
      ...reachedDurableWork(entries.batched, H2_RUN),
      batchEvent(H2_RUN, 4, "operation_completed", 1),
      batchEvent(H2_RUN, 5, "operation_completed", 1),
    ],
    /MALFORMED_OR_CONFLICTING:duplicate_batch_completion_events/,
  ],
  [
    "a batch event exists for an attempt that never marked durable work",
    [...armedOnly(entries.batched, H2_RUN), batchEvent(H2_RUN, 3, "operation_completed", 1)],
    /MALFORMED_OR_CONFLICTING:batch_events_without_durable_work_marker/,
  ],
];

for (const [label, priorEvents, expectation] of BATCHED_CASES) {
  test(`H2 Stage 2 batched: ${label}`, async () => {
    const pool = new FakePool();
    pool.control.priorEvents = priorEvents;
    const attempt = run(pool, { manifest: manifestOf(entries.batched) });
    if (expectation === "retries") {
      // Past the fence; this fixture registers no batched handler, so the
      // mode-specific refusal is the proof that Stage 2 permitted the replay.
      await assert.rejects(attempt, /unsupported_handler/);
    } else {
      await assert.rejects(attempt, expectation);
      assert.deepEqual(pool.migrationSql(), []);
    }
  });
}

// ── Stage 2C/2D: nontransactional and legacy-verbatim (one evaluator) ──────

const VERIFIER_CASES: Array<[string, NontransactionalState | "throw" | "none", RegExp | "retries" | "adopts"]> = [
  ["the verifier proves no durable effect", "absent", "retries"],
  ["the verifier proves the desired final state", "valid", "adopts"],
  ["the verifier reports a partial or invalid state", "invalid", /verifier_reports_partial_or_invalid_state/],
  ["the verifier cannot classify the state", "unknown", /verifier_evidence_inconclusive/],
  ["the verifier itself fails", "throw", /recovery_verifier_failed/],
  ["no reviewed recovery verifier is registered", "none", /recovery_verifier_unavailable/],
];

for (const [label, state, expectation] of VERIFIER_CASES) {
  test(`H2 Stage 2 legacy-verbatim: ${label}`, async () => {
    const entry = entries.legacy;
    const pool = new FakePool();
    pool.control.priorEvents = reachedDurableWork(entry, H2_RUN);
    const substitution = state === "none" ? {} : verifierFor(entry, state);
    const attempt = run(pool, { manifest: manifestOf(entry), ...substitution });
    if (expectation === "retries") {
      assert.equal((await attempt).executedCount, 1);
      assert.equal(pool.migrationSql().length, 1, "the payload is re-issued");
    } else if (expectation === "adopts") {
      assert.equal((await attempt).executedCount, 1);
      assert.deepEqual(pool.migrationSql(), [], "an already-applied legacy payload is never re-issued");
      assert.equal(pool.control.appliedInserts.length, 1, "the applied row is recorded instead");
      assert.deepEqual(
        pool.control.eventTypes(),
        ["started", "heartbeat", "operation_completed", "applied_committed", "succeeded"],
      );
    } else {
      await assert.rejects(attempt, expectation);
      assert.deepEqual(pool.migrationSql(), []);
    }
  });
}

test("H2 Stage 2 nontransactional: a verifier proving no durable effect permits the replay", async () => {
  const entry = entries.nontransactional;
  const pool = new FakePool();
  pool.control.priorEvents = reachedDurableWork(entry, H2_RUN);
  // Absent for recovery evaluation and for the pre-flight inspect, then valid
  // once the operation has actually run — a real index verifier's answers.
  const states: NontransactionalState[] = ["absent", "absent", "valid"];
  const nontransactionalHandlers = new Map([[entry.id, {
    inspect: async () => states.shift() ?? "valid",
  } as NontransactionalHandler]]);
  const report = await run(pool, { manifest: manifestOf(entry), nontransactionalHandlers });
  assert.equal(report.executedCount, 1);
  assert.equal(report.executed[0].adopted, false, "an absent state is executed, never adopted");
  assert.equal(pool.migrationSql().length, 1);
});

test("H2 Stage 2 nontransactional: a verifier proving the desired state adopts rather than re-executing", async () => {
  const entry = entries.nontransactional;
  const pool = new FakePool();
  pool.control.priorEvents = reachedDurableWork(entry, H2_RUN);
  const { nontransactionalHandlers } = verifierFor(entry, "valid");
  const report = await run(pool, { manifest: manifestOf(entry), nontransactionalHandlers });
  assert.equal(report.executed[0].adopted, true);
  assert.deepEqual(pool.migrationSql(), []);
});

test("H2 Stage 2 nontransactional: an inconclusive verifier blocks rather than replaying", async () => {
  const entry = entries.nontransactional;
  const pool = new FakePool();
  pool.control.priorEvents = reachedDurableWork(entry, H2_RUN);
  const { nontransactionalHandlers } = verifierFor(entry, "unknown");
  await assert.rejects(
    run(pool, { manifest: manifestOf(entry), nontransactionalHandlers }),
    /verifier_evidence_inconclusive/,
  );
  assert.deepEqual(pool.migrationSql(), []);
});

test("H2: stale_legacy_attempt is never emitted by any new execution path", async () => {
  const pool = new FakePool();
  await run(pool, { manifest: manifestOf(entries.legacy) });
  assert.ok(
    pool.control.events.every(({ values }) => values[9] !== "stale_legacy_attempt"),
    "no current execution path writes the historical legacy class",
  );
});
