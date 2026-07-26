import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import {
  checkManifest,
  type MigrationManifest,
  type MigrationManifestEntry,
  type MigrationTimeouts,
} from "./manifest";
import {
  GIT_SHA,
  IMAGE_DIGEST,
  assertNoLegacyLedgerDivergence,
  buildMigrationPlan,
  readAppliedRows,
  verifyControlSchema,
  withSchemaAdvisoryLock,
} from "./runner";

/**
 * Approved architecture limits. Manifest entries declare their own timeouts;
 * anything above these ceilings fails closed before a single statement runs,
 * so a reviewed-then-edited manifest cannot widen the blast radius.
 */
export const TIMEOUT_CEILINGS = {
  lockMs: 5_000,
  statementMs: 60_000,
  transactionMs: 300_000,
  idleInTransactionMs: 60_000,
} as const;
export const TRANSACTIONAL_WALL_CLOCK_CEILING_MS = 900_000;
export const NONTRANSACTIONAL_WALL_CLOCK_CEILING_MS = 1_800_000;
export const SCHEMA_RUNNER_WALL_CLOCK_MS = 3_600_000;
export const CANCELLATION_GRACE_MS = 10_000;

const RUNNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type EventType =
  | "started"
  | "heartbeat"
  | "transaction_rolled_back"
  | "operation_completed"
  | "execution_failed"
  | "applied_committed"
  | "verification_failed"
  | "succeeded"
  | "stale_reclaimed";

/**
 * Exactly the keys mr_metadata_ck permits. Enforced in code as well so a bad
 * key fails before it reaches an INSERT that would abort mid-run.
 */
const METADATA_KEYS = [
  "duration_ms",
  "elapsed_ms",
  "rows_affected",
  "statement_count",
  "batch_number",
  "retry_count",
  "operation_category",
  "execution_mode",
  "migration_filename",
  "migration_ordinal",
  "verification",
  "reclaim_reason",
] as const;

type EventMetadata = Partial<Record<(typeof METADATA_KEYS)[number], number | string>>;

/**
 * Fixed error vocabulary. Errors carry a classification, a SQLSTATE and an
 * identifier — never a PostgreSQL message, which can quote row values.
 */
