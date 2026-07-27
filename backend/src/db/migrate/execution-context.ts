import type { PoolClient } from "pg";
import type { MigrationManifest, MigrationManifestEntry, MigrationTimeouts } from "./manifest";
import { MigrationExecutionError, assertCondition, sqlstateOf, type ErrorClass } from "./execution-errors";
import type { BatchedHandler, NontransactionalHandler } from "./execute";

/**
 * PB-10 Step 3: the execution-context primitives shared by every mode
 * (legacy-verbatim, transactional, nontransactional, batched).
 *
 * Deliberately its own narrowly scoped internal module, symmetrical with
 * supervision.ts: execute.ts imports these for its own internal use and
 * batched.ts imports them for its own internal use, but neither re-exports
 * this module's contents, and this module only ever imports *types* back
 * from execute.ts (BatchedHandler/NontransactionalHandler — erased at
 * compile time, so there is no runtime circular dependency between this
 * file, execute.ts and batched.ts).
 */

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * PB-10 Step 3 Phase 2b: monotonic clock for wall-clock deadline
 * arithmetic. Deliberately independent of context.now()/Date.now(), which
 * remain wall-clock-calendar values used only for display (duration_ms,
 * heartbeat_deadline) and are never authoritative for a timeout decision.
 */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Never clamps an exhausted or negative budget to a positive timeout. */
export function remainingBudgetMs(deadlineMs: number): number {
  return deadlineMs - monotonicMs();
}

export interface ExecutionIdentity {
  sourceGitSha: string;
  executorImageDigest: string;
  runnerId: string | null;
}

export type EventType =
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
export const METADATA_KEYS = [
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

export type EventMetadata = Partial<Record<(typeof METADATA_KEYS)[number], number | string>>;

export interface MigrationHandlers {
  nontransactional: ReadonlyMap<string, NontransactionalHandler>;
  batched: ReadonlyMap<string, BatchedHandler>;
}

export interface MigrationContext {
  entry: MigrationManifestEntry;
  ordinal: number;
  bytes: Buffer;
  checksum: string;
  control: PoolClient;
  execution: PoolClient;
  runLog: RunLog;
  identity: ExecutionIdentity;
  handlers: MigrationHandlers;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  /** Set when the execution connection must be destroyed rather than returned to the pool. */
  destroyExecution: () => void;
}

export async function applyTimeouts(client: PoolClient, timeouts: MigrationTimeouts, local: boolean): Promise<void> {
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
export class RunLog {
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

export async function insertAppliedRow(
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

/** The error's own classification when it carries one; a generic SQL failure otherwise. */
export function recordedErrorClass(error: unknown): ErrorClass {
  return error instanceof MigrationExecutionError ? error.errorClass : "sql_failed";
}

/**
 * superviseOperation/superviseCallback wrap a driver error's SQLSTATE inside
 * a MigrationExecutionError (whose own .sqlstate carries it, not .code), so
 * a bare sqlstateOf() on an already-supervised error would otherwise see
 * nothing. This looks in both places.
 */
export function errorSqlstate(error: unknown): string | null {
  return error instanceof MigrationExecutionError ? error.sqlstate : sqlstateOf(error);
}