export const ERROR_CLASSES = [
  "cancellation_unverified",
  "checksum_drift",
  "control_connection_lost",
  "identity_missing",
  "ledger_insert_failed",
  "manifest_ceiling_exceeded",
  "run_budget_exceeded",
  "sql_failed",
  "stale_legacy_attempt",
  "unsupported_handler",
  "verification_failed",
  "verifier_state_invalid",
  "wall_clock_exceeded",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

export class MigrationExecutionError extends Error {
  readonly errorClass: ErrorClass;
  readonly sqlstate: string | null;
  readonly migrationId: string | null;

  constructor(errorClass: ErrorClass, detail: string, migrationId: string | null = null, sqlstate: string | null = null) {
    super(migrationId ? `[${errorClass}] migration ${migrationId}: ${detail}` : `[${errorClass}] ${detail}`);
    this.name = "MigrationExecutionError";
    this.errorClass = errorClass;
    this.sqlstate = sqlstate;
    this.migrationId = migrationId;
  }
}

/** Catalog/business state of one nontransactional operation. */
export type NontransactionalState = "absent" | "valid" | "invalid";

/**
 * Migration-specific verifier. The runner never guesses whether a
 * nontransactional operation finished: it asks this, before and after.
 */
export interface NontransactionalHandler {
  inspect(client: PoolClient): Promise<NontransactionalState>;
}

export interface BatchedContext {
  readonly migrationId: string;
  /** Runs one batch in its own bounded transaction. Progress is the handler's job. */
  runBatch<T>(batch: (client: PoolClient) => Promise<T>): Promise<T>;
}

/**
 * Batched migrations own their own progress control. The runner supplies only
 * the bounded per-batch transaction and demands an independent completion
 * verifier; it deliberately provides no generic backfill executor.
 */
export interface BatchedHandler {
  execute(context: BatchedContext): Promise<void>;
  verifyComplete(client: PoolClient): Promise<boolean>;
}

interface MigrationHandlers {
  nontransactional: ReadonlyMap<string, NontransactionalHandler>;
  batched: ReadonlyMap<string, BatchedHandler>;
}

/**
 * No migration above the legacy boundary exists yet, so both registries are
 * empty and every nontransactional/batched migration fails closed on an
 * unsupported-handler error until a reviewed handler is registered here.
 */
const registeredHandlers: MigrationHandlers = {
  nontransactional: new Map<string, NontransactionalHandler>(),
  batched: new Map<string, BatchedHandler>(),
};

export interface ExecutionIdentity {
  sourceGitSha: string;
  executorImageDigest: string;
  runnerId: string | null;
}

export interface ExecutedMigration {
  id: string;
  filename: string;
  executionMode: MigrationManifestEntry["executionMode"];
  appliedChecksumSha256: string;
  /** True when a valid-but-unrecorded nontransactional state was adopted rather than re-executed. */
  adopted: boolean;
}

export interface ExecutionReport {
  schemaVersion: 1;
  runId: string;
  legacyBoundary: string;
  appliedBefore: number;
  pendingBefore: number;
  executedCount: number;
  executed: ExecutedMigration[];
  outcome: "no-op" | "completed";
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(bytes: NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sqlstateOf(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && SQLSTATE.test(code) ? code : null;
}

/**
 * Collapses any driver or server error into the fixed vocabulary. The original
 * message is dropped on purpose: it can contain SQL text, bound parameters or
 * conflicting row values.
 */
function classify(error: unknown, errorClass: ErrorClass, migrationId: string, detail: string): MigrationExecutionError {
  if (error instanceof MigrationExecutionError) return error;
  return new MigrationExecutionError(errorClass, detail, migrationId, sqlstateOf(error));
}

function identityFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ExecutionIdentity {
  return validateExecutionIdentity({
    sourceGitSha: environment.MIGRATION_SOURCE_GIT_SHA ?? "",
    executorImageDigest: environment.MIGRATION_EXECUTOR_IMAGE_DIGEST ?? "",
    runnerId: environment.MIGRATION_RUNNER_ID ?? null,
  });
}

function isObviousPlaceholder(value: string): boolean {
  const lowered = value.toLowerCase();
  return /^0+$/.test(lowered)
    || /^f+$/.test(lowered)
    || /^(?:deadbeef)+$/.test(lowered)
    || /^(?:cafebabe)+$/.test(lowered)
    || /^(?:feedface)+$/.test(lowered)
    || /^(?:decafbad)+$/.test(lowered);
}

function validateExecutionIdentity(identity: ExecutionIdentity): ExecutionIdentity {
  const { sourceGitSha, executorImageDigest, runnerId } = identity;
  if (!GIT_SHA.test(sourceGitSha) || isObviousPlaceholder(sourceGitSha)) {
    throw new MigrationExecutionError("identity_missing", "MIGRATION_SOURCE_GIT_SHA must be a 7-64 character lowercase hex commit SHA");
  }
  const digest = executorImageDigest.slice("sha256:".length);
  if (!IMAGE_DIGEST.test(executorImageDigest) || isObviousPlaceholder(digest)) {
    throw new MigrationExecutionError("identity_missing", "MIGRATION_EXECUTOR_IMAGE_DIGEST must look like sha256:<64 hex>");
  }
  if (runnerId !== null && !RUNNER_ID.test(runnerId)) {
    throw new MigrationExecutionError("identity_missing", "MIGRATION_RUNNER_ID contains unsupported characters");
  }
  return { sourceGitSha, executorImageDigest, runnerId };
}

/**
 * Rejects a manifest that declares more headroom than the approved architecture
 * limits.
 *
 * Per-migration only. Each entry declares a worst-case ceiling, so summing those
 * ceilings across a run would reject any manifest with more than four migrations
 * even though real migrations finish in seconds — the current 24-migration
 * legacy set declares 21_600_000ms against a 3_600_000ms budget. The
 * schema-runner budget is enforced against *elapsed* time during the run
 * instead, in executeMigrations.
 */
function assertTimeoutCeilings(
  pending: Array<Pick<MigrationManifestEntry, "id" | "executionMode" | "timeouts">>,
): void {
  for (const entry of pending) {
    for (const key of ["lockMs", "statementMs", "transactionMs", "idleInTransactionMs"] as const) {
      if (entry.timeouts[key] > TIMEOUT_CEILINGS[key]) {
        throw new MigrationExecutionError(
          "manifest_ceiling_exceeded",
          `${key} of ${entry.timeouts[key]}ms exceeds the approved ceiling of ${TIMEOUT_CEILINGS[key]}ms`,
          entry.id,
        );
      }
    }
    const wallClockCeiling = entry.executionMode === "nontransactional"
      ? NONTRANSACTIONAL_WALL_CLOCK_CEILING_MS
      : TRANSACTIONAL_WALL_CLOCK_CEILING_MS;
    if (entry.timeouts.wallClockMs > wallClockCeiling) {
      throw new MigrationExecutionError(
        "manifest_ceiling_exceeded",
        `wallClockMs of ${entry.timeouts.wallClockMs}ms exceeds the approved ${entry.executionMode} ceiling of ${wallClockCeiling}ms`,
        entry.id,
      );
    }
  }
}

async function applyTimeouts(client: PoolClient, timeouts: MigrationTimeouts, local: boolean): Promise<void> {
  // set_config is the parameterised form of SET/SET LOCAL, so no timeout value
  // is ever interpolated into SQL text.
  for (const [setting, milliseconds] of [
    ["lock_timeout", timeouts.lockMs],
    ["statement_timeout", timeouts.statementMs],
    ["transaction_timeout", timeouts.transactionMs],
    ["idle_in_transaction_session_timeout", timeouts.idleInTransactionMs],
  ] as const) {
    assertCondition(Number.isInteger(milliseconds) && milliseconds >= 0, `Invalid ${setting}`);
    await client.query("select set_config($1, $2, $3)", [setting, String(milliseconds), local]);
  }
}

/** INSERT-only event stream. One run id, one strictly increasing sequence. */
class RunLog {
  private sequence = 0;

  constructor(
    private readonly control: PoolClient,
    readonly runId: string,
    private readonly identity: ExecutionIdentity,
    private readonly manifest: MigrationManifest,
  ) {}

  get lastSequence(): number {
    return this.sequence;
  }

  async append(
    migrationId: string,
    eventType: EventType,
    metadata: EventMetadata = {},
    extra: {
      sqlstate?: string | null;
      errorClass?: ErrorClass;
      heartbeatDeadline?: Date;
      statementOrdinal?: number;
    } = {},
  ): Promise<void> {
    const ordinal = this.manifest.migrations.findIndex(({ id }) => id === migrationId) + 1;
    const entry = this.manifest.migrations[ordinal - 1];
    assertCondition(entry?.id === migrationId, `Migration ${migrationId} is not present in the verified manifest`);
    const persistedMetadata: EventMetadata = {
      ...metadata,
      migration_filename: entry.filename,
      migration_ordinal: ordinal,
    };
    for (const key of Object.keys(persistedMetadata)) {
      assertCondition(
        (METADATA_KEYS as readonly string[]).includes(key),
        `Event metadata key ${key} is not permitted by mr_metadata_ck`,
      );
    }
    assertCondition(
      extra.heartbeatDeadline === undefined || eventType === "started" || eventType === "heartbeat",
      "heartbeat_deadline is only permitted on started and heartbeat events",
    );
    assertCondition(
      extra.statementOrdinal === undefined
        || (Number.isSafeInteger(extra.statementOrdinal) && extra.statementOrdinal > 0),
      "statement_ordinal must be a positive safe integer",
    );
    this.sequence += 1;
    await this.control.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, heartbeat_deadline,
          source_git_sha, executor_image_digest, sqlstate, error_class, metadata, statement_ordinal)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [
        this.runId,
        migrationId,
        this.sequence,
        eventType,
        this.identity.runnerId,
        extra.heartbeatDeadline ?? null,
        this.identity.sourceGitSha,
        this.identity.executorImageDigest,
        extra.sqlstate ?? null,
        extra.errorClass ?? null,
        JSON.stringify(persistedMetadata),
        extra.statementOrdinal ?? null,
      ],
    );
  }
}

async function insertAppliedRow(
  client: PoolClient,
  entry: MigrationManifestEntry,
  ordinal: number,
  appliedChecksum: string,
  runId: string,
  identity: ExecutionIdentity,
): Promise<void> {
  assertCondition(SHA256.test(appliedChecksum), `Refusing to record a malformed applied checksum for ${entry.id}`);
  await client.query(
    `insert into migration_control.schema_migrations
       (migration_id, ordinal, filename, manifest_checksum_sha256, applied_checksum_sha256,
        lifecycle_phase, operation_categories, execution_mode, applied_at, run_id,
        baselined, source_git_sha, executor_image_digest)
     values ($1, $2, $3, $4, $5, $6, $7::text[], $8, now(), $9, false, $10, $11)`,
    [
      entry.id,
      ordinal,
      entry.filename,
      entry.sha256,
      appliedChecksum,
      entry.lifecyclePhase,
      entry.operationCategories,
      entry.executionMode,
      runId,
      identity.sourceGitSha,
      identity.executorImageDigest,
    ],
  );
}

interface MigrationContext {
  entry: MigrationManifestEntry;
  ordinal: number;
  bytes: Buffer;
  checksum: string;
  control: PoolClient;
  execution: PoolClient;
  runLog: RunLog;
  identity: ExecutionIdentity;
  handlers: MigrationHandlers;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  /** Set when the execution connection must be destroyed rather than returned to the pool. */
  destroyExecution: () => void;
}

type PriorEvent = {
  run_id: string;
  migration_id: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactMetadata(value: unknown, expected: Record<string, unknown>): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index] && value[key] === expected[key]);
}

function isSafeLegacyRetryHistory(events: PriorEvent[], context: MigrationContext): boolean {
  if (events.length < 3) return false;
  const { entry, ordinal } = context;
  const runId = events[0]?.run_id;
  if (!runId
    || !UUID.test(runId)
    || ordinal < 1
    || entry.executionMode !== "legacy-verbatim") {
    return false;
  }

  for (const [index, event] of events.entries()) {
    const commonMetadata = {
      execution_mode: entry.executionMode,
      migration_filename: entry.filename,
      migration_ordinal: ordinal,
    };
    if (event.run_id !== runId
      || event.migration_id !== entry.id
      || event.event_sequence !== index + 1
      || !GIT_SHA.test(event.source_git_sha ?? "")
      || !IMAGE_DIGEST.test(event.executor_image_digest ?? "")
      || isObviousPlaceholder(event.source_git_sha ?? "")
      || isObviousPlaceholder((event.executor_image_digest ?? "").slice("sha256:".length))
      || event.source_git_sha !== events[0].source_git_sha
      || event.executor_image_digest !== events[0].executor_image_digest
      || (event.runner_id !== null && !RUNNER_ID.test(event.runner_id))
      || event.runner_id !== events[0].runner_id
      || !isRecord(event.metadata)
      || event.metadata.execution_mode !== commonMetadata.execution_mode
      || event.metadata.migration_filename !== commonMetadata.migration_filename
      || event.metadata.migration_ordinal !== commonMetadata.migration_ordinal) {
      return false;
    }
  }

  const identityMetadata = {
    execution_mode: entry.executionMode,
    migration_filename: entry.filename,
    migration_ordinal: ordinal,
  };
  const started = events[0];
  if (started.event_type !== "started"
    || started.statement_ordinal !== null
    || started.error_class !== null
    || started.sqlstate !== null
    || !Number.isFinite(new Date(started.heartbeat_deadline ?? "").getTime())
    || !hasExactMetadata(started.metadata, identityMetadata)) {
    return false;
  }

  const rollbackIndex = events.findIndex(({ event_type }) => event_type === "transaction_rolled_back");
  if (rollbackIndex < 1 || rollbackIndex !== events.length - 2) return false;

  for (const heartbeat of events.slice(1, rollbackIndex)) {
    if (heartbeat.event_type !== "heartbeat"
      || heartbeat.statement_ordinal !== null
      || heartbeat.error_class !== null
      || heartbeat.sqlstate !== null
      || !Number.isFinite(new Date(heartbeat.heartbeat_deadline ?? "").getTime())
      || !isRecord(heartbeat.metadata)
      || heartbeat.metadata.execution_mode !== "legacy-verbatim"
      || !Number.isSafeInteger(heartbeat.metadata.elapsed_ms)
      || Number(heartbeat.metadata.elapsed_ms) < 0
      || !hasExactMetadata(heartbeat.metadata, { ...identityMetadata, elapsed_ms: heartbeat.metadata.elapsed_ms })) {
      return false;
    }
  }

  const rollback = events[rollbackIndex];
  const failure = events[rollbackIndex + 1];
  return rollback.event_type === "transaction_rolled_back"
    && rollback.statement_ordinal === 1
    && rollback.error_class === "sql_failed"
    && rollback.heartbeat_deadline === null
    && hasExactMetadata(rollback.metadata, identityMetadata)
    && SQLSTATE.test(rollback.sqlstate ?? "")
    && failure.event_type === "execution_failed"
    && failure.statement_ordinal === 1
    && failure.error_class === "sql_failed"
    && failure.heartbeat_deadline === null
    && hasExactMetadata(failure.metadata, identityMetadata)
    && failure.sqlstate === rollback.sqlstate;
}

/**
 * Legacy files carry their own BEGIN/COMMIT and are executed as one unchanged
 * multi-statement payload: no outer transaction, no parsing, no splitting.
 *
 * The commit-to-ledger crash window is accepted and deliberate for legacy only.
 * If the file commits and the process dies before the control-connection INSERT,
 * the next run sees prior events with no applied row and refuses to replay.
 */
async function executeLegacyVerbatim(context: MigrationContext): Promise<void> {
  const { entry, control, execution, runLog, bytes, checksum } = context;

  const prior = await control.query<PriorEvent>(
    `select run_id::text,
            migration_id,
            event_sequence,
            event_type,
            runner_id,
            heartbeat_deadline,
            source_git_sha,
            executor_image_digest,
            sqlstate,
            error_class,
            metadata,
            statement_ordinal
       from migration_control.migration_runs
      where migration_id = $1
      order by run_id, event_sequence`,
    [entry.id],
  );
  const runIds = new Set(prior.rows.map(({ run_id }) => run_id));
  const safeToRetry = prior.rows.length === 0
    || (runIds.size === 1 && isSafeLegacyRetryHistory(prior.rows, context));
  if (!safeToRetry) {
    throw new MigrationExecutionError(
      "stale_legacy_attempt",
      "a previous attempt has an ambiguous outcome; automatic replay is refused until the ledger is reconciled",
      entry.id,
    );
  }

  const startedAt = context.now();
  await runLog.append(entry.id, "started", { execution_mode: "legacy-verbatim" }, {
    heartbeatDeadline: new Date(Date.now() + entry.timeouts.wallClockMs),
  });

  // Session-level only: the payload owns its own transaction, so SET LOCAL has
  // nowhere to live and wrapping it in one is prohibited.
  await applyTimeouts(execution, entry.timeouts, false);

  try {
    await execution.query(bytes.toString("utf8"));
  } catch (error) {
    try {
      await execution.query("rollback");
      await runLog.append(entry.id, "transaction_rolled_back", { execution_mode: "legacy-verbatim" }, {
        sqlstate: sqlstateOf(error),
        errorClass: "sql_failed",
        statementOrdinal: 1,
      });
    } catch {
      context.destroyExecution();
    }
    await runLog.append(entry.id, "execution_failed", { execution_mode: "legacy-verbatim" }, {
      sqlstate: sqlstateOf(error),
      errorClass: "sql_failed",
      statementOrdinal: 1,
    });
    throw classify(error, "sql_failed", entry.id, "legacy payload failed");
  }

  await runLog.append(entry.id, "operation_completed", {
    execution_mode: "legacy-verbatim",
    duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
  });

  // ── accepted legacy crash window opens here ──
  await insertAppliedRow(control, entry, context.ordinal, checksum, runLog.runId, context.identity);
  await runLog.append(entry.id, "applied_committed", { execution_mode: "legacy-verbatim" });
  await runLog.append(entry.id, "succeeded", {
    execution_mode: "legacy-verbatim",
    duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
  });
}

/**
 * Migration SQL and its applied-ledger row commit together or not at all: both
 * run on the execution connection inside one transaction.
 */
async function executeTransactional(context: MigrationContext): Promise<void> {
  const { entry, control, execution, runLog, bytes, checksum } = context;
  const startedAt = context.now();
  await runLog.append(entry.id, "started", { execution_mode: "transactional" }, {
    heartbeatDeadline: new Date(Date.now() + entry.timeouts.wallClockMs),
  });

  try {
    await execution.query("begin");
  } catch (error) {
    throw classify(error, "sql_failed", entry.id, "could not open the migration transaction");
  }

  try {
    await applyTimeouts(execution, entry.timeouts, true);
    await execution.query(bytes.toString("utf8"));
    await insertAppliedRow(execution, entry, context.ordinal, checksum, runLog.runId, context.identity);
    await execution.query("commit");
  } catch (error) {
    const sqlstate = sqlstateOf(error);
    try {
      await execution.query("rollback");
    } catch {
      context.destroyExecution();
    }
    // Both events go to the control connection, so they survive the rollback.
    await runLog.append(entry.id, "transaction_rolled_back", { execution_mode: "transactional" }, { sqlstate, errorClass: "sql_failed" });
    await runLog.append(entry.id, "execution_failed", { execution_mode: "transactional" }, { sqlstate, errorClass: "sql_failed" });
    throw classify(error, "sql_failed", entry.id, "transactional migration rolled back");
  }

  await runLog.append(entry.id, "applied_committed", { execution_mode: "transactional" });
  await runLog.append(entry.id, "succeeded", {
    execution_mode: "transactional",
    duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
  });
  void control;
}

/**
 * Runs one statement under a wall-clock budget supervised by the control
 * connection. On expiry the control connection cancels the execution backend;
 * if cancellation cannot be verified within the grace period the execution
 * connection is destroyed rather than reused.
 */
async function superviseOperation(context: MigrationContext, sql: string, budgetMs: number): Promise<void> {
  const { entry, control, execution } = context;
  const pidResult = await execution.query<{ pid: number }>("select pg_backend_pid() as pid");
  const pid = pidResult.rows[0]?.pid;
  assertCondition(Number.isInteger(pid), `Could not identify the execution backend for ${entry.id}`);

  const operation = execution.query(sql).then(() => "completed" as const, (error: unknown) => ({ failed: error }));
  const expiry = context.sleep(budgetMs).then(() => "expired" as const);
  const outcome = await Promise.race([operation, expiry]);

  if (outcome === "expired") {
    await control.query("select pg_cancel_backend($1)", [pid]);
    const settled = await Promise.race([
      operation.then(() => "settled" as const),
      context.sleep(CANCELLATION_GRACE_MS).then(() => "unverified" as const),
    ]);
    if (settled === "unverified") {
      context.destroyExecution();
      throw new MigrationExecutionError(
        "cancellation_unverified",
        `cancellation was not confirmed within ${CANCELLATION_GRACE_MS}ms; the execution connection was destroyed`,
        entry.id,
      );
    }
    throw new MigrationExecutionError("wall_clock_exceeded", `operation exceeded its ${budgetMs}ms wall-clock budget and was cancelled`, entry.id);
  }

  if (outcome !== "completed") {
    throw classify(outcome.failed, "sql_failed", entry.id, "nontransactional operation failed");
  }
}

/**
 * One independently retry-safe operation, never wrapped in a transaction. The
 * applied row is written only once a migration-specific verifier proves the
 * operation is complete; an invalid or partial state is never blindly replayed.
 */
async function executeNontransactional(context: MigrationContext): Promise<boolean> {
  const { entry, control, execution, runLog, checksum } = context;
  const handler = context.handlers.nontransactional.get(entry.id);
  if (!handler) {
    throw new MigrationExecutionError(
      "unsupported_handler",
      "nontransactional execution requires a reviewed migration-specific verifier; none is registered",
      entry.id,
    );
  }

  const startedAt = context.now();
  await runLog.append(entry.id, "started", { execution_mode: "nontransactional" }, {
    heartbeatDeadline: new Date(Date.now() + entry.timeouts.wallClockMs),
  });

  const before = await handler.inspect(execution);
  let adopted = false;

  if (before === "invalid") {
    await runLog.append(entry.id, "verification_failed", { execution_mode: "nontransactional", verification: "failed" }, {
      errorClass: "verifier_state_invalid",
    });
    throw new MigrationExecutionError(
      "verifier_state_invalid",
      "the verifier reports an invalid or partial state; explicit verifier-led recovery is required and blind replay is refused",
      entry.id,
    );
  }

  if (before === "valid") {
    // Valid but unrecorded: the operation completed on a previous attempt that
    // died before its ledger row. Record it; do not run it again.
    adopted = true;
    await runLog.append(entry.id, "operation_completed", {
      execution_mode: "nontransactional",
      verification: "passed",
      retry_count: 1,
    });
  } else {
    // statement_timeout, transaction_timeout and idle_in_transaction are all
    // disabled: the wall clock is enforced from the control connection instead.
    await applyTimeouts(execution, {
      lockMs: entry.timeouts.lockMs,
      statementMs: 0,
      transactionMs: 0,
      idleInTransactionMs: 0,
      wallClockMs: entry.timeouts.wallClockMs,
    }, false);
    await superviseOperation(context, context.bytes.toString("utf8"), entry.timeouts.wallClockMs);
    await runLog.append(entry.id, "operation_completed", {
      execution_mode: "nontransactional",
      duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
    });

    const after = await handler.inspect(execution);
    if (after !== "valid") {
      await runLog.append(entry.id, "verification_failed", { execution_mode: "nontransactional", verification: "failed" }, {
        errorClass: "verification_failed",
      });
      throw new MigrationExecutionError("verification_failed", "the verifier did not confirm completion after execution", entry.id);
    }
  }

  await insertAppliedRow(control, entry, context.ordinal, checksum, runLog.runId, context.identity);
  await runLog.append(entry.id, "applied_committed", { execution_mode: "nontransactional", verification: "passed" });
  await runLog.append(entry.id, "succeeded", {
    execution_mode: "nontransactional",
    verification: "passed",
    duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
  });
  return adopted;
}

/**
 * Mode boundary only. The runner hands the handler a bounded per-batch
 * transaction and demands an independent completion verifier; it never invents
 * a universal backfill executor and never degrades to another mode.
 */
async function executeBatched(context: MigrationContext): Promise<void> {
  const { entry, control, execution, runLog, checksum } = context;
  const handler = context.handlers.batched.get(entry.id);
  if (!handler) {
    throw new MigrationExecutionError(
      "unsupported_handler",
      "batched execution requires a reviewed migration-specific handler; none is registered",
      entry.id,
    );
  }

  const startedAt = context.now();
  await runLog.append(entry.id, "started", { execution_mode: "batched" }, {
    heartbeatDeadline: new Date(Date.now() + entry.timeouts.wallClockMs),
  });

  let batchNumber = 0;
  const batchContext: BatchedContext = {
    migrationId: entry.id,
    runBatch: async <T>(batch: (client: PoolClient) => Promise<T>): Promise<T> => {
      batchNumber += 1;
      const number = batchNumber;
      await execution.query("begin");
      try {
        await applyTimeouts(execution, entry.timeouts, true);
        const value = await batch(execution);
        await execution.query("commit");
        await runLog.append(entry.id, "operation_completed", { execution_mode: "batched", batch_number: number });
        return value;
      } catch (error) {
        const sqlstate = sqlstateOf(error);
        try {
          await execution.query("rollback");
        } catch {
          context.destroyExecution();
        }
        await runLog.append(entry.id, "transaction_rolled_back", { execution_mode: "batched", batch_number: number }, {
          sqlstate,
          errorClass: "sql_failed",
        });
        throw classify(error, "sql_failed", entry.id, `batch ${number} rolled back`);
      }
    },
  };

  try {
    await handler.execute(batchContext);
  } catch (error) {
    await runLog.append(entry.id, "execution_failed", { execution_mode: "batched", batch_number: batchNumber }, {
      sqlstate: sqlstateOf(error),
      errorClass: "sql_failed",
    });
    throw classify(error, "sql_failed", entry.id, "batched execution failed");
  }

  if (!(await handler.verifyComplete(execution))) {
    await runLog.append(entry.id, "verification_failed", { execution_mode: "batched", verification: "failed" }, {
      errorClass: "verification_failed",
    });
    throw new MigrationExecutionError("verification_failed", "the batched completion verifier reported remaining eligible work", entry.id);
  }

  await insertAppliedRow(control, entry, context.ordinal, checksum, runLog.runId, context.identity);
  await runLog.append(entry.id, "applied_committed", { execution_mode: "batched", verification: "passed" });
  await runLog.append(entry.id, "succeeded", {
    execution_mode: "batched",
    verification: "passed",
    duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
  });
}

/**
 * Distinguishes the four recovery states a CREATE INDEX CONCURRENTLY can leave
 * behind, so a handler never has to guess: missing, live and usable, or present
 * but invalid/not-ready (which requires explicit recovery, not a blind retry).
 */
export async function inspectConcurrentIndex(
  client: PoolClient,
  schemaName: string,
  indexName: string,
): Promise<NontransactionalState> {
  const result = await client.query<{ indisvalid: boolean; indisready: boolean; indislive: boolean }>(
    `select i.indisvalid, i.indisready, i.indislive
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_index i on i.indexrelid = c.oid
      where n.nspname = $1 and c.relname = $2 and c.relkind = 'i'`,
    [schemaName, indexName],
  );
  if (result.rows.length === 0) return "absent";
  const [{ indisvalid, indisready, indislive }] = result.rows;
  return indisvalid && indisready && indislive ? "valid" : "invalid";
}

export function renderExecutionReport(report: ExecutionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const repositoryRoot = path.resolve(__dirname, "../../../..");

async function executeVerifiedMigrations(
  pool: Pool,
  manifest: MigrationManifest,
  identity: ExecutionIdentity,
): Promise<ExecutionReport> {
  identity = validateExecutionIdentity(identity);
  const sleep = (milliseconds: number) => delay(milliseconds, undefined, { ref: false });
  const now = Date.now;
  const runId = randomUUID();
  const migrationDirectory = path.join(repositoryRoot, "db", "migrations");

  const control = await pool.connect();
  return withSchemaAdvisoryLock(control, async (lockedControl) => {
    // Nothing below runs a single byte of migration SQL until the lock is held
    // and the control schema, manifest and applied ledger have all verified.
    await verifyControlSchema(lockedControl);
    const appliedRows = await readAppliedRows(lockedControl);
    await assertNoLegacyLedgerDivergence(lockedControl, appliedRows, manifest);
    const plan = buildMigrationPlan(manifest, appliedRows);
    assertTimeoutCeilings(plan.pendingMigrations);

    const report: ExecutionReport = {
      schemaVersion: 1,
      runId,
      legacyBoundary: plan.legacyBoundary,
      appliedBefore: plan.appliedCount,
      pendingBefore: plan.pendingCount,
      executedCount: 0,
      executed: [],
      outcome: plan.pendingCount === 0 ? "no-op" : "completed",
    };
    // Zero pending: no events, no ledger rows, no migration SQL at all.
    if (plan.pendingCount === 0) return report;

    let controlLost: Error | undefined;
    let destroyExecution: Error | undefined;
    let executionReleased = false;
    const execution = await pool.connect();
    const releaseExecution = (error?: Error): void => {
      if (executionReleased) return;
      executionReleased = true;
      execution.release(error);
    };
    const onControlError = (error: Error) => {
      controlLost = error instanceof Error ? error : new Error(String(error));
      // Destroy the execution connection immediately rather than at the end of
      // the run. Its transaction is still in flight, and without the control
      // connection nothing can record or supervise it — an orphaned COMMIT
      // would write an applied row for a run that has already aborted.
      releaseExecution(controlLost);
    };
    lockedControl.once("error", onControlError);

    const runLog = new RunLog(lockedControl, runId, identity, manifest);
    const runStartedAt = now();

    try {
      for (const [index, pending] of plan.pendingMigrations.entries()) {
        if (controlLost) {
          throw new MigrationExecutionError("control_connection_lost", "the control connection was lost; execution aborted");
        }
        if (now() - runStartedAt > SCHEMA_RUNNER_WALL_CLOCK_MS) {
          throw new MigrationExecutionError("run_budget_exceeded", `the ${SCHEMA_RUNNER_WALL_CLOCK_MS}ms schema-runner budget expired`, pending.id);
        }

        const entry = manifest.migrations[plan.appliedCount + index];
        const bytes = await fs.readFile(path.join(migrationDirectory, entry.filename));
        const checksum = sha256(bytes);
        if (checksum !== entry.sha256) {
          throw new MigrationExecutionError("checksum_drift", "the file on disk no longer matches its verified manifest checksum", entry.id);
        }

        const context: MigrationContext = {
          entry,
          ordinal: plan.appliedCount + index + 1,
          bytes,
          checksum,
          control: lockedControl,
          execution,
          runLog,
          identity,
          handlers: registeredHandlers,
          sleep,
          now,
          destroyExecution: () => {
            destroyExecution = new MigrationExecutionError("cancellation_unverified", "the execution connection was destroyed", entry.id);
          },
        };

        let adopted = false;
        if (entry.executionMode === "legacy-verbatim") await executeLegacyVerbatim(context);
        else if (entry.executionMode === "transactional") await executeTransactional(context);
        else if (entry.executionMode === "nontransactional") adopted = await executeNontransactional(context);
        else if (entry.executionMode === "batched") await executeBatched(context);
        else throw new MigrationExecutionError("unsupported_handler", `unknown execution mode ${String(entry.executionMode)}`, entry.id);

        report.executed.push({
          id: entry.id,
          filename: entry.filename,
          executionMode: entry.executionMode,
          appliedChecksumSha256: checksum,
          adopted,
        });
        report.executedCount += 1;
      }
    } finally {
      lockedControl.removeListener("error", onControlError);
      releaseExecution(destroyExecution);
    }

    if (controlLost) {
      throw new MigrationExecutionError("control_connection_lost", "the control connection was lost; execution aborted");
    }
    return report;
  });
}

/**
 * The only production migration-execution entry point. Every security-boundary
 * input is derived internally before a database connection is acquired.
 */
export async function executeMigrations(pool: Pool): Promise<ExecutionReport> {
  if (arguments.length !== 1) {
    throw new Error("executeMigrations accepts exactly one Pool argument; alternate execution inputs are not supported");
  }
  const manifest = await checkManifest();
  return executeVerifiedMigrations(pool, manifest, identityFromEnvironment());
}
