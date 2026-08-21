import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client, DatabaseError, type Pool, type PoolClient } from "pg";
import {
  checkManifest,
  type MigrationManifest,
  type MigrationManifestEntry,
  type MigrationTimeouts,
} from "./manifest";
import {
  GIT_SHA,
  IMAGE_DIGEST,
  SCHEMA_ADVISORY_LOCK,
  SCHEMA_LOCK_BUDGET_MS,
  SCHEMA_LOCK_POLL_MS,
  SCHEMA_LOCK_TIMEOUT_MS,
  SCHEMA_STATEMENT_TIMEOUT_MS,
  assertNoLegacyLedgerDivergence,
  buildMigrationPlan,
  readAppliedRows,
  verifyControlSchema,
  type LockDiagnostic,
  type MigrationPlan,
  type SchemaLockOptions,
} from "./runner";
import { ERROR_CLASSES, MigrationExecutionError as MigrationExecutionErrorBase, SQLSTATE, assertCondition, reportDestroyedMigrationClient, reportSanitizedPoolError, safePoolErrorCode, type ErrorClass } from "./execution-errors";

export { ERROR_CLASSES, MigrationExecutionError, type ErrorClass } from "./execution-errors";
import { batchedHandlerFor, nontransactionalHandlerFor } from "./handlers";

type DiagnosticCode = "PB10_MIGRATION_EXECUTION_FAILED" | "PB10_MIGRATION_PLAN_FAILED";
type TrustedErrorDetails = Readonly<{
  errorClass: ErrorClass;
  detail: string;
  migrationId: string | null;
  sqlstate: string | null;
}>;

const trustedExecutionErrors = new WeakMap<MigrationExecutionErrorBase, TrustedErrorDetails>();

/** Trusted construction exists only inside the execution module that knows provenance. */
class MigrationExecutionError extends MigrationExecutionErrorBase {
  constructor(errorClass: ErrorClass, detail: string, migrationId: string | null = null, sqlstate: string | null = null) {
    super(errorClass, detail, migrationId, sqlstate);
    trustedExecutionErrors.set(this, Object.freeze({ errorClass, detail, migrationId, sqlstate }));
  }
}

class SanitizedDiagnosticError extends Error {
  readonly code: DiagnosticCode;

  constructor(code: DiagnosticCode) {
    super(code === "PB10_MIGRATION_PLAN_FAILED" ? "Migration plan failed" : "Migration execution failed");
    this.name = "SanitizedDiagnosticError";
    this.code = code;
    this.stack = undefined;
  }
}

function sqlstateOf(error: unknown): string | null {
  if (!(error instanceof DatabaseError)) return null;
  const code = error.code;
  return typeof code === "string" && SQLSTATE.test(code) ? code : null;
}

function classify(error: unknown, errorClass: ErrorClass, migrationId: string, detail: string): MigrationExecutionError {
  if (error instanceof MigrationExecutionError && trustedExecutionErrors.has(error)) return error;
  return new MigrationExecutionError(errorClass, detail, migrationId, sqlstateOf(error));
}

/** Fresh, allowlist-only conversion for both public application boundaries. */
function sanitizeMigrationError(
  error: unknown,
  fallbackCode: DiagnosticCode,
  seen = new WeakSet<object>(),
): Error {
  const fallback = () => new SanitizedDiagnosticError(fallbackCode);
  try {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
      if (seen.has(error as object)) return fallback();
      seen.add(error as object);
    }
    if (error instanceof MigrationExecutionErrorBase) {
      const details = trustedExecutionErrors.get(error);
      if (!details) return fallback();
      return new MigrationExecutionErrorBase(details.errorClass, details.detail, details.migrationId, details.sqlstate);
    }
    if (error instanceof AggregateError) {
      const members = error.errors;
      if (!Array.isArray(members) || members.length > 16) return fallback();
      const sanitized = members.map((member) => sanitizeMigrationError(member, fallbackCode, seen));
      const aggregate = new AggregateError(sanitized, "Multiple migration failures occurred");
      aggregate.stack = undefined;
      return aggregate;
    }
  } catch {
    // Hostile proxies/getters, cycles and malformed known errors fail closed.
  }
  return fallback();
}

// PB-10 Step 3 Phase 2c final review: executeMigrations(pool) is the sole
// production migration-execution entry point, and — unlike the prior
// multi-file arrangement (each internal module its own separately compiled
// file with its own exported internals) — that is now a literal fact about
// the emitted build, not merely a documented convention. Every internal
// helper those files used to export is a plain, module-private declaration
// directly in this one file: never re-exported, so it never becomes a
// property of this module's own exports object, and there is no other file
// under src/db/migrate that could re-export it either. A same-process deep
// require of this compiled module gets exactly the approved public surface
// below and nothing else — no alternate executor, reconciliation function,
// independent connection acquirer, ambiguity writer, retry/FSM guard,
// applied-row writer, event writer, timeout/deadline helper, test hook,
// mutable registry, or alternate execution-boundary function is reachable
// except through executeMigrations itself. This note is deliberately a
// line-comment block, not a leading JSDoc block, so it is never preserved
// in the emitted declaration file.

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

// PB-10 Step 3 Phase 2a: the cancellation-confirmation grace period, defined
// directly here as part of the approved public surface (a line comment, not
// a leading JSDoc block, so it is never preserved in the declaration file).
export const CANCELLATION_GRACE_MS = 10_000;

const RUNNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

/** Same placeholder rejection used by every identity check in this module. */
function isObviousPlaceholder(value: string): boolean {
  const lowered = value.toLowerCase();
  return /^0+$/.test(lowered)
    || /^f+$/.test(lowered)
    || /^(?:deadbeef)+$/.test(lowered)
    || /^(?:cafebabe)+$/.test(lowered)
    || /^(?:feedface)+$/.test(lowered)
    || /^(?:decafbad)+$/.test(lowered);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ExecutionIdentity {
  sourceGitSha: string;
  executorImageDigest: string;
  runnerId: string | null;
}

/**
 * Catalog/business state of one nontransactional operation.
 *
 * PB-10 Step 3 Phase 2c, H2: `unknown` is the verifier's way of saying it
 * could not classify the state at all — distinct from `invalid` ("I looked,
 * and what is there is partial or broken"). Both block, but only `invalid`
 * asserts a durable partial effect exists, so the two are never conflated in
 * an operator diagnostic. A verifier that never returns it behaves exactly as
 * it did pre-H2.
 */
export type NontransactionalState = "absent" | "valid" | "invalid" | "unknown";

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

// ════════════════════════════════════════════════════════════════════════
// Module-private: execution-context primitives (formerly execution-context.ts)
// ════════════════════════════════════════════════════════════════════════

interface MigrationHandlers {
  nontransactional: (migrationId: string) => NontransactionalHandler | undefined;
  batched: (migrationId: string) => BatchedHandler | undefined;
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
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  /** Set when the execution connection must be destroyed rather than returned to the pool. */
  destroyExecution: () => void;
  /**
   * PB-10 Step 3 Phase 2d: registers one operation that owns the execution
   * client, so the terminal lifecycle boundary can prove — never assume — that
   * nothing is still using the session before it issues a reset statement on
   * it. Takes the promise that carries the operation's own settlement; the
   * boundary only ever *reads* whether everything registered has settled, and
   * destroys the client rather than waiting when anything has not.
   */
  noteExecutionWork: (work: Promise<unknown>) => void;
  /**
   * PB-10 Step 3 Phase 2c: acquires an independent connection outside the
   * pool's own capacity accounting (see independentControlAcquirer below —
   * blocker 3: contending for one of the pool's own, possibly as low as 2,
   * slots here can deadlock), used only as a fallback when persisting a
   * commit_outcome_unknown ambiguity marker through `control` itself fails
   * (see appendAmbiguityDurably below). Never used for anything else — in
   * particular never for reconciliation, so it grants no alternate read
   * authority beyond what `control` already has.
   */
  acquireIndependentControl: () => Promise<IndependentPoolClient>;
}

/**
 * PB-10 Step 3 Phase 2b: monotonic clock for wall-clock deadline
 * arithmetic. Deliberately independent of context.now()/Date.now(), which
 * remain wall-clock-calendar values used only for display (duration_ms,
 * heartbeat_deadline) and are never authoritative for a timeout decision.
 */
function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Never clamps an exhausted or negative budget to a positive timeout. */
function remainingBudgetMs(deadlineMs: number): number {
  return deadlineMs - monotonicMs();
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
  "checksum_sha256",
  "resolved_event_id",
  "resolved_run_id",
  "resolved_runner_id",
  "resolved_checksum_sha256",
] as const;

type EventMetadata = Partial<Record<(typeof METADATA_KEYS)[number], number | string>>;

type LedgerExtra = {
  sqlstate?: string | null;
  errorClass?: ErrorClass;
  heartbeatDeadline?: Date;
};

/** pg_current_xact_id() is an unsigned 64-bit value; node-postgres returns xid8 as text. */
const XID8 = /^[0-9]{1,20}$/;

/**
 * PB-10 Step 3 Phase 2c final review, CRITICAL 1 + CRITICAL 2: the attempt
 * claim token. 256 bits from the CSPRNG, generated when an attempt is armed
 * and held only in this process's memory; only sha256(token) is ever written
 * to the database (migration_runs.attempt_token_sha256 on the `started` row).
 *
 * It is what makes the protected proof path *this attempt's* rather than
 * merely *the execution role's*. Every one of the three privileged database
 * functions demands it, so an unrelated process — including one holding the
 * execution role's own credentials, and including migration SQL itself —
 * cannot claim a transaction for, bind a transaction to, or record commit
 * proof for an attempt it did not arm. Reading the ledger reveals the digest
 * and never the token.
 */
function generateAttemptToken(): string {
  return randomBytes(32).toString("hex");
}

function attemptTokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** INSERT-only event stream. One run id, one strictly increasing sequence. */
class RunLog {
  private sequence = 0;
  /** The live claim token per migration id, established by its `started` row. */
  private readonly tokens = new Map<string, string>();

  constructor(
    private readonly control: PoolClient,
    readonly runId: string,
    private readonly identity: ExecutionIdentity,
    private readonly manifest: MigrationManifest,
  ) {}

  get lastSequence(): number {
    return this.sequence;
  }

  /**
   * The token for an attempt this RunLog armed. Never leaves this module and
   * is never written anywhere but as a digest.
   */
  private tokenFor(migrationId: string): string {
    const token = this.tokens.get(migrationId);
    assertCondition(
      token !== undefined,
      `Migration ${migrationId} has no armed attempt; refusing to reach the protected proof path without one`,
    );
    return token;
  }

  /**
   * CRITICAL 2, half one: reads this transaction's own id from *inside* it and
   * returns an authenticated claim. Runs on the execution connection, inside
   * the open migration transaction. The transaction id is not a parameter of
   * this call at any layer — migration_control.claim_transaction reads
   * pg_current_xact_id() itself — so no caller can name a transaction other
   * than the one it is actually running in.
   */
  async claimTransaction(execution: PoolClient, migrationId: string): Promise<string> {
    const result = await execution.query<{ claim: string }>(
      "select migration_control.claim_transaction($1) as claim",
      [this.tokenFor(migrationId)],
    );
    const claim = result.rows[0]?.claim;
    assertCondition(
      typeof claim === "string" && /^[0-9]{1,20}:[0-9a-f]{64}$/.test(claim),
      `Could not claim the migration transaction for ${migrationId}`,
    );
    return claim;
  }

  /**
   * CRITICAL 2, half two: makes the claim durable, on the control connection
   * in autocommit, before any risky migration SQL runs. The database verifies
   * the claim's authenticity against a key this process cannot read, and
   * PostgreSQL's own unique indexes make a duplicate, replacement or
   * cross-attempt binding impossible rather than merely detectable.
   */
  async recordTransactionBinding(migrationId: string, claim: string): Promise<void> {
    const sequence = this.sequence + 1;
    await this.control.query("select migration_control.record_transaction_binding($1, $2, $3)", [
      this.tokenFor(migrationId),
      sequence,
      claim,
    ]);
    this.sequence = sequence;
  }

  /**
   * PB-10 Step 3 Phase 2c final review, CRITICAL: the only path to an H2
   * progress marker. The execution role holds no INSERT privilege on
   * migration_runs.statement_ordinal, so a marker cannot come into existence
   * any other way, and migration_control.record_progress_marker demands this
   * attempt's claim token, copies every identity field from its own `started`
   * row, and enforces the marker lifecycle (1 before 2, each at most once) in
   * the database.
   *
   * Always on the control connection, in autocommit: the marker is durable
   * before the operation it describes is dispatched, and it survives the loss
   * of the execution connection. A failure here throws, so payload SQL is never
   * reached with the marker unpersisted.
   */
  async recordProgressMarker(migrationId: string, ordinal: number): Promise<void> {
    const sequence = this.sequence + 1;
    await this.control.query("select migration_control.record_progress_marker($1, $2, $3)", [
      this.tokenFor(migrationId),
      sequence,
      ordinal,
    ]);
    this.sequence = sequence;
  }

  /**
   * CRITICAL 1: the only path to an applied-ledger row. The execution role has
   * no INSERT privilege on migration_control.schema_migrations, so this call
   * is the sole way one can come into existence, and the database — not this
   * process — decides whether the row records atomic commit proof. Returns the
   * `commit_proof` value it recorded.
   *
   * For a transactional migration this must be issued on the *execution*
   * connection inside the bound transaction: the function refuses unless
   * pg_current_xact_id() equals the attempt's already durable binding, which
   * is what makes the row inseparable from that transaction's COMMIT. Other
   * modes have no such transaction and their row is recorded as
   * post_hoc_verified, which is never transaction-outcome evidence.
   *
   * It deliberately writes no ledger event and consumes no event_sequence: in
   * transactional mode this runs inside the migration transaction, where a
   * ROLLBACK would discard the sequence number and leave a permanent gap in
   * the run's stream. The `applied_committed` label is appended afterwards
   * through the ordinary path.
   */
  async recordApplied(client: PoolClient, entry: MigrationManifestEntry): Promise<string> {
    const result = await client.query<{ commit_proof: string }>(
      "select migration_control.record_applied_migration($1, $2, $3, $4::text[]) as commit_proof",
      [
        this.tokenFor(entry.id),
        entry.sha256,
        entry.lifecyclePhase,
        entry.operationCategories,
      ],
    );
    const proof = result.rows[0]?.commit_proof;
    assertCondition(
      proof === "transaction_atomic" || proof === "post_hoc_verified",
      `Refusing an unrecognised commit-proof classification for ${entry.id}`,
    );
    return proof;
  }

  async append(
    migrationId: string,
    eventType: EventType,
    metadata: EventMetadata = {},
    extra: LedgerExtra = {},
  ): Promise<void> {
    return this.appendVia(this.control, migrationId, eventType, metadata, extra);
  }

  /**
   * PB-10 Step 3 Phase 2c: identical to append(), but against a caller-supplied
   * connection rather than the control connection this RunLog was constructed
   * with. Exists only for appendAmbiguityDurably's fallback path below — the
   * sequence counter still lives on this one RunLog instance either way, so
   * event_sequence stays gapless and strictly increasing regardless of which
   * physical connection actually carried a given INSERT.
   *
   * The candidate sequence number is committed to `this.sequence` only once
   * the INSERT is confirmed to have succeeded. If the primary attempt's own
   * INSERT throws (the exact case appendAmbiguityDurably's fallback exists
   * for), the counter is left untouched, so the fallback's retry claims the
   * *same* candidate number rather than skipping past it — advancing the
   * counter unconditionally beforehand would create a permanent gap at
   * exactly the number the failed attempt never actually persisted. The
   * unique (run_id, event_sequence) constraint on migration_runs also rules
   * out the opposite risk: if a "failed" attempt's INSERT actually landed
   * server-side and only its acknowledgement was lost, a retry reusing the
   * same number is rejected as a duplicate rather than double-inserted.
   */
  async appendVia(
    client: PoolClient,
    migrationId: string,
    eventType: EventType,
    metadata: EventMetadata = {},
    extra: LedgerExtra = {},
  ): Promise<void> {
    const ordinal = this.manifest.migrations.findIndex(({ id }) => id === migrationId) + 1;
    const entry = this.manifest.migrations[ordinal - 1];
    assertCondition(entry?.id === migrationId, `Migration ${migrationId} is not present in the verified manifest`);
    // PB-10 Step 3 Phase 2c final review, CRITICAL 2: checksum_sha256 is
    // stamped here, on *every* event of *every* execution mode, from the
    // verified manifest — not passed in per call site, where four modes drifted
    // into three different answers and later events could omit it entirely and
    // still correlate. executeVerifiedMigrations refuses to execute a file
    // whose bytes do not hash to entry.sha256 (checksum_drift), so this is the
    // checksum of the bytes this run actually executes, and a caller may not
    // contradict it.
    assertCondition(
      metadata.checksum_sha256 === undefined || metadata.checksum_sha256 === entry.sha256,
      `Refusing to record a checksum for ${migrationId} that contradicts the verified manifest`,
    );
    const persistedMetadata: EventMetadata = {
      ...metadata,
      migration_filename: entry.filename,
      migration_ordinal: ordinal,
      checksum_sha256: entry.sha256,
    };
    // CRITICAL 2: a transaction binding is never written through this path at
    // all. The execution role holds only column-level INSERT on
    // migration_runs, deliberately excluding xact_id, so PostgreSQL itself
    // refuses any INSERT here that so much as names that column — the binding
    // exists only as the output of
    // migration_control.record_transaction_binding.
    const armed = eventType === "started" ? generateAttemptToken() : undefined;
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
    const sequence = this.sequence + 1;
    // PB-10 Step 3 Phase 2c final review, CRITICAL: statement_ordinal is
    // deliberately absent from this INSERT, exactly as xact_id is. It is the H2
    // progress marker and therefore replay-authorizing evidence, so the
    // execution role holds no INSERT privilege on it and PostgreSQL refuses any
    // statement from this role that names it — even as NULL. Markers are
    // written only by recordProgressMarker below.
    await client.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, heartbeat_deadline,
          source_git_sha, executor_image_digest, sqlstate, error_class, metadata,
          attempt_token_sha256)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [
        this.runId,
        migrationId,
        sequence,
        eventType,
        this.identity.runnerId,
        extra.heartbeatDeadline ?? null,
        this.identity.sourceGitSha,
        this.identity.executorImageDigest,
        extra.sqlstate ?? null,
        extra.errorClass ?? null,
        JSON.stringify(persistedMetadata),
        armed === undefined ? null : attemptTokenDigest(armed),
      ],
    );
    this.sequence = sequence;
    // Retained only once the arming INSERT is confirmed: a token for an
    // attempt that does not exist in the database would let every later
    // protected call fail in a confusing way instead of failing here.
    if (armed !== undefined) this.tokens.set(migrationId, armed);
  }
}

type LedgerEventRow = {
  event_id: number;
  run_id: string;
  migration_id: string;
  event_sequence: number;
  event_type: string;
  error_class: string | null;
  sqlstate: string | null;
  runner_id: string | null;
  source_git_sha: string | null;
  executor_image_digest: string | null;
  metadata: unknown;
  /** The transaction-outcome binding; non-null on exactly one event per bound attempt. */
  xact_id: string | null;
  /**
   * PB-10 Step 3 Phase 2c, H2: 1 on the durable-work marker (see
   * WORK_STARTED_ORDINAL), null on every other row this executor writes.
   */
  statement_ordinal: number | null;
};

/**
 * PB-10 Step 3 Phase 2c, H2 — the two progress markers.
 *
 * PB-10 Step 3 Phase 2c final review, CRITICAL — where these markers get their
 * authority. They are *not* ordinary ledger rows the execution role can write.
 * The execution role holds no INSERT privilege on
 * migration_runs.statement_ordinal at all (control-grants.sql), so PostgreSQL
 * refuses any statement from it that names the column; the sole writer is
 * migration_control.record_progress_marker, a SECURITY DEFINER function owned
 * by migration_control_owner which demands the attempt's claim token, copies
 * every identity field from that attempt's own `started` row, and enforces the
 * lifecycle (marker 1 only after `started`, marker 2 only after marker 1, each
 * at most once — mr_one_marker_per_attempt) in the database. mr_marker_ck pins
 * the shape so no other event type can impersonate one. A marker is therefore
 * database-authenticated, attempt-bound, unique and durably ordered, which is
 * exactly what it must be before it may permit SAFE_TO_RETRY. The previous
 * generation reused ordinary heartbeat rows the execution role could insert
 * directly, which meant the role whose replay the markers authorized could
 * manufacture the evidence that authorized it.
 *
 * `ATTEMPT_ARMED_ORDINAL` is written immediately after the `started` row by
 * every H2-capable executor, in every mode that has no transaction to bind. It
 * carries no information about the migration; its only job is to prove *who
 * wrote this attempt*. Without it, the absence of the durable-work marker
 * below would be ambiguous in exactly the dangerous direction: every attempt
 * written before H2 existed also has no durable-work marker, and reading that
 * silence as "no statement was ever issued" would offer an automatic replay of
 * a historical attempt that may well have applied half a migration. So an
 * attempt with no armed marker is treated as it was pre-H2 — the ledger proves
 * nothing about its progress, and only a verifier can speak for it.
 *
 * Stage 2's whole operational gain rests on being able to prove, from the
 * ledger alone, that an attempt died *before* it could issue anything with a
 * durable effect. Nothing in the pre-H2 event stream could establish that: an
 * attempt that died between its `started` row and its first statement wrote
 * exactly the same rows as one that died halfway through that statement, so
 * the honest verdict for both was "blocked".
 *
 * So every mode with no transaction to bind — nontransactional,
 * legacy-verbatim and batched — commits one extra row on the *control*
 * connection (autocommit, therefore durable regardless of what the execution
 * connection later does) immediately before it issues its first potentially
 * durable operation: the nontransactional/legacy payload, or a batched
 * attempt's first `begin`. It is an ordinary `heartbeat` event carrying
 * `statement_ordinal = 1` — no schema change, no new event type and no new
 * metadata key, so a pre-H2 installation and an upgraded one accept it
 * identically, and a historical row (which never carries it) simply reads as
 * "may have done durable work", exactly the conservative pre-H2 answer.
 *
 * The one other row this executor writes as a `heartbeat` is the transaction
 * binding, which the protected function writes with `statement_ordinal` null,
 * so none of the three can be confused for one another.
 */
const ATTEMPT_ARMED_ORDINAL = 1;
const WORK_STARTED_ORDINAL = 2;

function isMarker(event: LedgerEventRow, ordinal: number): boolean {
  return event.event_type === "heartbeat" && event.statement_ordinal === ordinal;
}

/**
 * Progress this attempt's own writer proved, from the ledger alone.
 *
 * - `unprovable` — no armed marker: written by an executor that did not record
 *   progress at all (every attempt predating H2). Never a safe-retry licence.
 * - `no-durable-work` — armed, and the durable-work marker is absent, so the
 *   attempt provably died before issuing anything with an effect.
 * - `durable-work-began` — the attempt reached the point of issuing durable
 *   work; what landed is a question only a mode verifier can answer.
 * - `conflicting` — a marker history the protected writer cannot produce: a
 *   duplicate of either marker, or marker 2 without marker 1. The database
 *   already makes both impossible (mr_one_marker_per_attempt and the ordering
 *   check in record_progress_marker), so reaching here means the ledger is not
 *   the one this executor believes it is. Read as evidence of nothing, never as
 *   permission — the callers treat it exactly as they treat malformed history.
 */
type AttemptProgress = "unprovable" | "no-durable-work" | "durable-work-began" | "conflicting";

function attemptProgress(events: readonly LedgerEventRow[]): AttemptProgress {
  const armed = events.filter((event) => isMarker(event, ATTEMPT_ARMED_ORDINAL)).length;
  const working = events.filter((event) => isMarker(event, WORK_STARTED_ORDINAL)).length;
  if (armed > 1 || working > 1) return "conflicting";
  if (armed === 0) return working === 0 ? "unprovable" : "conflicting";
  return working === 1 ? "durable-work-began" : "no-durable-work";
}

/** The ledger's whole permitted metadata vocabulary, as mr_metadata_ck defines it. */
const LEDGER_METADATA_KEYS = new Set<string>(METADATA_KEYS);

/**
 * Exactly the metadata keys a `started` row may carry. `batch_number` is
 * deliberately *not* one of them: see the batch identity model on
 * eventBelongsToAttempt.
 */
const ARMED_METADATA_KEYS = new Set(["execution_mode", "checksum_sha256", "migration_filename", "migration_ordinal"]);
const RESOLUTION_METADATA_KEYS = new Set([
  "migration_filename",
  "migration_ordinal",
  "execution_mode",
  "reclaim_reason",
  "checksum_sha256",
  "resolved_event_id",
  "resolved_run_id",
  "resolved_runner_id",
  "resolved_checksum_sha256",
]);

// ════════════════════════════════════════════════════════════════════════
// PB-10 Step 3 Phase 2c final review: one canonical immutable attempt
// identity, one correlation function, one history evaluator.
//
// The previous evaluator correlated events with a *subset* of the ledger's
// immutable fields (run id, mode, filename, ordinal) and spread slightly
// different comparisons across three functions, so an event that agreed on
// that subset while contradicting the attempt's runner identity, build
// identity or checksum was still accepted as speaking for it. Everything
// below correlates through AttemptIdentity and nothing else.
// ════════════════════════════════════════════════════════════════════════

/**
 * The immutable identity of one migration attempt, established *once* by its
 * `started` row and never altered by any later event. Every field here is
 * written by RunLog onto every event of that run (identity columns) or
 * stamped from the verified manifest at write time (metadata), so a later
 * event that disagrees on any of them is not a later event *of this attempt*
 * — it is malformed history.
 *
 * PB-10 Step 3 Phase 2c final review, CRITICAL 2 — the batch identity model,
 * stated explicitly rather than implied: **the top-level migration attempt is
 * the unit of replay blocking, and batch identity is not part of this
 * identity.** A batched migration's batches commit on independent transaction
 * boundaries, so no single batch's outcome can ever speak for the migration;
 * `batch_number` is a within-attempt operation identifier carried by
 * batch-scoped events only (see eventBelongsToAttempt, which validates it and
 * refuses it on a `started` row or on a non-batched attempt), and no batch
 * event can resolve the attempt (see terminalProof: batched mode has no
 * rollback proof at all). A manual resolution names the attempt, never a
 * batch — RESOLUTION_METADATA_KEYS excludes `batch_number` outright, so a
 * resolution carrying one is refused.
 */
type AttemptIdentity = {
  startedEventId: number;
  runId: string;
  /** Null only on historical rows written before a runner id was guaranteed. */
  runnerId: string | null;
  migrationId: string;
  filename: string;
  ordinal: number;
  executionMode: string;
  /** Null only on historical rows written before checksum metadata existed. */
  checksum: string | null;
  sourceGitSha: string;
  executorImageDigest: string;
};

/**
 * Row quality, decided conservatively and never widened later:
 *
 * - `complete_modern` — every immutable field manual recovery correlates
 *   against is present. Everything written under the currently documented
 *   configuration is complete (see identityFromEnvironment).
 * - `legacy_provable` — the attempt predates a field, *and* immutable
 *   evidence already in the database proves the missing value exactly (see
 *   provenChecksumFor). Normal recovery is allowed only against that proof.
 * - `legacy_unprovable` — predates a field and nothing in the database can
 *   prove it. Replay stays blocked and normal stale_reclaimed resolution is
 *   refused; the operator procedure in db/README.md applies.
 * - `malformed_or_conflicting` — contradictory, incomplete or unorderable
 *   history. Replay stays blocked and nothing can clear it.
 */
type AttemptCategory = "complete_modern" | "legacy_provable" | "legacy_unprovable" | "malformed_or_conflicting";

type AttemptState = {
  identity: AttemptIdentity;
  /** Every row of this attempt, in event_id order. */
  events: LedgerEventRow[];
  /** True once a commit_outcome_unknown strengthens the attempt's state. It never alters `identity`. */
  ambiguous: boolean;
  /** Set once, never cleared: a short machine-readable reason, safe to surface. */
  malformed: string | null;
  category: AttemptCategory;
  /** identity.checksum, or a checksum proven from immutable database evidence. */
  provenChecksum: string | null;
  resolved: boolean;
  /**
   * H2: *how* Stage 1 resolved this attempt, so the central gate can report a
   * DEFINITIVELY_APPLIED / DEFINITIVELY_NOT_COMMITTED verdict rather than a
   * bare boolean. Never widened by Stage 2 — a mode evaluator can only ever
   * classify an attempt Stage 1 left `unresolved`.
   */
  resolution: "unresolved" | "applied" | "not_committed" | "manual";
};

/** Machine-readable, credential-free diagnostic for one blocked attempt. */
type BlockedAttempt = { eventId: number; runId: string; category: AttemptCategory; reason: string };

function metadataOf(row: LedgerEventRow): Record<string, unknown> | null {
  return isRecord(row.metadata) ? row.metadata : null;
}

function validSourceSha(value: string | null): boolean {
  return GIT_SHA.test(value ?? "") && !isObviousPlaceholder(value ?? "");
}

function validImageDigest(value: string | null): boolean {
  return IMAGE_DIGEST.test(value ?? "") && !isObviousPlaceholder((value ?? "").slice("sha256:".length));
}

/**
 * Derives the canonical identity a `started` row establishes, or null when the
 * row cannot establish one at all. `entry`/`ordinal`/`checksum` describe the
 * migration *currently* being attempted and are used only to confirm this row
 * concerns it — every later comparison is against the returned identity's own
 * recorded values, never against the current migration.
 *
 * A *present* checksum that disagrees with the current migration's bytes is a
 * conflict, not a match: that attempt ran different bytes. A wholly *absent*
 * checksum is a legacy row — and is never silently filled in from the current
 * file (see provenChecksumFor).
 */
function identityFromStartedRow(
  row: LedgerEventRow,
  entry: MigrationManifestEntry,
  ordinal: number,
  checksum: string,
): AttemptIdentity | null {
  if (typeof row.event_id !== "number" || !Number.isSafeInteger(row.event_id) || row.event_id <= 0) return null;
  if (!UUID.test(row.run_id)) return null;
  if (row.migration_id !== entry.id) return null;
  if (!validSourceSha(row.source_git_sha)) return null;
  if (!validImageDigest(row.executor_image_digest)) return null;
  if (row.runner_id !== null && !RUNNER_ID.test(row.runner_id)) return null;
  const metadata = metadataOf(row);
  if (metadata === null) return null;
  for (const key of Object.keys(metadata)) {
    if (!ARMED_METADATA_KEYS.has(key)) return null;
  }
  if (metadata.execution_mode !== entry.executionMode) return null;
  if (metadata.migration_filename !== entry.filename) return null;
  if (metadata.migration_ordinal !== ordinal) return null;
  const recorded = metadata.checksum_sha256;
  if (recorded !== undefined && recorded !== checksum) return null;
  return {
    startedEventId: row.event_id,
    runId: row.run_id,
    runnerId: row.runner_id,
    migrationId: row.migration_id,
    filename: entry.filename,
    ordinal,
    executionMode: entry.executionMode,
    checksum: typeof recorded === "string" ? recorded : null,
    sourceGitSha: row.source_git_sha!,
    executorImageDigest: row.executor_image_digest!,
  };
}

/** Two `started` rows conflict unless every immutable field is identical. */
function identitiesAgree(a: AttemptIdentity, b: AttemptIdentity): boolean {
  return a.runId === b.runId
    && a.runnerId === b.runnerId
    && a.migrationId === b.migrationId
    && a.filename === b.filename
    && a.ordinal === b.ordinal
    && a.executionMode === b.executionMode
    && a.checksum === b.checksum
    && a.sourceGitSha === b.sourceGitSha
    && a.executorImageDigest === b.executorImageDigest;
}

/**
 * THE correlation function. A later event speaks for an attempt only when
 * every immutable field the ledger stamps on every event matches exactly, and
 * any optional field the event *does* carry matches too. Matching run id
 * alone, or filename alone, is never sufficient; a missing required field and
 * a conflicting field both fail closed identically.
 */
function eventBelongsToAttempt(event: LedgerEventRow, identity: AttemptIdentity): boolean {
  if (event.run_id !== identity.runId) return false;
  if (event.migration_id !== identity.migrationId) return false;
  if (event.runner_id !== identity.runnerId) return false;
  if (event.source_git_sha !== identity.sourceGitSha) return false;
  if (event.executor_image_digest !== identity.executorImageDigest) return false;
  const metadata = metadataOf(event);
  if (metadata === null) return false;
  // The ledger's own permitted metadata vocabulary (mr_metadata_ck enforces
  // exactly this set at the database layer). A key outside it cannot have
  // been written by RunLog through a conforming database, so the row is not
  // a trustworthy statement about this attempt.
  for (const key of Object.keys(metadata)) {
    if (!LEDGER_METADATA_KEYS.has(key)) return false;
  }
  if (metadata.execution_mode !== identity.executionMode) return false;
  if (metadata.migration_filename !== identity.filename) return false;
  if (metadata.migration_ordinal !== identity.ordinal) return false;
  // CRITICAL 2: required, not optional. RunLog stamps checksum_sha256 on every
  // event of every mode, so a *modern* attempt's own later event always
  // carries it: one that omits it, or carries a different one, is not a later
  // event of this attempt. (A legacy attempt whose `started` row predates
  // checksum metadata has identity.checksum === null; a checksum appearing on
  // one of its later events is then neither correlated nor evidence — HIGH 1
  // removed that as a proof source entirely, see provenChecksumFor.)
  if (identity.checksum !== null && metadata.checksum_sha256 !== identity.checksum) return false;
  // Batch identity (see AttemptIdentity): a within-attempt operation
  // identifier, valid only on a batched attempt's non-`started` events.
  if (metadata.batch_number !== undefined) {
    if (identity.executionMode !== "batched") return false;
    if (event.event_type === "started") return false;
    if (typeof metadata.batch_number !== "number"
      || !Number.isSafeInteger(metadata.batch_number)
      || metadata.batch_number < 1) return false;
  }
  // Only the transaction-binding event may carry a binding, and it must be a
  // well-formed xid8 (mr_xact_ck enforces the event type at the database layer;
  // this refuses a syntactically impossible value too).
  if (event.xact_id !== null && (event.event_type !== "heartbeat" || !XID8.test(event.xact_id))) return false;
  return true;
}

/**
 * PB-10 Step 3 Phase 2c final review, CRITICAL 1 — the root problem the
 * previous evaluator never solved: **two agreeing ledger labels are not proof
 * of a transaction outcome.** migration_runs is INSERT-only, but it is not
 * insert-*proof*: a user, a damaged writer, a buggy process, historical
 * corruption or one hand-written INSERT can produce `applied_committed`,
 * `transaction_rolled_back`, `succeeded`, `execution_failed`, a matching
 * error_class and a matching SQLSTATE. Correlating two such rows proves only
 * that their fields agree. It never proves PostgreSQL committed or rolled
 * anything back, and the previous evaluator's acceptance of exactly that is
 * what let a fabricated predecessor clear an armed attempt.
 *
 * So terminal evidence is now anchored to two things outside the ledger's
 * label vocabulary, neither of which a hand-written event row can move:
 *
 * 1. **Commit proof — the immutable applied-ledger row.**
 *    migration_control.schema_migrations is INSERT-only *and*
 *    UPDATE/DELETE/TRUNCATE-proof (reject_ledger_mutation), migration_id is
 *    its primary key, and in transactional mode that row is written *inside
 *    the migration's own transaction*. Its existence for this exact attempt
 *    (run_id, ordinal, filename, mode, source git sha, image digest, applied
 *    checksum — see appliedProofFor) is therefore a PostgreSQL-enforced
 *    consequence of COMMIT, not a claim about it. Note what this means in
 *    practice: this evaluator only ever runs for a *pending* migration, and a
 *    migration with an applied row is not pending — so a `succeeded` label
 *    reaching here without that row is, by construction, a history that
 *    contradicts the database, and blocks.
 *
 * 2. **Non-commit proof — PostgreSQL's own verdict on the real transaction.**
 *    Before COMMIT is ever sent, the executor reads the migration
 *    transaction's full 64-bit id from *inside* that transaction
 *    (pg_current_xact_id) and commits it to the ledger on the control
 *    connection as this attempt's one transaction binding (see
 *    bindTransactionOutcome). Clearing then requires pg_xact_status() on that
 *    exact xid8 to report 'aborted' — PostgreSQL's answer, which no inserted
 *    row can alter. Forging is not merely hard, it is pointless: an attempt
 *    whose transaction actually committed reports 'committed' however many
 *    rollback rows are inserted; an attempt with no binding, a duplicate
 *    binding, a binding reused by another attempt, or a status of
 *    'in progress'/NULL/unreadable has *no* proof and stays blocked forever.
 *
 * Consequently a whole mode has no rollback proof and is deliberately fail
 * closed rather than label-trusting:
 *
 * - `transactional` — bound, so an ordinary failed migration still retries
 *   automatically once PostgreSQL confirms the transaction aborted.
 * - `legacy-verbatim` — the payload carries its own BEGIN/COMMIT, so there is
 *   no transaction this runner can bind and no artifact written atomically
 *   with it. Nothing in the database can prove what it did: blocked until an
 *   operator records a resolution.
 * - `nontransactional` — no transaction exists to abort; the verifier, not
 *   the ledger, is the authority, and recovery is verifier-led.
 * - `batched` — batches commit on independent boundaries, so an aborted
 *   final batch says nothing about the batches that already landed. No batch
 *   event can clear the attempt.
 *
 * `verification_failed` remains deliberately non-terminal: a batched
 * completion verifier runs *after* batches have already committed, so it
 * proves nothing about what landed. `applied_committed` on its own,
 * heartbeats, operation_completed and unknown types are not terminal either.
 */
const ROLLBACK_PROVABLE_CLASSES = new Set<string>(["sql_failed", "wall_clock_exceeded"]);

/** The one immutable applied-ledger row for a migration, as read from the database. */
type AppliedArtifact = {
  runId: string;
  ordinal: number;
  filename: string;
  checksum: string;
  executionMode: string;
  sourceGitSha: string;
  executorImageDigest: string;
  /**
   * CRITICAL 1: how the database itself classified this row's provenance —
   * decided by migration_control.record_applied_migration, which is the only
   * writer of this table (the execution role holds no INSERT privilege on
   * it). 'transaction_atomic' is the only value that means "written from
   * inside the exact bound migration transaction, so it exists if and only if
   * that transaction committed".
   */
  commitProof: string;
};

/**
 * Everything authoritative about outcomes that does *not* come from an event
 * label, gathered once per evaluation.
 */
type OutcomeEvidence = {
  /** The migration's single applied-ledger row, absent, or unusable/contradictory. */
  applied: AppliedArtifact | null | "conflict";
  /** PostgreSQL's verdict per bound xid8: 'committed' | 'aborted' | 'in progress' | null. */
  xactStatus: ReadonlyMap<string, string | null>;
  /** Bindings that appear more than once anywhere in the history: proof for nobody. */
  reusedXactIds: ReadonlySet<string>;
};

/**
 * HIGH 1 / CRITICAL 1: the applied-ledger row, accepted as this attempt's
 * commit proof only when every provenance field it carries is exactly this
 * attempt's own. Same migration *name* is never enough — the row must name
 * this run, this ordinal, this filename, this execution mode, this source git
 * sha and this executor image digest. Anything ambiguous fails closed.
 */
function appliedProofFor(attempt: AttemptState, evidence: OutcomeEvidence): AppliedArtifact | null {
  const applied = evidence.applied;
  if (applied === null || applied === "conflict") return null;
  const { identity } = attempt;
  if (applied.runId !== identity.runId) return null;
  if (applied.ordinal !== identity.ordinal) return null;
  if (applied.filename !== identity.filename) return null;
  if (applied.executionMode !== identity.executionMode) return null;
  if (applied.sourceGitSha !== identity.sourceGitSha) return null;
  if (applied.executorImageDigest !== identity.executorImageDigest) return null;
  if (!SHA256.test(applied.checksum)) return null;
  return applied;
}

/**
 * CRITICAL 1: this attempt's one transaction binding, or null when it has no
 * usable one. Exactly one correlated binding is required — zero, two, or one
 * whose xid8 any other event anywhere also bound, all yield no proof.
 */
function bindingFor(attempt: AttemptState, evidence: OutcomeEvidence): LedgerEventRow | null {
  const bindings = attempt.events.filter((event) => event.xact_id !== null
    && eventBelongsToAttempt(event, attempt.identity));
  if (bindings.length !== 1) return null;
  const [binding] = bindings;
  if (binding.xact_id === null || evidence.reusedXactIds.has(binding.xact_id)) return null;
  return binding;
}

/**
 * H2: unchanged proof rules, reported as *which* proof was found rather than
 * as a boolean — "applied" is the DEFINITIVELY_APPLIED verdict and
 * "not_committed" the DEFINITIVELY_NOT_COMMITTED one. Null means no terminal
 * proof, which is what makes an attempt eligible for Stage 2 (and never, by
 * itself, safe).
 */
function terminalProof(
  event: LedgerEventRow,
  attempt: AttemptState,
  evidence: OutcomeEvidence,
): "applied" | "not_committed" | null {
  if (!eventBelongsToAttempt(event, attempt.identity)) return null;
  const earlier = attempt.events.filter(({ event_id }) => event_id < event.event_id);

  if (event.event_type === "succeeded") {
    // Writer shape *and* the immutable artifact the writer could only have
    // produced by committing. The artifact's checksum must be the attempt's
    // own proven checksum, so a row recording different bytes proves nothing.
    if (!earlier.some((candidate) => candidate.event_type === "applied_committed"
      && eventBelongsToAttempt(candidate, attempt.identity))) return null;
    const proof = appliedProofFor(attempt, evidence);
    if (proof === null || attempt.provenChecksum === null || proof.checksum !== attempt.provenChecksum) return null;
    // CRITICAL 1: a transactional attempt's applied row is commit proof only
    // when the database itself recorded it as written from inside the exact
    // bound migration transaction. A 'post_hoc_verified' row for a
    // transactional attempt is a contradiction the schema already forbids;
    // refused here too rather than trusted.
    if (attempt.identity.executionMode === "transactional" && proof.commitProof !== "transaction_atomic") return null;
    return "applied";
  }

  if (event.event_type !== "execution_failed") return null;
  if (event.error_class === null || !ROLLBACK_PROVABLE_CLASSES.has(event.error_class)) return null;
  // The writer emits transaction_rolled_back only once ROLLBACK itself
  // succeeded — necessary, but by itself only a label, so it is required *and*
  // subordinate to PostgreSQL's verdict below.
  const rollback = earlier.find((candidate) => candidate.event_type === "transaction_rolled_back"
    && candidate.error_class === event.error_class
    && candidate.sqlstate === event.sqlstate
    && eventBelongsToAttempt(candidate, attempt.identity));
  if (rollback === undefined) return null;

  const binding = bindingFor(attempt, evidence);
  // The binding is written after BEGIN and before anything can fail, so a
  // binding that appears *after* the rollback it supposedly covers is not this
  // transaction's binding.
  if (binding === null || binding.event_id >= rollback.event_id) return null;
  if (evidence.xactStatus.get(binding.xact_id!) !== "aborted") return null;
  // A transaction PostgreSQL says aborted cannot have written an applied row;
  // if one exists for this attempt the history contradicts the database.
  return appliedProofFor(attempt, evidence) === null ? "not_committed" : null;
}

/**
 * PB-10 Step 3 Phase 2c final review, PART 5/6: a manual resolution must name
 * the *target* attempt exactly — including the runner identity persisted on
 * that attempt (`resolved_runner_id`), which is a different thing from the
 * `runner_id` column identifying whoever authored the resolution. The author
 * identity is required (an unattributable resolution is refused) but never
 * substitutes for the target identity.
 *
 * The checksum compared is the attempt's own — its recorded one, or, for a
 * legacy row, one proven from immutable database evidence. The current
 * migration file's bytes are never accepted as evidence of what a historical
 * run executed, so an attempt whose checksum cannot be proven is not
 * resolvable through this path at all.
 */
function isValidResolution(event: LedgerEventRow, attempt: AttemptState): boolean {
  if (attempt.malformed !== null) return false;
  if (attempt.category === "legacy_unprovable") return false;
  if (attempt.provenChecksum === null) return false;
  if (attempt.identity.runnerId === null) return false;

  if (event.event_type !== "stale_reclaimed") return false;
  if (!UUID.test(event.run_id)) return false;
  if (event.migration_id !== attempt.identity.migrationId) return false;
  if (!validSourceSha(event.source_git_sha)) return false;
  if (!validImageDigest(event.executor_image_digest)) return false;
  // Author identity: a resolution with no accountable actor clears nothing.
  if (!event.runner_id || !RUNNER_ID.test(event.runner_id)) return false;
  const metadata = metadataOf(event);
  if (metadata === null) return false;
  for (const key of Object.keys(metadata)) {
    if (!RESOLUTION_METADATA_KEYS.has(key)) return false;
  }
  if (typeof metadata.reclaim_reason !== "string" || metadata.reclaim_reason.length === 0) return false;

  // The build identity that produced the ambiguous run.
  if (event.source_git_sha !== attempt.identity.sourceGitSha) return false;
  if (event.executor_image_digest !== attempt.identity.executorImageDigest) return false;

  // Exact target correlation, every field against the attempt's own values.
  if (metadata.migration_filename !== attempt.identity.filename) return false;
  if (metadata.migration_ordinal !== attempt.identity.ordinal) return false;
  if (metadata.execution_mode !== attempt.identity.executionMode) return false;
  if (metadata.checksum_sha256 !== attempt.provenChecksum) return false;
  if (metadata.resolved_event_id !== attempt.identity.startedEventId) return false;
  if (metadata.resolved_run_id !== attempt.identity.runId) return false;
  if (metadata.resolved_runner_id !== attempt.identity.runnerId) return false;
  if (metadata.resolved_checksum_sha256 !== attempt.provenChecksum) return false;
  return true;
}

/**
 * PB-10 Step 3 Phase 2c final review, HIGH 1: the *only* accepted proof of the
 * bytes a historical attempt executed, for a `started` row written before
 * checksum_sha256 metadata existed.
 *
 * What was removed and why: this previously accepted `checksum_sha256` from
 * any correlated later event of the attempt. A later event is exactly what an
 * untrusted writer can insert, so that let a hand-written row retroactively
 * become proof of historical migration bytes. Correlation qualifies a row as
 * *addressed to* an attempt; it never qualifies it as *provenance*.
 *
 * The one qualifying source is the immutable applied-ledger row — the only
 * artifact in this schema that is both UPDATE/DELETE/TRUNCATE-proof and
 * produced as a database-enforced consequence of the historical attempt's own
 * committed operation, and only when every provenance field it carries is that
 * attempt's own (appliedProofFor: exact run id, ordinal, filename, execution
 * mode, source git sha, executor image digest). Its
 * applied_checksum_sha256 is the checksum that run actually applied.
 *
 * Absent, ambiguous, contradictory or not provenance-matched: the attempt is
 * `legacy_unprovable`, replay stays blocked, and the current working tree's
 * checksum is never substituted for what history executed.
 */
function provenChecksumFor(attempt: AttemptState, evidence: OutcomeEvidence): string | null | "conflict" {
  // More than one applied row for this migration, or an unusable one: ambiguous
  // evidence is never evidence.
  if (evidence.applied === "conflict") return "conflict";
  const proof = appliedProofFor(attempt, evidence);
  return proof === null ? null : proof.checksum;
}

/**
 * PB-10 Step 3 Phase 2c final review, PART 2: the ledger's actual ordering
 * contract, enforced exactly as written rather than assumed.
 *
 * `event_id` (bigserial) is the authoritative arrival order and the query
 * below orders by it. `event_sequence` is per *run*, not per migration: one
 * invocation of executeMigrations(pool) uses one run id across every
 * migration it touches, and RunLog is its single writer, advancing the
 * counter only once an INSERT is confirmed. migration_runs is INSERT-only
 * (reject_ledger_mutation forbids UPDATE and DELETE) and carries
 * unique (run_id, event_sequence). So a run's rows are contiguous 1..N with
 * no gaps and no duplicates — a *guarantee of the schema and the writer*, not
 * an assumption — and any deviation means rows are missing, reordered or
 * forged, either of which could hide the evidence that changes the verdict.
 *
 * This is why every row of every run that touched this migration is fetched,
 * not merely the rows of this migration: a gap in a run's stream is only
 * visible against the whole stream, and a run legitimately interleaves
 * several migrations' events.
 */
function runsWithBrokenOrdering(rows: readonly LedgerEventRow[]): Map<string, string> {
  const streams = new Map<string, LedgerEventRow[]>();
  const broken = new Map<string, string>();
  for (const row of rows) {
    if (!UUID.test(row.run_id)) continue;
    const stream = streams.get(row.run_id) ?? [];
    stream.push(row);
    streams.set(row.run_id, stream);
  }
  for (const [runId, stream] of streams) {
    const seen = new Set<number>();
    let expected = 1;
    let previousEventId = 0;
    for (const row of stream) {
      if (row.event_id <= previousEventId) {
        broken.set(runId, "event_ids_not_increasing");
        break;
      }
      previousEventId = row.event_id;
      if (!Number.isSafeInteger(row.event_sequence) || row.event_sequence <= 0) {
        broken.set(runId, "event_sequence_missing_or_invalid");
        break;
      }
      if (seen.has(row.event_sequence)) {
        broken.set(runId, "duplicate_event_sequence");
        break;
      }
      seen.add(row.event_sequence);
      if (row.event_sequence !== expected) {
        broken.set(runId, row.event_sequence < expected ? "event_sequence_decreasing" : "event_sequence_gap");
        break;
      }
      expected += 1;
    }
  }
  return broken;
}

/**
 * PB-10 Step 3 Phase 2c: the single replay fence, for *all four* execution
 * modes (CRITICAL 2 — legacy-verbatim's separate, weaker evaluator is gone;
 * every mode calls exactly this function and nothing else). Without it,
 * buildMigrationPlan would treat a migration with no committed applied-ledger
 * row as simply "still pending" and retry it fresh on the very next run —
 * exactly wrong for an unresolved commit_outcome_unknown, where blind replay
 * could duplicate effects that already committed.
 *
 * Every attempt is tracked independently under its own immutable identity
 * across the *complete* history. A later attempt never overwrites, hides or
 * speaks for an earlier one; a terminal event clears only the one attempt it
 * exactly correlates to *and* carries durable proof for; only an exactly
 * targeted stale_reclaimed row clears an ambiguous attempt; and anything
 * incomplete, contradictory or unorderable stays blocking forever.
 *
 * The `started` arm is what makes this fence database-visible and
 * cross-process, surviving the loss of the session that holds the schema
 * advisory lock. That lock is session-scoped: a genuine control-backend
 * death makes PostgreSQL release it immediately, no matter what this process
 * is still awaiting — including the independent, mandatory persistence of the
 * commit_outcome_unknown marker, which by construction runs on a *different*
 * connection and is therefore still in flight at that instant. In that window
 * the only thing another process can observe is the `started` row, committed
 * (autocommit, on the control connection) strictly before BEGIN was ever
 * sent. Nothing in-process — a mutex, a retained object, an awaited dead
 * PoolClient, a promise, a flag — can substitute for it.
 *
 * There is deliberately no code path anywhere that writes a valid
 * stale_reclaimed event: the only way past this guard is an operator
 * inserting one out of band, once they have independently proven what
 * happened. That keeps this a data-only escape hatch, never a reconciliation
 * override hook on the execution API surface.
 */
/**
 * CRITICAL 1: reads everything authoritative that is *not* an event label —
 * the immutable applied-ledger row, and PostgreSQL's own verdict on every
 * transaction id the history binds. Every read failure degrades to "no
 * evidence", which blocks; none of them ever produces proof.
 */
async function gatherOutcomeEvidence(
  control: PoolClient,
  entry: MigrationManifestEntry,
  rows: readonly LedgerEventRow[],
): Promise<OutcomeEvidence> {
  let applied: AppliedArtifact | null | "conflict" = null;
  try {
    // migration_id is schema_migrations' primary key, so more than one row is
    // impossible through a conforming database — checked anyway, and fails
    // closed, because a tampered schema must never resolve to a chosen row.
    const result = await control.query<{
      run_id: string;
      ordinal: number;
      filename: string;
      applied_checksum_sha256: string | null;
      execution_mode: string;
      source_git_sha: string;
      executor_image_digest: string;
      commit_proof: string;
    }>(
      `select run_id::text, ordinal, filename, applied_checksum_sha256, execution_mode,
              source_git_sha, executor_image_digest, commit_proof
         from migration_control.schema_migrations
        where migration_id = $1`,
      [entry.id],
    );
    if (result.rows.length > 1) applied = "conflict";
    else if (result.rows.length === 1) {
      const row = result.rows[0];
      const usable = typeof row.applied_checksum_sha256 === "string" && SHA256.test(row.applied_checksum_sha256);
      applied = usable
        ? {
          runId: row.run_id,
          ordinal: Number(row.ordinal),
          filename: row.filename,
          checksum: row.applied_checksum_sha256!,
          executionMode: row.execution_mode,
          sourceGitSha: row.source_git_sha,
          executorImageDigest: row.executor_image_digest,
          commitProof: row.commit_proof,
        }
        // A baselined row carries no applied checksum: recorded history with no
        // byte evidence, which must never be treated as either proof or absence.
        : "conflict";
    }
  } catch {
    // Evidence that cannot be read is not evidence.
    applied = null;
  }

  // Every binding anywhere in the fetched history, so a xid8 bound by two
  // attempts (or twice by one) can be refused for all of them: one real
  // transaction outcome proves at most one attempt.
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (row.xact_id === null || !XID8.test(row.xact_id)) continue;
    seen.set(row.xact_id, (seen.get(row.xact_id) ?? 0) + 1);
  }
  const reusedXactIds = new Set([...seen].filter(([, count]) => count > 1).map(([xid]) => xid));

  const xactStatus = new Map<string, string | null>();
  const candidates = [...seen.keys()].filter((xid) => !reusedXactIds.has(xid));
  if (candidates.length > 0) {
    try {
      // PostgreSQL's own answer, the one part of this decision no INSERT can
      // reach. pg_xact_status returns NULL once the transaction is old enough
      // that its commit status has been discarded, and errors for an id the
      // server cannot classify or when the role lacks EXECUTE (see db/README.md
      // — the runner role needs it granted); both leave the map empty for that
      // id, which fails closed.
      const status = await control.query<{ xid: string; status: string | null }>(
        `select xid, pg_catalog.pg_xact_status(xid::xid8) as status
           from unnest($1::text[]) as xid`,
        [candidates],
      );
      for (const row of status.rows) xactStatus.set(row.xid, row.status);
    } catch {
      xactStatus.clear();
    }
  }

  return { applied, xactStatus, reusedXactIds };
}

/**
 * H2, step 1 of the decision path: everything the ledger and the database say
 * about every attempt at this migration, with no verdict attached. Pure with
 * respect to the migration being attempted — it issues only SELECTs, runs no
 * mode-specific verifier, and never touches the execution connection.
 */
type AttemptHistory = {
  attempts: AttemptState[];
  /** Blocks replay without belonging to any addressable attempt. */
  orphans: BlockedAttempt[];
  evidence: OutcomeEvidence;
};

async function loadCompleteAttemptHistory(
  control: PoolClient,
  entry: MigrationManifestEntry,
  ordinal: number,
  checksum: string,
): Promise<AttemptHistory> {
  // Every row of every run that touched this migration — see
  // runsWithBrokenOrdering for why the whole run stream is required.
  const prior = await control.query<LedgerEventRow>(
    `select event_id, run_id::text, migration_id, event_sequence, event_type, error_class, sqlstate,
            runner_id, source_git_sha, executor_image_digest, metadata, xact_id::text, statement_ordinal
       from migration_control.migration_runs
      where run_id in (select run_id from migration_control.migration_runs where migration_id = $1)
      order by event_id`,
    [entry.id],
  );
  // migration_runs.event_id is a bigint column and node-postgres returns
  // bigint/int8 as JavaScript strings by default (to avoid silent precision
  // loss beyond 2^53) — not the `number` LedgerEventRow declares. Left
  // uncorrected, every event-id comparison below would compare a string
  // against a number and silently reject every real row.
  const rows: LedgerEventRow[] = prior.rows.map((row) => ({
    ...row,
    event_id: Number(row.event_id),
    xact_id: row.xact_id ?? null,
    statement_ordinal: row.statement_ordinal === null || row.statement_ordinal === undefined
      ? null
      : Number(row.statement_ordinal),
  }));

  // No history at all: nothing to evaluate, and deliberately no extra
  // evidence query — a first-ever attempt reads exactly what it read pre-H2.
  if (rows.length === 0) {
    return { attempts: [], orphans: [], evidence: { applied: null, xactStatus: new Map(), reusedXactIds: new Set() } };
  }

  const evidence = await gatherOutcomeEvidence(control, entry, rows);

  const broken = runsWithBrokenOrdering(rows);
  const attempts = new Map<string, AttemptState>();
  /** Blocks replay without belonging to any addressable attempt. */
  const orphans: BlockedAttempt[] = [];

  const markMalformed = (attempt: AttemptState, reason: string): void => {
    if (attempt.malformed === null) {
      attempt.malformed = reason;
      attempt.category = "malformed_or_conflicting";
    }
  };

  // ── Phase A: establish attempts and attach every event to its own ──────
  for (const event of rows) {
    if (event.migration_id !== entry.id) continue;
    const brokenReason = UUID.test(event.run_id) ? broken.get(event.run_id) : "run_id_not_a_uuid";
    const existing = attempts.get(event.run_id);

    if (brokenReason !== undefined) {
      // An unorderable run can never be trusted, and its rows must not vanish
      // from the evaluation just because they cannot be correlated.
      if (existing) markMalformed(existing, brokenReason);
      else if (!orphans.some(({ eventId }) => eventId === event.event_id)) {
        orphans.push({
          eventId: event.event_id,
          runId: String(event.run_id),
          category: "malformed_or_conflicting",
          reason: brokenReason,
        });
      }
      continue;
    }

    if (event.event_type === "started") {
      const identity = identityFromStartedRow(event, entry, ordinal, checksum);
      if (identity === null) {
        // A started row that cannot even establish an identity is still an
        // attempt: it is armed under its own run id and can never be cleared.
        const placeholder: AttemptState = {
          identity: {
            startedEventId: event.event_id,
            runId: event.run_id,
            runnerId: event.runner_id,
            migrationId: event.migration_id,
            filename: entry.filename,
            ordinal,
            executionMode: entry.executionMode,
            checksum: null,
            sourceGitSha: event.source_git_sha ?? "",
            executorImageDigest: event.executor_image_digest ?? "",
          },
          events: [event],
          ambiguous: false,
          malformed: "started_row_identity_incomplete",
          category: "malformed_or_conflicting",
          provenChecksum: null,
          resolved: false,
          resolution: "unresolved",
        };
        if (existing) markMalformed(existing, "conflicting_duplicate_started");
        else attempts.set(event.run_id, placeholder);
        continue;
      }
      if (existing) {
        // PART 3: a duplicate started row is never silently ignored. RunLog
        // emits exactly one per attempt, so even an *identical* duplicate is
        // outside the durable ledger contract; a differing one is a direct
        // contradiction. Both keep the original identity and block.
        markMalformed(existing, identitiesAgree(existing.identity, identity)
          ? "duplicate_started_not_permitted_by_ledger_contract"
          : "conflicting_duplicate_started");
        existing.events.push(event);
        continue;
      }
      attempts.set(event.run_id, {
        identity,
        events: [event],
        ambiguous: false,
        malformed: null,
        category: "complete_modern",
        provenChecksum: identity.checksum,
        resolved: false,
        resolution: "unresolved",
      });
      continue;
    }

    if (event.event_type === "stale_reclaimed") continue; // handled in phase C

    // Every other type is written by an execution and therefore requires the
    // attempt it belongs to to already exist and to match exactly.
    if (!existing) {
      orphans.push({
        eventId: event.event_id,
        runId: event.run_id,
        category: "malformed_or_conflicting",
        reason: `${event.event_type}_without_started_predecessor`,
      });
      continue;
    }
    existing.events.push(event);
    if (!eventBelongsToAttempt(event, existing.identity)) {
      markMalformed(existing, "event_contradicts_started_identity");
      continue;
    }
    if (event.event_type === "execution_failed" && event.error_class === "commit_outcome_unknown") {
      // Strengthens the state of this attempt; never replaces its identity.
      existing.ambiguous = true;
    }
  }

  // ── Phase B: classify quality and establish any provable checksum ──────
  for (const attempt of attempts.values()) {
    if (attempt.malformed !== null) continue;
    if (attempt.identity.checksum === null) {
      const proven = provenChecksumFor(attempt, evidence);
      if (proven === "conflict") {
        markMalformed(attempt, "conflicting_historical_checksum_evidence");
        continue;
      }
      attempt.provenChecksum = proven;
      attempt.category = proven === null ? "legacy_unprovable" : "legacy_provable";
    }
    if (attempt.identity.runnerId === null) {
      // No artifact can prove a runner identity that was never written, so
      // exact manual correlation is impossible for this row.
      attempt.category = "legacy_unprovable";
    }
  }

  // ── Phase C: apply proof-carrying terminals and exact resolutions ──────
  for (const event of rows) {
    if (event.migration_id !== entry.id) continue;
    if (event.event_type === "stale_reclaimed") {
      if (broken.has(event.run_id)) continue;
      for (const attempt of attempts.values()) {
        if (attempt.resolved) continue;
        if (isValidResolution(event, attempt)) {
          attempt.resolved = true;
          attempt.resolution = "manual";
          break; // one resolution clears exactly one attempt
        }
      }
      // H2, Stage 1 — invalid and conflicting manual-resolution records: an
      // unmatched stale_reclaimed row is already fail-closed by construction
      // and is deliberately *not* additionally treated as an independent
      // blocking fact. It clears nothing, so every attempt it failed to name
      // stays blocked exactly as it was, which is the required outcome; and a
      // duplicate resolution cannot clear a second attempt either, because
      // isValidResolution correlates against `resolved_event_id`/
      // `resolved_run_id`, which name exactly one attempt. Blocking *on* the
      // row itself would instead make one mistyped operator INSERT — into an
      // INSERT-only, UPDATE/DELETE-proof table — permanently unrecoverable,
      // trading a real recovery path for no additional safety.
      continue;
    }
    const attempt = attempts.get(event.run_id);
    if (!attempt || attempt.resolved || attempt.malformed !== null) continue;
    // An ambiguous attempt is past the point where any terminal event can
    // speak for it: only an operator resolution can.
    if (attempt.ambiguous) continue;
    const proof = terminalProof(event, attempt, evidence);
    if (proof !== null) {
      attempt.resolved = true;
      attempt.resolution = proof;
    }
  }

  return { attempts: [...attempts.values()], orphans, evidence };
}

// ════════════════════════════════════════════════════════════════════════
// PB-10 Step 3 Phase 2c, HIGH 2 — mode-specific safe recovery.
//
// One decision path, two stages. Stage 1 (evaluateCentralSafety) is the
// unchanged safety fence: it enforces every structural invariant and it is
// the only thing that may declare an attempt *blocked*. It never declares
// replay safe. Stage 2 (the four evaluateXOutcome functions) may run only
// for an attempt Stage 1 explicitly marked REQUIRES_MODE_EVALUATION, and is
// the only thing that may declare replay safe — from mode-specific
// authoritative evidence, never from an event label.
// ════════════════════════════════════════════════════════════════════════

/**
 * Stage 1's verdict for one attempt.
 *
 * - `DEFINITIVELY_BLOCKED` — malformed, ambiguous, active, conflicting or
 *   otherwise unprovable. No mode-specific evidence can override it.
 * - `REQUIRES_MODE_EVALUATION` — structurally valid history with no
 *   overriding ambiguity, and no terminal proof either way. Mode-specific
 *   authoritative evidence decides.
 * - `DEFINITIVELY_APPLIED` — protected commit proof (see terminalProof) shows
 *   the attempt completed.
 * - `DEFINITIVELY_NOT_COMMITTED` — the protected transaction-binding protocol
 *   plus PostgreSQL's own pg_xact_status verdict prove the transaction
 *   aborted, or an operator recorded an exactly correlated resolution.
 */
type CentralVerdict =
  | "DEFINITIVELY_BLOCKED"
  | "REQUIRES_MODE_EVALUATION"
  | "DEFINITIVELY_APPLIED"
  | "DEFINITIVELY_NOT_COMMITTED";

/** Never a boolean: every mode reports a structured outcome plus a reason. */
type ModeOutcome =
  | "SAFE_TO_RETRY"
  | "ALREADY_APPLIED"
  | "MANUAL_RESOLUTION_REQUIRED"
  | "STILL_ACTIVE"
  | "MALFORMED_OR_CONFLICTING";

type ModeVerdict = { outcome: ModeOutcome; reason: string };

type CentralSafety = {
  /** Attempts Stage 1 refuses outright; mode evaluation must never run for these. */
  blocked: BlockedAttempt[];
  /** Attempts Stage 1 permits Stage 2 to classify, in ledger order. */
  pending: AttemptState[];
};

/**
 * Stage 1. Enforces every central invariant and hands Stage 2 only what it is
 * allowed to look at. It can say "blocked" and it can say "already resolved";
 * it can never say "safe".
 *
 * `currentRunId` is this invocation's own run id: an armed attempt under it is
 * *this process's* in-flight work, so it is reported STILL_ACTIVE rather than
 * offered to a mode evaluator. Cross-process concurrency needs no separate
 * liveness probe — executeMigrations(pool) holds the schema advisory lock for
 * the whole run, and that lock is session-scoped, so a second live executor
 * cannot be past it and a dead one's lock is already released by PostgreSQL.
 */
function evaluateCentralSafety(history: AttemptHistory, currentRunId: string): CentralSafety {
  const blocked: BlockedAttempt[] = [...history.orphans];
  const pending: AttemptState[] = [];

  for (const attempt of history.attempts) {
    const { identity, category, malformed, ambiguous, resolved } = attempt;
    const blockedAs = (reason: string): void => {
      blocked.push({ eventId: identity.startedEventId, runId: identity.runId, category, reason });
    };
    if (resolved) continue; // DEFINITIVELY_APPLIED / _NOT_COMMITTED / manual
    if (malformed !== null) {
      blockedAs(malformed);
      continue;
    }
    if (ambiguous) {
      blockedAs("commit_outcome_unknown");
      continue;
    }
    if (category === "malformed_or_conflicting") {
      blockedAs("malformed_or_conflicting_history");
      continue;
    }
    if (category === "legacy_unprovable") {
      // Nothing in the database can prove what this attempt executed, so no
      // mode-specific verifier can be pointed at the right question either.
      blockedAs("legacy_attempt_identity_unprovable");
      continue;
    }
    if (identity.runId === currentRunId) {
      blockedAs("attempt_still_active_in_this_run");
      continue;
    }
    pending.push(attempt);
  }

  return { blocked, pending };
}

/**
 * The attempt's own correlated events, in ledger order. Every evaluator reads
 * history exclusively through this, so none of them can accidentally consult a
 * row Stage 1 already refused to correlate.
 */
function correlatedEvents(attempt: AttemptState): LedgerEventRow[] {
  return attempt.events.filter((event) => eventBelongsToAttempt(event, attempt.identity));
}

function batchNumberOf(event: LedgerEventRow): number | null {
  const metadata = metadataOf(event);
  const value = metadata?.batch_number;
  return typeof value === "number" ? value : null;
}

/**
 * Stage 2, transactional mode. The C1/C2 protocol is the authority and nothing
 * here weakens it: retry is permitted only when PostgreSQL itself reports the
 * attempt's own exclusively-owned bound transaction aborted, and no
 * durable-effect evidence contradicts that.
 *
 * This is deliberately a superset of terminalProof's rollback rule rather than
 * a different rule: terminalProof additionally requires the writer's own
 * transaction_rolled_back/execution_failed label pair, so an attempt that
 * aborted and then died before it could write those labels resolved as
 * "blocked" pre-H2 despite PostgreSQL holding a conclusive answer. The
 * evidence accepted is identical; only the requirement for the process to have
 * survived long enough to describe it is dropped.
 */
function evaluateTransactionalOutcome(attempt: AttemptState, evidence: OutcomeEvidence): ModeVerdict {
  const applied = appliedProofFor(attempt, evidence);
  if (applied !== null) {
    return applied.commitProof === "transaction_atomic"
      ? { outcome: "ALREADY_APPLIED", reason: "protected_transaction_atomic_commit_proof" }
      // An applied row exists for this exact attempt but the database did not
      // classify it as written inside the bound transaction. Never guessed
      // either way.
      : { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "applied_row_lacks_transaction_atomic_proof" };
  }

  const binding = bindingFor(attempt, evidence);
  if (binding === null) {
    // Zero, duplicate or cross-attempt-reused binding: the attempt has no
    // exclusively owned transaction, so PostgreSQL's verdict cannot be
    // attributed to it. Also the "ROLLBACK requested but never authoritatively
    // confirmed" case — nothing outside the ledger can confirm it.
    return { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "no_exclusive_transaction_binding" };
  }
  // bindTransactionOutcome runs immediately after BEGIN and before any other
  // event of the attempt can be written, so a genuine binding is always the
  // attempt's second correlated row. A binding appearing anywhere else claims
  // to cover work that was already recorded before it existed, and is refused
  // rather than accepted as a late-arriving proof.
  const ordered = correlatedEvents(attempt);
  if (ordered[0]?.event_type !== "started" || ordered[1]?.event_id !== binding.event_id) {
    return { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "transaction_binding_out_of_order" };
  }

  const status = evidence.xactStatus.get(binding.xact_id!);
  if (status === "aborted") {
    // CRITICAL 1's in-flight fence, preserved exactly: an armed attempt that
    // has claimed no outcome at all is still running as far as the ledger is
    // concerned, and the durable `started` row — not the session-scoped
    // advisory lock — is what fences it. A terminated backend makes
    // pg_xact_status report 'aborted' immediately, long before that
    // execution's own mandatory terminal write has landed, so the abort
    // verdict alone must never be enough to let a *second* executor in.
    //
    // What H2 relaxes is only the *shape* of that terminal record.
    // terminalProof demands the writer's full transaction_rolled_back +
    // execution_failed pair, matching error classes and SQLSTATEs, in order,
    // with the class drawn from ROLLBACK_PROVABLE_CLASSES. Here any one
    // correlated terminal row is enough, because the retry licence comes from
    // PostgreSQL's verdict on the real transaction and not from the labels.
    if (!ordered.some(({ event_type }) => event_type === "transaction_rolled_back" || event_type === "execution_failed")) {
      return { outcome: "STILL_ACTIVE", reason: "armed_attempt_has_claimed_no_outcome" };
    }
    return { outcome: "SAFE_TO_RETRY", reason: "postgresql_reports_bound_transaction_aborted" };
  }
  if (status === "committed") {
    // The transaction committed but no protected commit proof exists for it.
    // Never guessed: an operator must establish what actually landed.
    return { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "bound_transaction_committed_without_commit_proof" };
  }
  if (status === "in progress") return { outcome: "STILL_ACTIVE", reason: "bound_transaction_still_in_progress" };
  // null (status discarded by age), absent (unreadable, or EXECUTE on
  // pg_xact_status not granted), or anything unrecognised.
  return { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "bound_transaction_status_unavailable" };
}

/**
 * Stage 2, batched mode.
 *
 * Batches commit on independent transaction boundaries and the protected
 * binding protocol binds exactly one transaction per attempt, so a batch that
 * began has *no* abort proof available to it — and absence of a success event
 * is never evidence that nothing committed (the process can die between a
 * batch's COMMIT and its `operation_completed` row). The one thing that can be
 * proven authoritatively is that no batch ever began, which is exactly what
 * the durable-work marker records, on the control connection, before the first
 * `begin` is sent.
 */
function evaluateBatchedOutcome(attempt: AttemptState): ModeVerdict {
  const events = correlatedEvents(attempt);
  const committedBatches = events.filter((event) => event.event_type === "operation_completed"
    && batchNumberOf(event) !== null);
  const seen = new Set<number>();
  for (const event of committedBatches) {
    const number = batchNumberOf(event)!;
    if (seen.has(number)) {
      return { outcome: "MALFORMED_OR_CONFLICTING", reason: "duplicate_batch_completion_events" };
    }
    seen.add(number);
  }
  const progress = attemptProgress(events);
  if (progress === "conflicting") {
    return { outcome: "MALFORMED_OR_CONFLICTING", reason: "conflicting_progress_marker_history" };
  }
  // A batch-scoped event from an attempt whose own writer recorded that no
  // durable work ever began is an impossible history, not a conservative one.
  if (progress === "no-durable-work" && events.some((event) => batchNumberOf(event) !== null)) {
    return { outcome: "MALFORMED_OR_CONFLICTING", reason: "batch_events_without_durable_work_marker" };
  }
  if (committedBatches.length > 0) {
    return { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "at_least_one_batch_committed" };
  }
  if (progress === "unprovable") {
    // Written before progress was recorded at all: batched mode has no
    // verifier that could answer the question after the fact either, because
    // a completion verifier runs only after batches have already committed.
    return { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "batch_progress_unprovable_for_this_attempt" };
  }
  if (progress === "durable-work-began") {
    // A batch opened a transaction. Whether it committed cannot be proven from
    // here, and a partially applied backfill must never be replayed blindly.
    return { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "batch_began_without_provable_commit_outcome" };
  }
  return { outcome: "SAFE_TO_RETRY", reason: "no_batch_work_began" };
}

/**
 * Stage 2, nontransactional and legacy-verbatim modes — one implementation,
 * because their recovery question is literally the same one: no transaction
 * this runner can bind exists, so the migration-specific verifier, not the
 * ledger, is the authority on what landed.
 *
 * The ledger contributes exactly one authoritative fact: whether the attempt
 * ever reached the point of issuing its payload (the durable-work marker,
 * committed on the control connection immediately beforehand). Without that
 * marker no statement can have had any effect, and no verifier is needed or
 * run. With it, the verifier decides, and a verifier that is missing, throws,
 * or cannot classify the state blocks — a handler exception is never taken as
 * proof that no SQL completed.
 */
async function evaluateVerifierLedOutcome(
  attempt: AttemptState,
  verifier: NontransactionalHandler | undefined,
  client: PoolClient,
): Promise<ModeVerdict> {
  const events = correlatedEvents(attempt);
  const progress = attemptProgress(events);
  if (progress === "conflicting") {
    return { outcome: "MALFORMED_OR_CONFLICTING", reason: "conflicting_progress_marker_history" };
  }
  // Only an attempt whose own writer recorded its progress may claim this: a
  // pre-H2 attempt is silent about progress whether it ran nothing or ran
  // everything, so it goes to the verifier like any other.
  if (progress === "no-durable-work") {
    return { outcome: "SAFE_TO_RETRY", reason: "no_statement_was_ever_issued" };
  }
  if (verifier === undefined) {
    return { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "recovery_verifier_unavailable" };
  }
  let state: NontransactionalState;
  try {
    state = await verifier.inspect(client);
  } catch {
    // Deliberately swallowed rather than propagated: a verifier that failed
    // proves nothing, and its own error text is outside this module's
    // sanitized diagnostic vocabulary.
    return { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "recovery_verifier_failed" };
  }
  if (state === "valid") return { outcome: "ALREADY_APPLIED", reason: "verifier_proves_desired_state" };
  if (state === "absent") return { outcome: "SAFE_TO_RETRY", reason: "verifier_proves_no_durable_effect" };
  if (state === "unknown") return { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "verifier_evidence_inconclusive" };
  return { outcome: "MANUAL_RESOLUTION_REQUIRED", reason: "verifier_reports_partial_or_invalid_state" };
}

/**
 * H2, the final step of the decision path: runs Stage 1, then — only for the
 * attempts Stage 1 permits — the one evaluator matching this migration's
 * declared execution mode, and turns the aggregate into the single answer
 * executeMigrations(pool) acts on.
 *
 * `execute` means every unresolved attempt is authoritatively safe to replay.
 * `adopt` means a verifier proved the desired state already exists, so the
 * migration must be recorded rather than run again. Anything else throws the
 * same fail-closed commit_outcome_unknown error as pre-H2, with a sanitized
 * per-attempt reason.
 */
type ExecutionDecision = "execute" | "adopt";

async function applyExecutionDecision(context: MigrationContext): Promise<ExecutionDecision> {
  const { entry, control, runLog, ordinal, checksum } = context;
  const history = await loadCompleteAttemptHistory(control, entry, ordinal, checksum);
  const { blocked, pending } = evaluateCentralSafety(history, runLog.runId);

  const refused: BlockedAttempt[] = [...blocked];
  let adopt = false;

  // Stage 2 runs only once Stage 1 has found nothing blocking at all: a
  // malformed, ambiguous or active history must never be overridden by a
  // verifier, and must never even cause one to be run.
  if (refused.length === 0) {
    for (const attempt of pending) {
      const verdict = await evaluateModeOutcome(context, attempt, history.evidence);
      if (verdict.outcome === "SAFE_TO_RETRY") continue;
      if (verdict.outcome === "ALREADY_APPLIED") {
        adopt = true;
        continue;
      }
      refused.push({
        eventId: attempt.identity.startedEventId,
        runId: attempt.identity.runId,
        category: attempt.category,
        reason: `${entry.executionMode}:${verdict.outcome}:${verdict.reason}`,
      });
    }
  }

  if (refused.length === 0) return adopt ? "adopt" : "execute";

  // Sanitized by construction: event ids, run ids, a fixed category and a
  // fixed reason token — never SQL, driver objects, connection details or
  // row values.
  const detail = refused
    .map(({ eventId, runId, category, reason }) => `event_id=${eventId} run_id=${runId} category=${category} reason=${reason}`)
    .join("; ");
  throw new MigrationExecutionError(
    "commit_outcome_unknown",
    `${refused.length} previous attempt(s) block replay and must each be reconciled before this migration may run again [${detail}]`,
    entry.id,
  );
}

function evaluateModeOutcome(
  context: MigrationContext,
  attempt: AttemptState,
  evidence: OutcomeEvidence,
): Promise<ModeVerdict> {
  const { entry, execution, handlers } = context;
  // The attempt's *own* recorded mode, which Stage 1 has already proven equal
  // to the manifest's — a mode evaluator never speaks for another mode.
  switch (attempt.identity.executionMode) {
    case "transactional":
      return Promise.resolve(evaluateTransactionalOutcome(attempt, evidence));
    case "batched":
      return Promise.resolve(evaluateBatchedOutcome(attempt));
    case "nontransactional":
    case "legacy-verbatim":
      // Both modes' recovery verifier comes from the same reviewed registry.
      // No legacy migration registers one today, so legacy-verbatim that
      // actually issued its payload stays exactly as fail-closed as pre-H2.
      return evaluateVerifierLedOutcome(attempt, handlers.nontransactional(entry.id), execution);
    default:
      return Promise.resolve({ outcome: "MALFORMED_OR_CONFLICTING", reason: "unknown_execution_mode" });
  }
}

/**
 * The two progress markers (see ATTEMPT_ARMED_ORDINAL / WORK_STARTED_ORDINAL).
 * Both are written on the control connection, in autocommit, so they are on
 * disk before the operation they describe can have any effect and survive the
 * loss of the execution connection.
 */
async function markAttemptProgress(context: MigrationContext, ordinal: number): Promise<void> {
  await context.runLog.recordProgressMarker(context.entry.id, ordinal);
}


type CommitReconciliation = "committed" | "unresolved";

/**
 * PB-10 Step 3 Phase 2c: authoritative proof, never a guess. A row matching
 * this exact canonical identity (migration_id + ordinal + run_id + applied
 * checksum) can only exist if the ambiguous transaction actually committed:
 * the schema advisory lock held for the whole run rules out any concurrent
 * writer racing this same row into existence. Absence, or the reconciliation
 * query itself failing (the control connection is also unusable), both fail
 * closed as "unresolved" — neither is ever treated as proof of rollback.
 */
async function reconcileAmbiguousCommit(
  control: PoolClient,
  migrationId: string,
  ordinal: number,
  runId: string,
  appliedChecksum: string,
): Promise<CommitReconciliation> {
  try {
    const result = await control.query<{ migration_id: string }>(
      `select migration_id from migration_control.schema_migrations
        where migration_id = $1 and ordinal = $2 and run_id = $3 and applied_checksum_sha256 = $4`,
      [migrationId, ordinal, runId, appliedChecksum],
    );
    return result.rows.length === 1 ? "committed" : "unresolved";
  } catch {
    return "unresolved";
  }
}

/** Bounded so a genuinely unreachable server fails predictably rather than hanging. */
const INDEPENDENT_CONTROL_CONNECT_TIMEOUT_MS = 5_000;

/**
 * PB-10 Step 3 Phase 2c blocker 3: the durable-ambiguity fallback must have a
 * finite, deterministic acquisition path even when the production pool's own
 * `max` (as low as 2) is already fully held by `control` and `execution` at
 * the exact moment an ambiguity is discovered. `pool.connect()` would queue
 * behind them — and neither slot can free before this call returns: `control`
 * is still actively in use by the very code path that needs this fallback,
 * and `execution`'s release is owned by the outer run loop's `finally`, which
 * cannot run until every migration-mode function (including this one)
 * returns. Waiting on the shared pool here is not merely slow, it is a
 * guaranteed deadlock under `max: 2`.
 *
 * The fix is to never contend for one of the pool's own slots at all: this
 * opens one additional physical connection with the exact same connection
 * parameters (`pool.options` — host, port, credentials, database, ssl, …)
 * but outside the pool's capacity accounting entirely, so it can never be
 * blocked by `control`/`execution` occupying every pool slot, and carries its
 * own short, explicit connection deadline instead of inheriting the shared
 * pool's (or the platform's) default. `.release()` on the object this returns
 * always means "close this ad hoc connection" — it was never a pool-held
 * resource to return, so healthy and destructive release both simply end it,
 * and (unlike pg-pool's own synchronous, fire-and-forget release) returns the
 * `Promise<void>` that actually completes once the socket is torn down, so a
 * caller can `await` it in a `finally` rather than leaking a dangling close.
 *
 * `{ ...pool.options }` is deliberately never used to build the ad hoc
 * client's config: pg-pool's own Pool constructor attaches an explicit
 * `password` (when the caller supplied one directly, rather than via a
 * connection string) to `pool.options` as a *non-enumerable* property
 * specifically so it never appears in a `JSON.stringify`/`console.log` of the
 * pool — and a plain object spread only copies a source's own *enumerable*
 * properties, so `{ ...pool.options }` silently drops password whenever pool
 * was constructed from explicit host/user/password fields (connection-string
 * configuration is unaffected, since pg-pool stores that as a normal
 * enumerable property). `cloneConnectionOptions` below copies every own
 * property — enumerable or not — by its property descriptor, so the returned
 * client authenticates identically to `pool` itself no matter which
 * configuration form produced it, while never mutating `pool.options`.
 */
function cloneConnectionOptions<T extends object>(source: T): T {
  return Object.defineProperties({}, Object.getOwnPropertyDescriptors(source)) as T;
}

interface IndependentPoolClient extends PoolClient {
  /** Always resolves once the ad hoc socket is fully closed; never rejects. */
  release(err?: Error): Promise<void>;
}

function independentControlAcquirer(pool: Pool): () => Promise<IndependentPoolClient> {
  return async () => {
    const options = cloneConnectionOptions(pool.options);
    Object.defineProperty(options, "connectionTimeoutMillis", {
      value: INDEPENDENT_CONTROL_CONNECT_TIMEOUT_MS,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const client = new Client(options);
    // PB-10 Step 3 Phase 2c final review, HIGH 5: the close-once ownership
    // wrapper is established here — *before* connect() is ever attempted —
    // specifically so a rejected connect() still has a guaranteed,
    // exactly-once path to end() the client. `pg.Client.connect()` can leave
    // real socket state behind even when it rejects (a TCP connection that
    // succeeded before an authentication failure, for instance); previously
    // `client.end()` was only ever reachable *after* a successful connect(),
    // so a failed connect leaked whatever partial connection state the
    // driver had already created. Ownership is unconditional from this line
    // on: every exit path below — a failed connect, a successful connect
    // later released healthily or destructively — always closes through
    // this same `close()`, and never more than once.
    let ended: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!ended) ended = client.end().catch(() => undefined);
      return ended;
    };
    // A named, stable listener (not an anonymous inline no-op) so a delayed
    // error on this connection — before, during, or after close() — is
    // reported through the same sanitized diagnostic path as every other
    // absorbed PostgreSQL client error, never silently swallowed.
    client.on("error", reportSanitizedPoolError);
    try {
      await client.connect();
    } catch (error) {
      await close();
      throw error;
    }
    return Object.assign(client, {
      release: (): Promise<void> => close(),
    }) as unknown as IndependentPoolClient;
  };
}

/**
 * PB-10 Step 3 Phase 2c blocker 3: persists a commit_outcome_unknown
 * execution_failed event so it can never be lost merely because the control
 * connection that discovered the ambiguity is also the one that died. append()
 * on `runLog` (bound to `control`) is tried first; only if that throws does
 * this fall back to independently acquired connections from the same pool —
 * up to three attempts, since a single fresh connection can itself be
 * momentarily unlucky (e.g. racing the same network partition).
 *
 * If every attempt fails, the database itself is unreachable from this
 * process on any connection it can open — there is no durable state this
 * process could leave in that case, on this connection or any other, so it
 * throws a plain (non-MigrationExecutionError) error instead of returning.
 * That deliberately does not fit the normal recoverable-error vocabulary: it
 * must never be mistaken for "safely retryable" by any caller, and the
 * advisory lock this run holds is released, unheld, exactly as it would be
 * for any other uncaught failure — the honest fail-closed answer to a
 * database that cannot be written to at all is "nothing durable could be
 * recorded", not a fabricated guarantee this code cannot deliver.
 */
async function appendAmbiguityDurably(
  runLog: RunLog,
  acquireIndependentControl: () => Promise<IndependentPoolClient>,
  migrationId: string,
  metadata: EventMetadata,
  extra: { sqlstate?: string | null; errorClass?: ErrorClass },
): Promise<void> {
  try {
    await runLog.append(migrationId, "execution_failed", metadata, extra);
    return;
  } catch {
    // The primary control connection could not carry this INSERT either —
    // fall through to an independently acquired one below.
  }
  let lastErrorCode = "UNKNOWN";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let independent: IndependentPoolClient | undefined;
    let failure: Error | undefined;
    try {
      // PB-10 Step 3 Phase 2c final review, HIGH 6: independentControlAcquirer
      // itself now attaches a stable, named, sanitizing 'error' listener
      // (reportSanitizedPoolError) to every client it returns, unconditionally,
      // from before connect() is even attempted — a checked-out pg-pool
      // client normally has no idle-error listener at all, so a raw socket
      // error here (not a query rejection) would otherwise become an
      // uncaught exception in this short-lived connection. That listener is
      // never removed or replaced here: delayed errors remain observable
      // through the sanitized path for the whole lifetime of this
      // connection, including after release() below, and it is attached
      // exactly once per acquired client regardless of how many attempts
      // this loop makes — repeated attempts never accumulate listeners on
      // the *same* object, because each attempt acquires its own new client.
      independent = await acquireIndependentControl();
      await runLog.appendVia(independent, migrationId, "execution_failed", metadata, extra);
      return;
    } catch (error) {
      lastErrorCode = safePoolErrorCode(error);
      // PB-10 Step 3 Phase 2d final review, CRITICAL 1: the total conversion,
      // not an inline `String(error)`. A hostile thrown value here would
      // otherwise abort this retry loop from inside its own `catch`, before the
      // ad hoc connection below could be released.
      failure = errorValue(error);
    } finally {
      // Exactly one destructive/healthy release per attempt, always awaited
      // here so this function never returns (successfully or by throwing)
      // while an ad hoc socket, its connect timer, or its 'error' listener
      // is still outstanding.
      if (independent) await independent.release(failure);
    }
  }
  // PB-10 Step 3 Phase 2c final review, HIGH 6: never interpolates the raw
  // caught error (String(lastError)) into this message — that could carry a
  // connection string, hostname, username, SQL text, or certificate detail.
  // Only the same whitelisted, sanitized code every other absorbed
  // PostgreSQL error in this module reports is included here.
  throw new Error(
    `PB-10 commit_outcome_unknown for migration ${migrationId} could not be durably recorded through any connection; refusing to continue (last error code=${lastErrorCode})`,
  );
}

/** The error's own classification when it carries one; a generic SQL failure otherwise. */
function recordedErrorClass(error: unknown): ErrorClass {
  return error instanceof MigrationExecutionErrorBase ? error.errorClass : "sql_failed";
}

/**
 * superviseOperation/superviseCallback wrap a driver error's SQLSTATE inside
 * a MigrationExecutionError (whose own .sqlstate carries it, not .code), so
 * a bare sqlstateOf() on an already-supervised error would otherwise see
 * nothing. This looks in both places.
 */
function errorSqlstate(error: unknown): string | null {
  return error instanceof MigrationExecutionErrorBase ? error.sqlstate : sqlstateOf(error);
}

// ════════════════════════════════════════════════════════════════════════
// Module-private: cancellation-confirmation supervision (formerly supervision.ts)
// ════════════════════════════════════════════════════════════════════════

/** SQLSTATE PostgreSQL raises for a statement cancelled via pg_cancel_backend. */
const QUERY_CANCELED_SQLSTATE = "57014";

/**
 * Explicit cancellation/supervision states. Exactly one terminal state
 * (settled-before-cancel, cancellation-confirmed, or cancellation-unverified)
 * is ever selected for a given call.
 */
type SupervisionState =
  | "running"
  | "settled-before-cancel"
  | "cancel-requested"
  | "cancellation-confirmed"
  | "cancellation-unverified";

type Settlement<T> =
  | { readonly status: "resolved"; readonly value: T }
  | { readonly status: "rejected"; readonly error: unknown };

type RaceOutcome<T> =
  | { readonly raced: "settled"; readonly settlement: Settlement<T> }
  | { readonly raced: "expired" };

async function raceSettlement<T>(
  context: Pick<MigrationContext, "sleep">,
  operation: Promise<Settlement<T>>,
  milliseconds: number,
): Promise<RaceOutcome<T>> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      operation.then((settlement) => ({ raced: "settled" as const, settlement })),
      context.sleep(milliseconds, timer.signal).then(() => ({ raced: "expired" as const })),
    ]);
  } finally {
    timer.abort();
  }
}

/**
 * Runs one operation under a wall-clock budget supervised by the control
 * connection.
 *
 * Settlement observation is attached to the operation before any timeout or
 * cancellation logic runs (state "running"), so the operation's own promise
 * never rejects unhandled regardless of which race it loses. If it settles
 * first, that is "settled-before-cancel" and propagates normally. Otherwise
 * the budget has expired and a cancellation request is issued
 * ("cancel-requested"): pg_cancel_backend returning true only means
 * PostgreSQL accepted the request, never that cancellation happened.
 * Cancellation is "cancellation-confirmed" only when the operation rejects
 * with SQLSTATE 57014 (query_canceled) within the grace period. Every other
 * outcome once a cancellation request has begun — the request itself
 * returning false or throwing, the grace period elapsing with no
 * settlement, or the operation settling any other way (including a bare
 * successful resolution racing the cancellation) — is
 * "cancellation-unverified": the execution connection is destroyed rather
 * than reused, and a deterministic cancellation_unverified error is thrown.
 *
 * This function never releases or destroys the control connection itself —
 * that connection is shared across an entire migration run and its
 * lifecycle belongs to its caller — and it never releases the execution
 * connection either; it only ever decides, via destroyExecution(), whether
 * the caller's eventual release of that connection must discard it rather
 * than return it to the pool.
 *
 * The one and only Promise.race-based cancellation-confirmation core.
 * superviseOperation (SQL-text, Phase 2a's original public shape) and
 * superviseCallback (Phase 2b: an arbitrary operation on the execution
 * client, used where the supervised work is not a single SQL string — e.g.
 * one batched-mode batch) both delegate here unchanged, so there is exactly
 * one state machine and one Promise.race, never two competing ones.
 */
async function superviseSettlement<T>(
  context: MigrationContext,
  budgetMs: number,
  run: () => Promise<T>,
  failureDetail: string,
): Promise<T> {
  const { entry, control, execution } = context;
  const pidResult = await execution.query<{ pid: number }>("select pg_backend_pid() as pid");
  const pid = pidResult.rows[0]?.pid;
  assertCondition(Number.isInteger(pid), `Could not identify the execution backend for ${entry.id}`);

  let state: SupervisionState = "running";

  // Attached immediately: the operation promise is handled here exactly
  // once, so it can never surface as an unhandled rejection no matter which
  // race below it loses, and no matter how long supervision continues after.
  const operation: Promise<Settlement<T>> = run().then(
    (value) => ({ status: "resolved", value }) as const,
    (error: unknown) => ({ status: "rejected", error }) as const,
  );
  // PB-10 Step 3 Phase 2d: this is the one place in the executor where an
  // operation holding the execution session can outlive the `await` that
  // started it — an unconfirmed cancellation abandons `operation` still
  // pending, by design, because nothing can prove what it is doing. The
  // terminal boundary must never issue `rollback`/`discard all` on a session
  // in that state, so it is told about the operation here rather than left to
  // infer quiescence from the call stack having unwound.
  context.noteExecutionWork(operation);

  const settledBeforeCancel = await raceSettlement(context, operation, budgetMs);

  const unverified = (detail: string): never => {
    state = "cancellation-unverified";
    context.destroyExecution();
    throw new MigrationExecutionError("cancellation_unverified", detail, entry.id);
  };

  if (settledBeforeCancel.raced === "settled") {
    state = "settled-before-cancel";
    const { settlement } = settledBeforeCancel;
    if (settlement.status === "rejected") {
      throw classify(settlement.error, "sql_failed", entry.id, failureDetail);
    }
    return settlement.value;
  }

  // The budget expired before the operation settled. From this point on, any
  // later settlement of `operation` races the cancellation request and can
  // never again be treated as ordinary success or failure.
  state = "cancel-requested";

  let cancelAccepted: boolean;
  try {
    const cancelResult = await control.query<{ pg_cancel_backend: boolean }>(
      "select pg_cancel_backend($1) as pg_cancel_backend",
      [pid],
    );
    cancelAccepted = cancelResult.rows[0]?.pg_cancel_backend === true;
  } catch {
    // The cancellation request itself failed (or the control connection is
    // unusable): nothing confirms cancellation, so this is unverified rather
    // than a bare rethrow that would skip destroying the execution connection.
    cancelAccepted = false;
  }

  if (!cancelAccepted) {
    unverified(`cancellation request was not accepted by PostgreSQL for migration ${entry.id}`);
  }

  const graceOutcome = await raceSettlement(context, operation, CANCELLATION_GRACE_MS);

  if (graceOutcome.raced === "expired") {
    unverified(`cancellation was not confirmed within ${CANCELLATION_GRACE_MS}ms; the execution connection was destroyed`);
  }

  // TypeScript cannot see that `unverified` above never returns across the
  // `if`, so narrow explicitly rather than relying on control-flow analysis.
  assertCondition(graceOutcome.raced === "settled", "unreachable: grace outcome must be settled here");
  const { settlement } = graceOutcome;

  if (settlement.status === "rejected" && sqlstateOf(settlement.error) === QUERY_CANCELED_SQLSTATE) {
    state = "cancellation-confirmed";
    throw new MigrationExecutionError(
      "wall_clock_exceeded",
      `operation exceeded its ${budgetMs}ms wall-clock budget and was cancelled`,
      entry.id,
      QUERY_CANCELED_SQLSTATE,
    );
  }

  // Either the operation resolved successfully after the cancellation
  // request was issued (an ambiguous cancel/complete race — never treated as
  // success), or it rejected with something other than query_canceled.
  // Neither proves the cancellation happened, so both are unverified.
  return unverified(
    settlement.status === "resolved"
      ? "the operation completed after a cancellation request was issued; the outcome is an unverifiable cancel/complete race"
      : `the operation rejected with an unexpected SQLSTATE after a cancellation request (expected ${QUERY_CANCELED_SQLSTATE})`,
  );
}

async function superviseOperation(context: MigrationContext, sql: string, budgetMs: number): Promise<void> {
  await superviseSettlement(context, budgetMs, () => context.execution.query(sql), "supervised SQL operation failed");
}

/**
 * PB-10 Step 3 Phase 2b: the same state machine as superviseOperation, for
 * operations that are not a single SQL string — a batched-mode batch is an
 * opaque caller-supplied callback that may issue any number of statements on
 * the execution client. Behaviourally identical to superviseOperation:
 * confirmed cancellation, unverified cancellation and settled-before-cancel
 * all follow the exact same rules, just returning the callback's value on
 * success instead of void.
 */
async function superviseCallback<T>(
  context: MigrationContext,
  budgetMs: number,
  run: (client: PoolClient) => Promise<T>,
  failureDetail: string,
): Promise<T> {
  return superviseSettlement(context, budgetMs, () => run(context.execution), failureDetail);
}

// ════════════════════════════════════════════════════════════════════════
// Module-private: batched-mode orchestration (formerly batched.ts)
// ════════════════════════════════════════════════════════════════════════

/**
 * PB-10 Step 3 Phase 2c blocker 1: thrown by a closed runBatch to any caller
 * reached after the lifecycle has moved past "active" — a retained closure, a
 * timer, a queued microtask, a delayed promise continuation, or a second call
 * from handler- or verifier-authored code. Deliberately not a
 * MigrationExecutionError: it never reaches runLog, never reaches
 * classify(), and must never be mistaken for the migration's own terminal
 * outcome by anything that awaits it — it is inert by construction, thrown
 * before a single query is issued.
 */
class BatchLifecycleClosedError extends Error {
  constructor(migrationId: string) {
    super(`runBatch for migration ${migrationId} is no longer callable: this batched migration's execution has already completed or been closed`);
    this.name = "BatchLifecycleClosedError";
  }
}

/**
 * Mode boundary only. The runner hands the handler a bounded per-batch
 * transaction and demands an independent completion verifier; it never
 * invents a universal backfill executor and never degrades to another mode.
 *
 * One aggregate wall-clock deadline is shared across every batch: no batch,
 * however quickly it individually finishes, ever resets it or receives a
 * fresh allowance, and every batch receives only what remains once its
 * predecessors have run.
 */
async function executeBatched(context: MigrationContext): Promise<void> {
  const { entry, control, execution, runLog, checksum } = context;
  // H2: batched mode never adopts — no verifier of its can prove the whole
  // migration already landed (see evaluateBatchedOutcome).
  assertCondition(
    await applyExecutionDecision(context) === "execute",
    `Refusing an adoption decision for batched migration ${entry.id}`,
  );
  const handler = context.handlers.batched(entry.id);
  if (!handler) {
    throw new MigrationExecutionError(
      "unsupported_handler",
      "batched execution requires a reviewed migration-specific handler; none is registered",
      entry.id,
    );
  }

  const startedAt = context.now();
  // One aggregate deadline for the whole migration, shared across every
  // batch. No batch — however quickly it individually finishes — ever
  // resets it or receives a fresh budget.
  const deadlineMs = monotonicMs() + entry.timeouts.wallClockMs;
  // checksum_sha256 is carried here, exactly as transactional mode does, so
  // this row is a fully-formed armed record for the in-flight fence in
  // assertNoUnresolvedCommitAmbiguity — an operator resolution can only ever
  // correlate against fields the armed row actually stored.
  await runLog.append(entry.id, "started", { execution_mode: "batched", checksum_sha256: checksum }, {
    heartbeatDeadline: new Date(Date.now() + entry.timeouts.wallClockMs),
  });
  // H2: proves this attempt was written by an executor that records durable
  // progress, so the absence of the durable-work marker below actually means
  // "nothing was issued" rather than "nobody was recording".
  await markAttemptProgress(context, ATTEMPT_ARMED_ORDINAL);

  let batchNumber = 0;
  // PB-10 Step 3 Phase 2c blocker 1: an executor-owned lifecycle, not merely
  // a repeated-check latch. `lifecycle` is the structural gate: runBatch may
  // begin real work only while it is still "active", and nothing in
  // BatchedContext or MigrationContext exposes a way for migration-authored
  // code to read or reset it back to "active" once closed — the transition
  // is one-directional and permanent for the lifetime of this
  // executeBatched call. `ambiguity` is, separately, *which* terminal error
  // a closed runBatch (or the outer handler.execute()/verifyComplete()
  // sequence below) must throw/rethrow; setAmbiguity always closes the
  // lifecycle in the same synchronous step it records the error, so
  // ambiguity permanently wins over every other outcome once observed.
  //
  // Because runBatch's guard is the very first synchronous statement in its
  // async body — checked before any `await` — a legitimate call already
  // in flight when handler.execute() returns (started, but not yet awaited,
  // by handler-authored code that fired it and returned without waiting)
  // has already passed this check by the time JavaScript's run-to-completion
  // semantics let anything else run; only a *fresh* call reaching this point
  // after the lifecycle has closed is rejected. That is what makes a
  // concurrent legitimate invocation and a late invocation distinguishable
  // by nothing more than this one guard.
  let lifecycle: "active" | "closed" = "active";
  let ambiguity: MigrationExecutionError | undefined;
  const setAmbiguity = (error: MigrationExecutionError): MigrationExecutionError => {
    ambiguity = error;
    lifecycle = "closed";
    return error;
  };
  // PB-10 Step 3 Phase 2c blocker 1 (settlement): a call passing the
  // lifecycle guard above is not enough on its own — handler- or
  // verifier-authored code can start a batch and simply never await it,
  // letting real PostgreSQL work (including its own COMMIT) continue to run
  // after handler.execute() has returned, after verifyComplete has returned,
  // or even after this function has already recorded applied_committed/
  // succeeded and returned. `pending` is the executor's own record of every
  // batch promise that has started while the lifecycle was active,
  // registered synchronously — before any `await` — at the same moment the
  // lifecycle guard above lets a call through, so it can never be hidden by
  // handler-authored code choosing not to await its own call. Every settle
  // point below (leaving handler.execute(), before/after verifyComplete,
  // before the applied-ledger insert, before either terminal ledger event,
  // and immediately before this function returns) drains it completely
  // before proceeding, so no success-shaped step — and no return — can ever
  // happen while a started batch's COMMIT might still be in flight.
  const pending = new Set<Promise<unknown>>();
  // The outcome of a batch nothing else observed — see runBatch below.
  let unconsumedFailure: Error | undefined;
  const settlePending = async (): Promise<void> => {
    // A snapshot, not a live view: batches already in `pending` when this is
    // called cannot themselves start new ones (runBatch's own lifecycle
    // guard only lets that happen while still "active", and every caller of
    // settlePending below runs only after the lifecycle has already closed
    // for the "leaving handler.execute()" call — see its own comment), so
    // one pass is enough to reach a fixed point, not merely a snapshot that
    // could already be stale by the time it resolves.
    //
    // Membership is released here, by the drain that consumed the outcome —
    // never by the batch promise itself on settling. A self-removing
    // `.finally()` would delete a *rejected* fire-and-forget batch from the
    // set at the instant it rejects, which is typically long before this
    // drain runs; the drain would then find an empty set, attach nothing,
    // and the rejection would surface as a strict unhandled rejection that
    // kills the process instead of the authoritative failure this executor
    // is trying to report.
    while (pending.size > 0) {
      const owned = [...pending];
      await Promise.allSettled(owned);
      for (const batch of owned) pending.delete(batch);
    }
  };

  const runOneBatch = async <T>(number: number, budget: number, batch: (client: PoolClient) => Promise<T>): Promise<T> => {
      // H2: durable before the very first batch can open a transaction, so a
      // later evaluation can tell "no batch ever began" (authoritatively safe
      // to retry) from "a batch began and its commit outcome is unprovable".
      // Written once per attempt — the marker records that durable work
      // started, not which batch.
      if (number === 1) await markAttemptProgress(context, WORK_STARTED_ORDINAL);
      await execution.query("begin");
      let commitStarted = false;
      try {
        await applyTimeouts(execution, entry.timeouts, true);
        // The control-side supervisor supplies the remaining migration
        // budget. PostgreSQL keeps the independently declared per-statement
        // and per-transaction ceilings; setting transaction_timeout to the
        // same value as the supervisor can terminate the session before the
        // accepted pg_cancel_backend/57014 confirmation path runs.
        const value = await superviseCallback(context, budget, batch, `batch ${number} failed`);
        commitStarted = true;
        await execution.query("commit");
        await runLog.append(entry.id, "operation_completed", { execution_mode: "batched", batch_number: number });
        return value;
      } catch (error) {
        if (commitStarted && errorSqlstate(error) === null) {
          // No genuine PostgreSQL ErrorResponse for this batch's COMMIT: a
          // client-side timeout, socket loss, or any other transport-level
          // failure can all reject this promise while COMMIT actually lands
          // on the server, and connection liveness proves nothing either way
          // (Phase 2c blocker 2). Unlike transactional mode, a batch's
          // applied-ledger row is written separately (on control, after
          // every batch and verifyComplete), so there is no same-transaction
          // row to reconcile against, and this runner has no
          // migration-specific way to safely inspect a handler's own
          // backfill effects. Rather than invent unsafe partial-success
          // semantics, this always fails closed: latched immediately, so no
          // later batch and no handler-side recovery can run, nothing is
          // retried automatically, and the execution_failed event
          // (batch_number identifies exactly which batch) carries the batch
          // context an operator needs before recording a stale_reclaimed
          // ledger event.
          context.destroyExecution();
          throw setAmbiguity(new MigrationExecutionError(
            "commit_outcome_unknown",
            `batch ${number}'s COMMIT was sent and its outcome could not be confirmed`,
            entry.id,
            errorSqlstate(error),
          ));
        }

        // Either COMMIT was never sent for this batch, or it was and the
        // rejection carried a genuine PostgreSQL ErrorResponse — the one
        // case PostgreSQL itself guarantees no commit occurred.
        const sqlstate = errorSqlstate(error);
        const causeClass = recordedErrorClass(error);
        const wallClockDriven = causeClass === "wall_clock_exceeded" || causeClass === "cancellation_unverified";

        if (wallClockDriven) {
          // A cancellation supervision already deemed unverified has already
          // destroyed the connection exactly once; this block must never
          // call destroyExecution() a second time for the same outcome.
          const alreadyUnverified = causeClass === "cancellation_unverified";
          let rolledBack = false;
          if (!alreadyUnverified) {
            try {
              await execution.query("rollback");
              rolledBack = true;
            } catch {
              // Handled once, below, via the shared !rolledBack branch.
            }
          }
          if (!rolledBack) {
            if (!alreadyUnverified) context.destroyExecution();
            // Phase 2c blocker 4: a cancellation whose own ROLLBACK cannot be
            // confirmed is exactly as ambiguous as an unconfirmed COMMIT —
            // latched the same way, so it durably arms commit_outcome_unknown
            // (via the outer catch's appendAmbiguityDurably) rather than the
            // narrower cancellation_unverified class, which
            // assertNoUnresolvedCommitAmbiguity does not recognise and would
            // otherwise leave this migration eligible for blind replay.
            throw setAmbiguity(new MigrationExecutionError(
              "commit_outcome_unknown",
              `batch ${number} rollback could not be confirmed after cancellation; the transaction's final state is unknown`,
              entry.id,
              sqlstate,
            ));
          }
          // Only the still-active batch rolls back here: every earlier
          // batch already committed independently on its own transaction
          // boundary and this event never claims otherwise.
          await runLog.append(entry.id, "transaction_rolled_back", { execution_mode: "batched", batch_number: number }, {
            sqlstate,
            errorClass: causeClass,
          });
          throw classify(error, causeClass, entry.id, `batch ${number} rolled back`);
        }

        // A genuine (non-wall-clock) SQL failure: unchanged pre-Phase-2b
        // behaviour, except (blocker 4) transaction_rolled_back is recorded
        // only once ROLLBACK itself is proven to have succeeded.
        let rolledBack = false;
        try {
          await execution.query("rollback");
          rolledBack = true;
        } catch {
          context.destroyExecution();
        }
        if (!rolledBack) {
          throw setAmbiguity(new MigrationExecutionError(
            "commit_outcome_unknown",
            `batch ${number} rollback could not be confirmed; the transaction's final state is unknown`,
            entry.id,
            sqlstate,
          ));
        }
        await runLog.append(entry.id, "transaction_rolled_back", { execution_mode: "batched", batch_number: number }, {
          sqlstate,
          errorClass: "sql_failed",
        });
        throw classify(error, "sql_failed", entry.id, `batch ${number} rolled back`);
      }
  };

  const batchContext: BatchedContext = {
    migrationId: entry.id,
    runBatch: <T>(batch: (client: PoolClient) => Promise<T>): Promise<T> => {
      // A refused call runs no SQL and opens no transaction, so it is not a
      // batch and never enters `pending`. It is still a rejected promise
      // handed to code that may well ignore it (a late call from a timer, a
      // retained closure, or verifyComplete), so an inert observer is
      // attached to the returned object itself: refusing a call must never
      // be able to kill the process with an unhandled rejection. A caller
      // that does await it still sees the rejection.
      const refuse = (error: Error): Promise<T> => {
        const refused = Promise.reject<T>(error);
        void refused.catch(() => undefined);
        return refused;
      };
      if (lifecycle !== "active") return refuse(ambiguity ?? new BatchLifecycleClosedError(entry.id));
      const budget = remainingBudgetMs(deadlineMs);
      if (budget <= 0) {
        return refuse(new MigrationExecutionError(
          "wall_clock_exceeded",
          "the migration's wall-clock budget was exhausted before the next batch could start",
          entry.id,
        ));
      }
      batchNumber += 1;
      const number = batchNumber;
      // Registered synchronously, in the same tick as the guard above and
      // before this batch's own body ever reaches an `await` — nothing
      // handler- or verifier-authored code does with the returned promise
      // (ignore it, retain it, attach nothing) can prevent this executor
      // from later discovering and waiting for it.
      // One promise object, registered and returned: the exact same object
      // goes into `pending` and back to the caller, never two independent
      // chains. Only a promise with its own attached handler is exempted
      // from Node's unhandledRejection detection, so tracking one object
      // while handing a different (e.g. `.finally`-derived) one to a caller
      // that discards it would leave that second object's rejection
      // unhandled even though the first was properly drained.
      const tracked = runOneBatch(number, budget, batch);
      // Ownership is taken here, synchronously, and released only by
      // settlePending()'s drain once it has consumed the outcome. This
      // observer exists so a batch that rejects *before* the drain reaches
      // it — the fire-and-forget case, where handler-authored code attaches
      // nothing of its own — is already handled at the moment it rejects,
      // rather than racing the drain to avoid a strict unhandled rejection
      // that would kill the process instead of reporting the real failure.
      // It swallows nothing: `tracked` itself still rejects for any caller
      // that does await it, settlePending() still waits for it, and the
      // outcome is recorded below rather than discarded.
      void tracked.catch((error: unknown) => {
        // A rejection nobody awaited is still this executor's to answer for:
        // a handler that starts a batch and forgets it must never let a
        // genuinely failed batch pass for a successful migration. Recorded
        // here and re-thrown by proveBatchesConsumed() at the next settle
        // point. First failure wins — it is the one that caused everything
        // after it, and runOneBatch has already written its own ledger event.
        // The total conversion (final review, CRITICAL 1): this runs inside a
        // rejection handler, where a throw would become an unhandled rejection
        // rather than a recorded batch failure.
        if (!unconsumedFailure) unconsumedFailure = errorValue(error);
      });
      pending.add(tracked);
      // PB-10 Step 3 Phase 2d: a batch owns the execution session for its whole
      // BEGIN/…/COMMIT, not merely for the supervised callback inside it, so
      // the terminal boundary is told about the whole batch rather than relying
      // on superviseSettlement's own registration. settlePending() normally
      // drains every one of these long before disposal — this is what makes the
      // one path where it cannot (the structural-invariant violation
      // proveBatchesConsumed() throws on) destroy the client instead of
      // resetting a session a batch may still be committing on.
      context.noteExecutionWork(tracked);
      return tracked;
    },
  };

  try {
    try {
      await handler.execute(batchContext);
    } finally {
      // Blocker 1: the lifecycle closes the instant handler.execute()
      // settles — success or throw — synchronously, before a single
      // `await`, so no chained continuation from an already-started batch
      // (a `.then()` the handler attached to a call it never awaited) can
      // slip a *fresh* registration through during the draining below. This
      // is what makes runBatch structurally unreachable from verifyComplete,
      // from a retained closure, from a timer, from a queued microtask, or
      // from a delayed promise continuation: every one of those is, by
      // definition, code that runs after this line, and lifecycle is never
      // reopened once it leaves "active" for the rest of this call.
      lifecycle = "closed";
      // Blocker 1 (settlement): every batch this handler started — awaited
      // by it or not — must be fully settled (its real COMMIT/ROLLBACK
      // outcome known, its ledger events written, and any ambiguity latched)
      // before control ever leaves handler.execute(). Registrations are
      // already closed above, so this drains exactly the batches that were
      // legitimately in flight, never anything new.
      await settlePending();
    }
    // Blocker 1 (settlement): every settle point below re-proves, not
    // merely re-checks ambiguity but literally re-proves zero in-flight
    // batches remain — pending can only ever be non-empty here if some
    // future edit adds a new registration path that bypasses the closed
    // lifecycle, so this is a structural invariant assertion, not a normal
    // recoverable condition.
    const proveBatchesConsumed = (): void => {
      if (pending.size !== 0) {
        throw setAmbiguity(new MigrationExecutionError(
          "commit_outcome_unknown",
          `internal invariant violated: ${pending.size} batch(es) were still in flight at a point where zero were required`,
          entry.id,
        ));
      }
      // A batch that failed while nobody was awaiting it fails the whole
      // migration, exactly as it would have had the handler awaited it. Its
      // own transaction_rolled_back/ambiguity handling already ran inside
      // runOneBatch; this is what stops the run from continuing on to
      // verifyComplete, the applied-ledger insert, and a succeeded event as
      // though the batch had never failed.
      if (unconsumedFailure) throw unconsumedFailure;
    };

    // Blocker 1: handler.execute() resolving normally is not proof nothing
    // went wrong — a handler that caught runBatch's ambiguity error and
    // returned must still be overridden by the latch.
    if (ambiguity) throw ambiguity;
    proveBatchesConsumed();

    // Blocker 1: verifyComplete never receives a live runBatch — the
    // lifecycle above is already closed by the time it is called, so even a
    // malicious verifyComplete that retained its own closure reference to
    // batchContext (captured during execute() above) and calls runBatch
    // from inside itself gets nothing but an immediate, inert rejection
    // that touches no PostgreSQL connection. The latch is re-checked
    // immediately before calling verifyComplete and again immediately
    // after it resolves (or rejects), before its return value is ever
    // trusted — a latched ambiguity always overrides whatever verifyComplete
    // claims.
    if (ambiguity) throw ambiguity;
    const verified = await handler.verifyComplete(execution);
    await settlePending();
    if (ambiguity) throw ambiguity;
    proveBatchesConsumed();

    if (!verified) {
      await runLog.append(entry.id, "verification_failed", { execution_mode: "batched", verification: "failed" }, {
        errorClass: "verification_failed",
      });
      throw new MigrationExecutionError("verification_failed", "the batched completion verifier reported remaining eligible work", entry.id);
    }

    // Blocker 1: re-checked before every remaining success-shaped step —
    // the applied-ledger insert and both terminal ledger events — so no
    // success state can ever be reached once the latch is set.
    if (ambiguity) throw ambiguity;
    proveBatchesConsumed();
    await runLog.recordApplied(control, entry);
    if (ambiguity) throw ambiguity;
    proveBatchesConsumed();
    await runLog.append(entry.id, "applied_committed", { execution_mode: "batched", verification: "passed" });
    if (ambiguity) throw ambiguity;
    proveBatchesConsumed();
    await runLog.append(entry.id, "succeeded", {
      execution_mode: "batched",
      verification: "passed",
      duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
    });
    // Blocker 1: one last proof immediately before this function returns —
    // no code path between here and the return statement can start a batch
    // (the lifecycle has been closed since handler.execute() settled), so
    // this is the final confirmation that executeBatched never returns with
    // any started batch still unsettled.
    if (ambiguity) throw ambiguity;
    proveBatchesConsumed();
  } catch (error) {
    // Whatever the handler actually threw or returned, a latched ambiguity
    // always wins: it can never be reclassified, downgraded, or swallowed by
    // handler-authored code, no matter how many extra catches, retries or
    // asynchronous steps that code runs after observing it.
    const effective = ambiguity ?? error;
    const errorClass = recordedErrorClass(effective);
    // `batch_number` is a within-attempt operation identifier and is valid
    // only from 1 (see eventBelongsToAttempt). A failure before any batch ever
    // started has no batch to name, and writing 0 there produced a terminal
    // event that contradicted its own attempt's identity — permanently
    // malformed history for the commonest batched failure of all.
    const metadata: EventMetadata = {
      execution_mode: "batched",
      checksum_sha256: checksum,
      ...(batchNumber > 0 ? { batch_number: batchNumber } : {}),
    };
    const extra = { sqlstate: errorSqlstate(effective), errorClass };
    if (errorClass === "commit_outcome_unknown") {
      await appendAmbiguityDurably(runLog, context.acquireIndependentControl, entry.id, metadata, extra);
    } else if (errorClass !== "verification_failed") {
      // verification_failed already recorded its own distinct ledger event
      // type above; recording it again here would be a duplicate terminal
      // event for the same failure.
      await runLog.append(entry.id, "execution_failed", metadata, extra);
    }
    throw classify(effective, errorClass, entry.id, "batched execution failed");
  }
}

// ════════════════════════════════════════════════════════════════════════
// executeMigrations(pool) implementation (unchanged behavior)
// ════════════════════════════════════════════════════════════════════════

/**
 * No migration above the legacy boundary exists yet, so both lookups return
 * undefined for every id and every nontransactional/batched migration fails
 * closed on an unsupported-handler error until a reviewed handler is written
 * in ./handlers. Deliberately two functions, never a mutable map: see that
 * module's own doc.
 */
const registeredHandlers: MigrationHandlers = {
  nontransactional: nontransactionalHandlerFor,
  batched: batchedHandlerFor,
};

function sha256(bytes: NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * PB-10 Step 3 Phase 2c final review, HIGH 3: MIGRATION_RUNNER_ID stays
 * optional for the operator, but a *null* runner id is not an option for the
 * ledger. Manual stale_reclaimed resolution correlates against the armed
 * event's own runner identity, so an attempt written without one could record
 * a replay-blocking `started` row that no accepted resolution could ever
 * clear — an unrecoverable ledger record created by nothing worse than an
 * unset environment variable.
 *
 * So the runner id is generated when none is supplied. It does not need to be
 * meaningful, reproducible or re-derivable by a later process: it needs to be
 * unique, immutable and *durable in the row itself*. The operator recovers it
 * by reading it back out of migration_control.migration_runs (see
 * db/README.md), which is exactly where it survives the death of the process
 * that generated it. randomBytes, deliberately not randomUUID: the run id's
 * generator is substituted in tests, and these two identities must never
 * collapse into the same value.
 */
function generateRunnerId(): string {
  return `pb10-runner-${randomBytes(16).toString("hex")}`;
}

function identityFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ExecutionIdentity {
  return validateExecutionIdentity({
    sourceGitSha: environment.MIGRATION_SOURCE_GIT_SHA ?? "",
    executorImageDigest: environment.MIGRATION_EXECUTOR_IMAGE_DIGEST ?? "",
    runnerId: environment.MIGRATION_RUNNER_ID ?? generateRunnerId(),
  });
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

/**
 * Legacy files carry their own BEGIN/COMMIT and are executed as one unchanged
 * multi-statement payload: no outer transaction, no parsing, no splitting.
 *
 * The commit-to-ledger crash window is accepted and deliberate for legacy only.
 * If the file commits and the process dies before the control-connection INSERT,
 * the next run sees prior events with no applied row and refuses to replay.
 *
 * PB-10 Step 3 Phase 2c final review, CRITICAL 2: legacy-verbatim no longer has
 * a retry evaluator of its own. It previously used a separate function that
 * accepted a hand-shaped event sequence as proof of a safe retry, outside the
 * canonical attempt identity, outside the complete-history inspection, and
 * outside the outcome-proof rules every other mode obeys — so the mode with the
 * *least* provable outcome had the *weakest* gate. It now goes through exactly
 * the same fence as transactional, batched and nontransactional
 * (assertNoUnresolvedCommitAmbiguity).
 *
 * The consequence is deliberate and fails closed: because the payload owns its
 * own BEGIN/COMMIT, this runner has no transaction to bind (see
 * bindTransactionOutcome) and no artifact written atomically with it, so a
 * failed legacy attempt has no authoritative outcome proof and blocks replay
 * until an operator records a stale_reclaimed resolution. That is the honest
 * answer for a mode whose commit boundary is genuinely unobservable; the
 * previous behaviour was automatic replay on the strength of a label.
 */
async function executeLegacyVerbatim(context: MigrationContext): Promise<void> {
  const { entry, control, execution, runLog, bytes, checksum } = context;
  const decision = await applyExecutionDecision(context);

  const startedAt = context.now();
  const deadlineMs = monotonicMs() + entry.timeouts.wallClockMs;
  // H2: checksum_sha256 is carried on the armed row, exactly as transactional
  // and batched already do. Without it a legacy attempt's identity is
  // `legacy_provable`/`legacy_unprovable` at best, so it could never reach a
  // mode evaluator at all and manual resolution could not correlate to it.
  await runLog.append(entry.id, "started", { execution_mode: "legacy-verbatim", checksum_sha256: checksum }, {
    heartbeatDeadline: new Date(Date.now() + entry.timeouts.wallClockMs),
  });
  // H2: proves this attempt was written by an executor that records durable
  // progress, so the absence of the durable-work marker below actually means
  // "nothing was issued" rather than "nobody was recording".
  await markAttemptProgress(context, ATTEMPT_ARMED_ORDINAL);

  if (decision === "adopt") {
    // A reviewed recovery verifier proved the desired state already exists
    // (see evaluateVerifierLedOutcome). The payload is not re-run: replaying a
    // self-committing legacy file over its own completed effects is exactly
    // what this mode has no way to make safe.
    await runLog.append(entry.id, "operation_completed", {
      execution_mode: "legacy-verbatim",
      verification: "passed",
      retry_count: 1,
    });
    await runLog.recordApplied(control, entry);
    await runLog.append(entry.id, "applied_committed", { execution_mode: "legacy-verbatim", verification: "passed" });
    await runLog.append(entry.id, "succeeded", {
      execution_mode: "legacy-verbatim",
      verification: "passed",
      duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
    });
    return;
  }

  // Session-level only: the payload owns its own transaction, so SET LOCAL has
  // nowhere to live and wrapping it in one is prohibited.
  await applyTimeouts(execution, entry.timeouts, false);

  const budget = remainingBudgetMs(deadlineMs);
  if (budget <= 0) {
    await runLog.append(entry.id, "execution_failed", { execution_mode: "legacy-verbatim" }, { errorClass: "wall_clock_exceeded" });
    throw new MigrationExecutionError("wall_clock_exceeded", "no wall-clock budget remained before the legacy payload could begin", entry.id);
  }

  // H2: durable, on the control connection, before a single byte of the
  // self-committing payload is issued. Its absence — for an attempt that
  // carries the armed marker above — is the only authoritative proof this mode
  // can ever offer that nothing durable happened.
  await markAttemptProgress(context, WORK_STARTED_ORDINAL);

  try {
    await superviseOperation(context, bytes.toString("utf8"), budget);
  } catch (error) {
    // The legacy payload is one opaque blob that carries its own internal
    // BEGIN/COMMIT: a cancellation cannot be proven to have landed before or
    // after that internal COMMIT, so on any cancellation-driven outcome
    // (confirmed or unverified) no rollback is ever claimed and the
    // connection is never reused — Phase 2c's full ambiguous-COMMIT
    // reconciliation will replace this coarse fail-closed treatment.
    const cancellationDriven = error instanceof MigrationExecutionError
      && (error.errorClass === "wall_clock_exceeded" || error.errorClass === "cancellation_unverified");
    if (cancellationDriven) {
      // An already-unverified cancellation destroyed the connection exactly
      // once inside supervision; only a confirmed (wall_clock_exceeded)
      // cancellation still needs this call.
      if (error.errorClass !== "cancellation_unverified") context.destroyExecution();
      await runLog.append(entry.id, "execution_failed", { execution_mode: "legacy-verbatim" }, {
        sqlstate: errorSqlstate(error),
        errorClass: "cancellation_unverified",
      });
      throw new MigrationExecutionError(
        "cancellation_unverified",
        "legacy payload wall-clock outcome could not be confirmed",
        entry.id,
        errorSqlstate(error),
      );
    }

    let rolledBack = false;
    try {
      await execution.query("rollback");
      rolledBack = true;
    } catch {
      context.destroyExecution();
    }
    if (!rolledBack) {
      // ROLLBACK itself was not proven: never claim transaction_rolled_back
      // or sql_failed for a transaction whose final state is unknown. The
      // durable commit_outcome_unknown marker additionally makes the attempt
      // resolvable only by an operator, on top of legacy-verbatim already
      // having no authoritative outcome proof of its own.
      await appendAmbiguityDurably(runLog, context.acquireIndependentControl, entry.id, { execution_mode: "legacy-verbatim" }, {
        sqlstate: errorSqlstate(error),
        errorClass: "commit_outcome_unknown",
      });
      throw new MigrationExecutionError(
        "commit_outcome_unknown",
        "legacy payload rollback could not be confirmed; the transaction's final state is unknown",
        entry.id,
        errorSqlstate(error),
      );
    }
    await runLog.append(entry.id, "transaction_rolled_back", { execution_mode: "legacy-verbatim" }, {
      sqlstate: errorSqlstate(error),
      errorClass: "sql_failed",
    });
    await runLog.append(entry.id, "execution_failed", { execution_mode: "legacy-verbatim" }, {
      sqlstate: errorSqlstate(error),
      errorClass: "sql_failed",
    });
    throw classify(error, "sql_failed", entry.id, "legacy payload failed");
  }

  await runLog.append(entry.id, "operation_completed", {
    execution_mode: "legacy-verbatim",
    duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
  });

  // ── accepted legacy crash window opens here ──
  await runLog.recordApplied(control, entry);
  await runLog.append(entry.id, "applied_committed", { execution_mode: "legacy-verbatim" });
  await runLog.append(entry.id, "succeeded", {
    execution_mode: "legacy-verbatim",
    duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
  });
}

/**
 * PB-10 Step 3 Phase 2c final review, CRITICAL 1: binds this attempt to the
 * real migration transaction, and commits that binding durably *before* the
 * transaction's fate is decided.
 *
 * pg_current_xact_id() is read on the execution connection inside the open
 * transaction, so the value is that transaction's own full 64-bit id — the DDL
 * about to run would assign one anyway. The binding row is then written on the
 * control connection, which is in autocommit, so it survives both COMMIT and
 * ROLLBACK of the transaction it describes.
 *
 * Failing to bind fails the migration *before* any migration SQL runs, rather
 * than executing an attempt whose outcome could never afterwards be proven:
 * an unbindable attempt that later failed would block replay permanently.
 */
async function bindTransactionOutcome(context: MigrationContext): Promise<void> {
  const { entry, execution, runLog } = context;
  // Half one, on the execution connection inside the open transaction: the
  // database reads pg_current_xact_id() itself and returns an authenticated
  // claim. This process never names a transaction id.
  const claim = await runLog.claimTransaction(execution, entry.id);
  // Half two, on the control connection in autocommit: durable before any
  // risky migration SQL, and accepted only because the claim proves the
  // transaction it names really did execute claim_transaction for this exact
  // attempt.
  await runLog.recordTransactionBinding(entry.id, claim);
}

/**
 * Migration SQL and its applied-ledger row commit together or not at all: both
 * run on the execution connection inside one transaction.
 */
async function executeTransactional(context: MigrationContext): Promise<void> {
  const { entry, control, execution, runLog, bytes, checksum } = context;
  // H2: transactional mode never adopts — an attempt with protected commit
  // proof has an applied row, and a migration with an applied row is not
  // pending, so this branch is unreachable by construction rather than merely
  // unused (see evaluateTransactionalOutcome).
  assertCondition(
    await applyExecutionDecision(context) === "execute",
    `Refusing an adoption decision for transactional migration ${entry.id}`,
  );
  const startedAt = context.now();
  // One absolute deadline for the whole migration, derived once, right where
  // the started event/heartbeat deadline is established. Nothing below ever
  // re-derives it from a fresh wallClockMs.
  const deadlineMs = monotonicMs() + entry.timeouts.wallClockMs;
  await runLog.append(entry.id, "started", { execution_mode: "transactional", checksum_sha256: checksum }, {
    heartbeatDeadline: new Date(Date.now() + entry.timeouts.wallClockMs),
  });

  if (remainingBudgetMs(deadlineMs) <= 0) {
    throw new MigrationExecutionError("wall_clock_exceeded", "no wall-clock budget remained before the transaction could begin", entry.id);
  }

  try {
    await execution.query("begin");
  } catch (error) {
    throw classify(error, "sql_failed", entry.id, "could not open the migration transaction");
  }

  let commitStarted = false;
  try {
    // CRITICAL 1: bound first, before any migration SQL and long before COMMIT,
    // so PostgreSQL's own verdict on this exact transaction is available to
    // every future evaluation of this attempt.
    await bindTransactionOutcome(context);
    const budgetBeforeSql = remainingBudgetMs(deadlineMs);
    if (budgetBeforeSql <= 0) {
      throw new MigrationExecutionError("wall_clock_exceeded", "wall-clock budget was exhausted before the migration statement could begin", entry.id);
    }
    // PostgreSQL retains its independently declared ceilings. The
    // control-side supervisor below enforces the smaller remaining migration
    // budget without racing transaction_timeout, which terminates the session
    // instead of following the accepted pg_cancel_backend/57014 contract.
    await applyTimeouts(execution, entry.timeouts, true);
    await superviseOperation(context, bytes.toString("utf8"), budgetBeforeSql);

    const budgetBeforeInsert = remainingBudgetMs(deadlineMs);
    if (budgetBeforeInsert <= 0) {
      throw new MigrationExecutionError("wall_clock_exceeded", "wall-clock budget was exhausted before the applied-ledger insert; COMMIT was never sent", entry.id);
    }
    await runLog.recordApplied(execution, entry);

    const budgetBeforeCommit = remainingBudgetMs(deadlineMs);
    if (budgetBeforeCommit <= 0) {
      throw new MigrationExecutionError("wall_clock_exceeded", "wall-clock budget was exhausted before COMMIT was sent", entry.id);
    }
    // Once COMMIT is sent, its outcome can no longer be treated as ambiguous
    // in our favour: any failure from here on must not claim rollback or
    // sql_failed, and must not create retry eligibility. See the catch below.
    commitStarted = true;
    await execution.query("commit");
  } catch (error) {
    if (commitStarted && errorSqlstate(error) === null) {
      // No genuine PostgreSQL ErrorResponse for COMMIT: a client-side query
      // timeout, socket loss, or any other transport-level failure can all
      // reject this promise while COMMIT actually lands on the server —
      // and connection liveness proves nothing either way (Phase 2c
      // blocker 2: a later successful probe on this same connection can
      // simply be queued behind a COMMIT that the server already completed).
      // The migration SQL and its applied-ledger row share this one
      // transaction, so an independent query against the exact canonical
      // identity (migration_id + ordinal + run_id + applied checksum) is
      // the only authoritative signal — never a guess, never inferred from
      // the connection's own behaviour.
      context.destroyExecution();
      const reconciliation = await reconcileAmbiguousCommit(control, entry.id, context.ordinal, runLog.runId, checksum);
      if (reconciliation === "committed") {
        await runLog.append(entry.id, "applied_committed", { execution_mode: "transactional" });
        await runLog.append(entry.id, "succeeded", {
          execution_mode: "transactional",
          duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
        });
        return;
      }
      // Absent, or reconciliation itself failed: fail closed. Never claim
      // sql_failed or transaction_rolled_back for a post-COMMIT transport
      // failure, and never create retry-eligible history —
      // assertNoUnresolvedCommitAmbiguity blocks every future attempt until
      // an operator records a valid stale_reclaimed ledger event. Persisted
      // durably (blocker 3): if the control connection that discovered this
      // is also unusable for the INSERT, an independently acquired
      // connection carries it instead.
      await appendAmbiguityDurably(runLog, context.acquireIndependentControl, entry.id, { execution_mode: "transactional", checksum_sha256: checksum }, {
        sqlstate: errorSqlstate(error),
        errorClass: "commit_outcome_unknown",
      });
      throw new MigrationExecutionError(
        "commit_outcome_unknown",
        "COMMIT was sent and its outcome could not be confirmed; ledger reconciliation did not prove the migration committed",
        entry.id,
      );
    }

    // Either COMMIT was never sent, or it was and the rejection carried a
    // genuine PostgreSQL ErrorResponse (a real SQLSTATE) — the one case
    // PostgreSQL itself guarantees no commit occurred. Both fall through to
    // the same rollback handling below.
    const sqlstate = errorSqlstate(error);
    const causeClass = recordedErrorClass(error);
    const wallClockDriven = causeClass === "wall_clock_exceeded" || causeClass === "cancellation_unverified";

    if (wallClockDriven) {
      // A cancellation that supervision already deemed unverified has
      // already destroyed the connection exactly once and left it in an
      // unknown state: attempting another query on it would not prove
      // anything, so rollback is only attempted when the connection state
      // actually permits it (a confirmed, not-yet-unverified cancellation),
      // and this block must never call destroyExecution() a second time for
      // the same outcome.
      const alreadyUnverified = causeClass === "cancellation_unverified";
      let rolledBack = false;
      if (!alreadyUnverified) {
        try {
          await execution.query("rollback");
          rolledBack = true;
        } catch {
          // Handled once, below, via the shared !rolledBack branch.
        }
      }

      if (!rolledBack) {
        if (!alreadyUnverified) context.destroyExecution();
        // Phase 2c blocker 4: a cancellation whose own ROLLBACK cannot be
        // confirmed is exactly as ambiguous as an unconfirmed COMMIT — the
        // transaction's final state is unknown, so this must durably arm
        // the same non-replayable state as any other commit_outcome_unknown,
        // never the narrower cancellation_unverified class (which
        // assertNoUnresolvedCommitAmbiguity does not recognise and would
        // therefore leave this migration eligible for blind replay).
        await appendAmbiguityDurably(runLog, context.acquireIndependentControl, entry.id, { execution_mode: "transactional", checksum_sha256: checksum }, {
          sqlstate,
          errorClass: "commit_outcome_unknown",
        });
        throw new MigrationExecutionError(
          "commit_outcome_unknown",
          "transactional migration rollback could not be confirmed after cancellation; the transaction's final state is unknown",
          entry.id,
          sqlstate,
        );
      }

      // Both events go to the control connection, so they survive the rollback.
      await runLog.append(entry.id, "transaction_rolled_back", { execution_mode: "transactional", checksum_sha256: checksum }, { sqlstate, errorClass: causeClass });
      await runLog.append(entry.id, "execution_failed", { execution_mode: "transactional", checksum_sha256: checksum }, { sqlstate, errorClass: causeClass });
      throw classify(error, causeClass, entry.id, "transactional migration rolled back");
    }

    // A genuine (non-wall-clock) SQL failure, or an authoritative COMMIT
    // rejection falling through from above: unchanged pre-Phase-2b
    // behaviour, except (blocker 4) transaction_rolled_back is recorded
    // only once ROLLBACK itself is proven to have succeeded.
    let rolledBack = false;
    try {
      await execution.query("rollback");
      rolledBack = true;
    } catch {
      context.destroyExecution();
    }
    if (!rolledBack) {
      await appendAmbiguityDurably(runLog, context.acquireIndependentControl, entry.id, { execution_mode: "transactional", checksum_sha256: checksum }, {
        sqlstate,
        errorClass: "commit_outcome_unknown",
      });
      throw new MigrationExecutionError(
        "commit_outcome_unknown",
        "ROLLBACK could not be confirmed after a SQL failure; the transaction's final state is unknown",
        entry.id,
        sqlstate,
      );
    }
    await runLog.append(entry.id, "transaction_rolled_back", { execution_mode: "transactional", checksum_sha256: checksum }, { sqlstate, errorClass: "sql_failed" });
    await runLog.append(entry.id, "execution_failed", { execution_mode: "transactional", checksum_sha256: checksum }, { sqlstate, errorClass: "sql_failed" });
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
 * One independently retry-safe operation, never wrapped in a transaction. The
 * applied row is written only once a migration-specific verifier proves the
 * operation is complete; an invalid or partial state is never blindly replayed.
 */
async function executeNontransactional(context: MigrationContext): Promise<boolean> {
  const { entry, control, execution, runLog, checksum } = context;
  // CRITICAL 2: the same canonical fence as every other mode, before anything
  // mode-specific — including the handler lookup, whose refusal would otherwise
  // mask an unresolved prior attempt. H2 adds Stage 2 behind it; an `adopt`
  // decision needs no separate branch here, because this mode's own pre-flight
  // inspect() below is the very same verifier and reaches the same conclusion.
  await applyExecutionDecision(context);
  const handler = context.handlers.nontransactional(entry.id);
  if (!handler) {
    throw new MigrationExecutionError(
      "unsupported_handler",
      "nontransactional execution requires a reviewed migration-specific verifier; none is registered",
      entry.id,
    );
  }

  const startedAt = context.now();
  // H2: checksum_sha256 on the armed row, for the same reason as
  // legacy-verbatim above — without it this attempt could never be correlated
  // by a mode evaluator or by a manual resolution.
  await runLog.append(entry.id, "started", { execution_mode: "nontransactional", checksum_sha256: checksum }, {
    heartbeatDeadline: new Date(Date.now() + entry.timeouts.wallClockMs),
  });
  // H2: proves this attempt was written by an executor that records durable
  // progress, so the absence of the durable-work marker below actually means
  // "nothing was issued" rather than "nobody was recording".
  await markAttemptProgress(context, ATTEMPT_ARMED_ORDINAL);

  const before = await handler.inspect(execution);
  let adopted = false;

  if (before === "invalid" || before === "unknown") {
    await runLog.append(entry.id, "verification_failed", { execution_mode: "nontransactional", verification: "failed" }, {
      errorClass: "verifier_state_invalid",
    });
    throw new MigrationExecutionError(
      "verifier_state_invalid",
      before === "unknown"
        ? "the verifier could not classify the current state; explicit verifier-led recovery is required and blind replay is refused"
        : "the verifier reports an invalid or partial state; explicit verifier-led recovery is required and blind replay is refused",
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
    // H2: durable before the payload is issued — its absence, for an armed
    // attempt, is the only authoritative proof that no statement can have run.
    await markAttemptProgress(context, WORK_STARTED_ORDINAL);
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

  await runLog.recordApplied(control, entry);
  await runLog.append(entry.id, "applied_committed", { execution_mode: "nontransactional", verification: "passed" });
  await runLog.append(entry.id, "succeeded", {
    execution_mode: "nontransactional",
    verification: "passed",
    duration_ms: Math.max(0, Math.trunc(context.now() - startedAt)),
  });
  return adopted;
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

/**
 * PB-10 Step 3 Phase 2c blocker 6: pg-pool's own idleListener (installed
 * unconditionally by `_release`, even for a *destructive* release — see
 * pg-pool/index.js's `_release`/`makeIdleListener`) re-attaches a client
 * 'error' listener that, on a later delayed error, excises the client and
 * then always calls `pool.emit('error', ...)`. This is pg-pool's documented,
 * intended contract (node-postgres's own docs: "the pool itself will emit an
 * error on behalf of any client which emits an error event") — not a defect
 * this code can route around by removing pg-pool's own listener — and an
 * EventEmitter throws an uncaught exception for an 'error' event with zero
 * listeners, so the only safe, documented way to absorb it is a listener on
 * the pool itself, exactly as node-postgres instructs every consumer to
 * install. By the time this ever fires, pg-pool has already excised the
 * erroring client (never a reusable dead connection), so there is nothing
 * left to do beyond simply not crashing the process.
 *
 * A stable, no-closure-state module-level function (rather than one
 * recreated per call) lets this be installed idempotently: a delayed error
 * can arrive arbitrarily long after the run that triggered it has already
 * returned, so this is never removed once attached — only ever added once
 * per pool object, by reference identity, so a caller invoking
 * executeMigrations(pool) repeatedly against the same long-lived pool never
 * accumulates a second listener.
 *
 * PB-10 Step 3 Phase 2c blocker 6 (release hardening): absorbing the event
 * silently is not the same as *observing* it — an operator with no signal
 * at all cannot distinguish "nothing happened" from "a client is being
 * silently discarded on every deploy". This reports a fixed, whitelisted
 * diagnostic instead of a pure no-op, while still never risking a crash: it
 * reads at most one whitelisted `.code` field (a driver error code or
 * SQLSTATE, both short fixed-alphabet strings) and never touches
 * `.message`, `.stack`, `.hostname`, `.address`, `.config`, or the raw
 * error/client object itself, any of which can carry a connection string,
 * hostname, username, password, certificate material or SQL text.
 * `process.emitWarning` is documented to never throw and never become an
 * `uncaughtException`/`unhandledRejection`, satisfying the same
 * never-crash contract as the previous pure no-op.
 */
function onPoolError(error: Error): void {
  reportSanitizedPoolError(error);
}

function guardPoolErrors(pool: Pool): void {
  if (!pool.listeners("error").includes(onPoolError)) pool.on("error", onPoolError);
}

/**
 * PB-10 Step 3 Phase 2d final review, CRITICAL 1: the one *total* conversion
 * from an arbitrary thrown value to an Error. It is called from inside the
 * terminal lifecycle boundary, so it may not itself be the operation that
 * prevents a disposition — for every JavaScript value, including every value
 * chosen specifically to be hostile, it returns an Error and does not throw.
 *
 * The previous shape was `error instanceof Error ? error : new Error(String(error))`,
 * and both halves of it are fallible:
 *
 *  - `String(x)` performs ToPrimitive on an object, which runs
 *    `Symbol.toPrimitive`, `valueOf` and `toString` — user code that may throw,
 *    and which is *absent altogether* on a null-prototype object like
 *    `Object.create(null)`, where the language then throws a TypeError of its
 *    own ("Cannot convert object to primitive value").
 *  - `x instanceof Error` is not a safe pre-check either: for a Proxy it walks
 *    the prototype chain through the `getPrototypeOf` trap, which can throw
 *    before any conversion is even attempted.
 *
 * The independent review demonstrated the consequence: a listener/setup call
 * that threw such a value made the disposer's own `catch` throw, and the client
 * — already checked out — reached its `release()` zero times. One occurrence
 * permanently consumes a slot of a bounded production pool.
 *
 * Totality here is structural rather than argued:
 *
 *  1. every step, including the `instanceof` probe, runs inside the guard;
 *  2. `String()` is applied *only* to values whose `typeof` already proves they
 *    are primitives (or to `null`), where the language guarantees the
 *    conversion runs no user code at all — this is what keeps an ordinary
 *    thrown string, number, bigint, boolean, symbol, `undefined` or `null`
 *    diagnostically useful;
 *  3. objects and functions — the only values that can carry a hostile
 *    conversion — are described by a fixed literal, never coerced;
 *  4. the fallback message is a constant, so producing it needs nothing from
 *    the value it is describing.
 *
 * Deliberately *not* used: `JSON.stringify` (calls `toJSON`, throws on cycles
 * and on bigint), `util.inspect` (honours `Symbol.for("nodejs.util.inspect.custom")`,
 * i.e. arbitrary user code), and `Object.prototype.toString.call` (reads
 * `Symbol.toStringTag`, which may be a throwing getter or a Proxy trap). Each
 * would reintroduce exactly the class of failure this exists to remove.
 *
 * Identity is preserved wherever the error contract depends on it: a real Error
 * is returned unchanged, which is what keeps `assert.equal(error, original)`
 * and the AggregateError ordering contract meaningful.
 */
const UNREPRESENTABLE_THROWN_VALUE =
  "the migration runner caught a thrown value that is not an Error and cannot be safely converted to text";

function errorValue(error: unknown): Error {
  try {
    if (error instanceof Error) return error;
    // `typeof` cannot throw for any value, and every branch it admits here is a
    // primitive whose String() conversion is defined by the language itself.
    const kind = typeof error;
    if (error === null || (kind !== "object" && kind !== "function")) {
      return new Error(String(error as null | undefined | boolean | number | bigint | string | symbol));
    }
  } catch {
    // Intentionally ignored: a value that resists inspection is described by
    // the constant below rather than allowed to abort a disposition.
  }
  return new Error(UNREPRESENTABLE_THROWN_VALUE);
}

// ════════════════════════════════════════════════════════════════════════
// PB-10 Step 3 Phase 2d: the single terminal lifecycle boundary for every
// migration-owned pooled PostgreSQL client.
//
// Module-private on purpose, and deliberately *not* exported: `executeMigrations
// (pool)` remains the sole production migration-execution entry point, and a
// reachable reset coordinator / client disposer / connection acquirer would be
// exactly the alternate boundary Phase 2c's public-surface regression exists to
// forbid. The migration executor reaches this function the only way anything
// can — as an argument handed to the callback that already runs *inside* the
// schema advisory lock (see withSchemaAdvisoryLock below), so it is reachable
// only from code the lock owner itself invoked, never by name and never by a
// deep require of the emitted build.
// ════════════════════════════════════════════════════════════════════════

/**
 * The whole terminal sequence — ROLLBACK, DISCARD ALL and the baseline proof —
 * is three trivial round trips (measured at well under a millisecond each
 * against a local PostgreSQL 17). This is not a tuning knob: it is the point
 * past which a session that will not answer is treated as unusable rather than
 * waited on. Expiry is proof of *failure*, never proof of completion — the
 * client is destroyed, never returned.
 *
 * A client-side deadline is the only mechanism that survives the case it exists
 * for. `statement_timeout` cannot bound this: nontransactional mode sets
 * `statement_timeout = 0` at *session* level on the execution connection, and
 * raising it again would itself be a round trip that can hang for the same
 * reason. A dead-but-not-closed socket answers nothing at all.
 */
const SESSION_RESET_BUDGET_MS = 5_000;

/**
 * PB-10 Step 3 Phase 2d: the reusable-session baseline, proven rather than
 * assumed.
 *
 * `source = 'session'` is the authoritative, complete test for "this session
 * changed a setting", and it is exactly zero on a freshly connected client —
 * verified empirically against PostgreSQL 17. It is deliberately used in place
 * of `setting is distinct from reset_val`, which reports eight permanent false
 * positives on any fresh connection (archive_command, data_directory_mode,
 * external_pid_file, log_file_mode, the three tcp_keepalives_* settings and
 * unix_socket_permissions all render differently from their reset value without
 * anything having touched them), and would therefore have condemned every
 * healthy client. It covers `search_path`, `statement_timeout`, `lock_timeout`,
 * `transaction_timeout`, `idle_in_transaction_session_timeout` and
 * `application_name` uniformly, because all of them are ordinary enumerable
 * GUCs.
 *
 * `role` (SET ROLE) and `session_authorization` (SET SESSION AUTHORIZATION) are
 * deliberately *not* among them, and this is the reason the role cross-check
 * below is not redundant with the GUC accounting: PostgreSQL marks both
 * GUC_NO_SHOW_ALL, so neither is a row in pg_settings at all and the
 * `source = 'session'` count can never see either one (verified empirically
 * against PostgreSQL 17.10, and pinned by an assertion in
 * migration-session-reset.pg.test.ts so a future server change fails a test
 * rather than silently narrowing this contract). SET ROLE is caught by
 * `current_user = session_user`; SET SESSION AUTHORIZATION moves session_user
 * with it and so is caught by neither — it is superuser-only, and the
 * migration execution role is required not to be a superuser (a superuser
 * connection is refused outright by verifyControlSchema), so no migration this
 * runner can legally execute can produce it. DISCARD ALL restores it in any
 * case, which the same suite proves administratively.
 *
 * The remaining columns cover the session resources no GUC records: advisory
 * locks this backend still holds, LISTEN subscriptions, server-side prepared
 * statements, open (including WITH HOLD) cursors, and temporary objects in this
 * backend's own temp schema. `pg_my_temp_schema()` returns 0 when the session
 * never created one, which matches no row.
 *
 * `current_user = session_user` is an independent cross-check on the role
 * baseline: it does not rely on the GUC accounting above being complete.
 *
 * A custom session GUC set through `set_config('some.key', …, false)` is not
 * enumerable here — PostgreSQL does not list an unregistered placeholder in
 * pg_settings — but DISCARD ALL's RESET ALL does clear it, which the real
 * PostgreSQL suite proves from the *next borrower* rather than from this query.
 */
const SESSION_BASELINE_SQL = `
  select (select count(*) from pg_catalog.pg_settings where source = 'session') as dirty_settings,
         (select count(*) from pg_catalog.pg_locks
           where locktype = 'advisory' and pid = pg_catalog.pg_backend_pid()) as advisory_locks,
         (select count(*) from pg_catalog.pg_listening_channels()) as listens,
         (select count(*) from pg_catalog.pg_prepared_statements) as prepared_statements,
         (select count(*) from pg_catalog.pg_cursors) as cursors,
         (select count(*) from pg_catalog.pg_class
           where relnamespace = pg_catalog.pg_my_temp_schema()) as temp_objects,
         (current_user = session_user) as role_baseline
`;

interface SessionBaselineRow {
  dirty_settings: string;
  advisory_locks: string;
  listens: string;
  prepared_statements: string;
  cursors: string;
  temp_objects: string;
  role_baseline: boolean;
}

/**
 * Restores one pooled session to the baseline a freshly connected client would
 * have, and *proves* it. Throws — which the caller always turns into
 * destruction, never into a healthy release — the moment any step fails or the
 * proof comes back short.
 *
 * Order is not incidental:
 *
 * 1. `ROLLBACK` first, unconditionally. DISCARD ALL is rejected outright inside
 *    an open transaction block (SQLSTATE 25001) and inside a failed one
 *    (25P02), both confirmed against PostgreSQL 17, so it can never be the
 *    first statement. Outside a transaction, ROLLBACK is a documented no-op
 *    that emits a warning and succeeds, so no transaction-state probe is
 *    needed — and no probe would be trustworthy anyway, since the answer could
 *    change between the probe and the statement it guarded.
 *
 * 2. `DISCARD ALL` second, and *alone in its own round trip*. It may not be
 *    concatenated with the ROLLBACK above: PostgreSQL wraps a multi-statement
 *    simple-query message in an implicit transaction block, which makes DISCARD
 *    ALL fail with the very 25001 the ROLLBACK was there to prevent (confirmed
 *    empirically). Its success is therefore also the proof that no transaction
 *    block remains — a property no separate query could establish as reliably.
 *
 *    DISCARD ALL is chosen over a hand-rolled reset sequence because it is the
 *    one mechanism whose coverage is defined by the server rather than by this
 *    file: CLOSE ALL, SET SESSION AUTHORIZATION DEFAULT, RESET ALL, DEALLOCATE
 *    ALL, UNLISTEN *, pg_advisory_unlock_all(), DISCARD PLANS, DISCARD TEMP and
 *    DISCARD SEQUENCES. An explicit list would have to be revisited every time
 *    a migration file learns to dirty something new; this cannot fall behind.
 *    It needs no privilege beyond being the session's own owner.
 *
 * 3. The baseline proof last. DISCARD ALL reporting success is not on its own
 *    evidence that the session is reusable — a returned session is only ever
 *    trusted because it was inspected.
 */
/**
 * PB-10 Step 3 Phase 2d, A4 final review: `DISCARD ALL` resets the *server's*
 * view of the session, but node-postgres keeps its own driver-side cache of
 * which named prepared statements it believes this physical connection
 * already has — `connection.parsedStatements`, a plain object keyed by
 * statement name (see node_modules/pg/lib/connection.js and query.js's
 * `hasBeenParsed`). Nothing in `DISCARD ALL` reaches that cache, because it is
 * client-side state the driver never round-trips to the server to invalidate.
 *
 * The failure this produces is not this migration run's own: this codebase
 * issues no named queries. It is the *next* borrower's, on whatever pool this
 * client belongs to. If any consumer of that pool ever issued a named query
 * on this same physical connection — before this migration run borrowed it,
 * or after it is handed back — node-postgres skips re-parsing a name it
 * believes is already prepared and sends only a Bind for it. The server has
 * no such prepared statement any more (DISCARD ALL removed it), so the Bind
 * fails with SQLSTATE 26000. A client returned as "reusable" must not carry
 * that landmine forward.
 *
 * The cache is a plain object, not a class instance, so replacing it with an
 * empty one is the correct clear, and matches what a fresh connection starts
 * with. It is reached through `client.connection`, which `@types/pg` types on
 * every real `Client`/`PoolClient`. Any missing, inaccessible or unexpected
 * shape is a reset failure: a PoolClient-compatible wrapper may still delegate
 * named-query handling to node-postgres while hiding these internals, so the
 * absence of observable driver state cannot prove that state synchronized.
 */
function clearDriverPreparedStatementCache(client: PoolClient): void {
  const connection = (client as unknown as { connection?: unknown }).connection;
  assertCondition(
    typeof connection === "object" && connection !== null,
    "Session-reset could not inspect the driver's prepared-statement cache",
  );
  const record = connection as { parsedStatements?: unknown };
  const cache = record.parsedStatements;
  assertCondition(
    typeof cache === "object"
      && cache !== null
      && !Array.isArray(cache)
      && [Object.prototype, null].includes(Object.getPrototypeOf(cache)),
    "Session-reset could not prove the driver's prepared-statement cache clearable",
  );
  const cleared = {};
  record.parsedStatements = cleared;
  assertCondition(
    record.parsedStatements === cleared,
    "Session-reset could not prove the driver's prepared-statement cache cleared",
  );
}

async function resetPooledSession(client: PoolClient): Promise<void> {
  await client.query("rollback");
  await client.query("discard all");
  clearDriverPreparedStatementCache(client);
  const result = await client.query<SessionBaselineRow>(SESSION_BASELINE_SQL);
  const row = result.rows[0];
  assertCondition(row !== undefined, "Session-reset baseline proof returned no row");
  for (const column of ["dirty_settings", "advisory_locks", "listens", "prepared_statements", "cursors", "temp_objects"] as const) {
    assertCondition(row[column] === "0", `Session-reset baseline proof failed: ${column} is not clean`);
  }
  assertCondition(row.role_baseline === true, "Session-reset baseline proof failed: the session role is not at its baseline");
}

/**
 * PB-10 Step 3 Phase 2d: the one place any migration-owned pooled client is
 * ever handed back or thrown away, and the only place that decides which.
 *
 * Exactly-once is enforced by the latch `withSchemaAdvisoryLock` wraps around
 * this function (see disposeOnce below), never by this function itself, and the
 * distinction is not cosmetic. A latch keyed by the client object and held for
 * the process's lifetime looks stronger and is in fact unsound: pg-pool hands
 * out *the same PoolClient object* on a later checkout, so the second migration
 * run through one pool would find the first run's finished disposition, return
 * it unchanged, and thereby issue no reset and — the part that bites — no
 * `release()` at all. The client is then checked out forever; two such runs
 * exhaust a `max: 2` production pool and the third blocks indefinitely.
 *
 * The latch therefore lives for exactly one ownership episode, which is also
 * precisely the scope over which "exactly once" is the correct rule: while a
 * client is held, any number of owners, error handlers and finally blocks may
 * reach for it and only the first decides; once it has been handed back, it is
 * no longer this run's client to dispose of at all.
 *
 * Fail closed, without exception: a client is returned to the pool only when
 * every step above completed and proved the baseline. Every other outcome —
 * a caller that already knows the session is unusable, work that cannot be
 * proven settled, a reset statement that failed, a baseline proof that came
 * back short, a socket that died mid-reset, or a reset that did not answer
 * within its budget — destroys it instead. "Uncertain" is never "reusable".
 */
type ClientDisposition = "reused" | "destroyed";

interface DisposeClientRequest {
  /** Set when the owner already knows this session must never be reused. */
  destroy?: Error;
  /** The owner's own connection-'error' listener, removed exactly once, here. */
  ownerListener?: (error: Error) => void;
  /**
   * Returns false when any work this client owns cannot be proven to have
   * settled. A reset statement must never race an operation still using the
   * same session, and waiting on work that may never settle is not an option
   * either — so unsettled work destroys rather than delays.
   */
  workSettled?: () => boolean;
}

type DisposeClient = (client: PoolClient, request?: DisposeClientRequest) => Promise<ClientDisposition>;

/**
 * PB-10 Step 3 Phase 2d: the exactly-once latch, scoped to one ownership
 * episode — see disposeMigrationClient's own doc for why a process-lifetime
 * latch keyed by the client object silently leaks the client instead.
 *
 * One of these is created per `withSchemaAdvisoryLock` call and covers every
 * client that call owns: the pinned control connection it disposes of itself,
 * and the execution connection the action disposes of through the same
 * function. Its record is discarded with the episode itself, so nothing here
 * keeps a client alive beyond the run that borrowed it.
 */
function disposeOnce(): DisposeClient {
  // PB-10 Step 3 Phase 2d final review, CRITICAL 2: bookkeeping that *cannot*
  // fail, rather than bookkeeping that is merely expected not to.
  //
  // This was a `WeakMap`, and its `get`/`set` sat between an already-acquired
  // client and its terminal disposition: a lookup that throws means the client
  // is never disposed of at all, which is precisely the zero-disposition escape
  // the boundary exists to make impossible. "A native WeakMap does not throw"
  // is an argument about the environment, not a property of this code — and the
  // independent review demonstrated the escape by breaking exactly that
  // assumption.
  //
  // What replaces it is a plain array literal this function creates itself,
  // read and written by index only. No prototype method (not `push`, not
  // `find`, not `includes`), no keyed collection and no property of any object
  // this module did not construct is on the path: `length`, indexed access,
  // indexed assignment and `===` are the whole mechanism. The claim is not that
  // array mutation is universally infallible; it is that none of the
  // replaceable, user-reachable functions a keyed collection would have called
  // is on this path any more.
  //
  // Strong references are correct here where a WeakMap's were merely tidy: the
  // array's own lifetime is one `withSchemaAdvisoryLock` call, it holds at most
  // the two clients that call has checked out, and those clients are held by
  // the pool for at least that long anyway. Nothing outlives the episode.
  const disposed: { client: PoolClient; running: Promise<ClientDisposition> }[] = [];
  return (client, request) => {
    for (let index = 0; index < disposed.length; index += 1) {
      const entry = disposed[index];
      if (entry !== undefined && entry.client === client) return entry.running;
    }
    // PB-10 Step 3 Phase 2d final review, CRITICAL 2: CLAIM, then EXECUTE, then
    // SETTLE — in that order, and the claim becomes observable before a single
    // byte of disposition work runs.
    //
    // The previous shape ran the disposal body first and recorded the claim
    // afterwards:
    //
    //     const running = (async () => disposeMigrationClient(client, request))();
    //     disposed[disposed.length] = { client, running };
    //
    // An `async` IIFE executes synchronously up to its first `await`, and
    // `disposeMigrationClient`'s first statement installs an 'error' listener.
    // Node's EventEmitter emits `newListener` *synchronously, before the
    // listener is added*, so a real `newListener` handler on the client re-enters
    // this function while `disposed` is still empty — no claim exists yet, the
    // loop above finds nothing, and a second, competing disposition of the same
    // client begins. One ownership episode, two `release()` attempts. The
    // independent review demonstrated exactly this against a native emitter.
    //
    // The claim is now a bare deferred: constructing it runs no lifecycle work,
    // touches nothing the caller supplied and cannot re-enter anything, so
    // publishing it into `disposed` is safe to do *first*. `resolve` adopts the
    // disposal promise handed to it, so the published handle settles with the
    // real outcome — success or rejection — for every joiner, including a
    // synchronous reentrant one that arrives before the body has yielded.
    let claim!: (outcome: Promise<ClientDisposition>) => void;
    const running = new Promise<ClientDisposition>((resolve) => { claim = resolve; });
    // Owned synchronously, because a reentrant joiner may drop the handle it is
    // given. Every real awaiter still observes the rejection.
    running.catch(() => undefined);
    // The publication itself. Not a claim that array mutation is universally
    // infallible — a claim that this path calls no `WeakMap.get`, `Map.set`,
    // `Set.has` or `Array.prototype` method, each of which is a real,
    // replaceable, user-reachable function, and one of which (`WeakMap`) was
    // demonstrably able to throw between an acquired client and its disposal.
    disposed[disposed.length] = { client, running };
    // Only now, with ownership already visible, does anything fallible or
    // reentrant run. The async wrapper additionally turns a *synchronous* throw
    // from `disposeMigrationClient` into this episode's settled outcome rather
    // than an escape past the claim.
    claim((async () => disposeMigrationClient(client, request))());
    return running;
  };
}

function disposeMigrationClient(client: PoolClient, request: DisposeClientRequest = {}): Promise<ClientDisposition> {
  return (async (): Promise<ClientDisposition> => {
    // PB-10 Step 3 Phase 2d final review, CRITICAL 1: this function is the
    // terminal disposition, so *it* may not be the thing that fails before one
    // happens. Everything fallible — absorber installation, the settled-work
    // interrogation, the reset and its baseline proof, listener removal — runs
    // inside the guarded region below; the release itself sits after it,
    // unguarded and unconditional, and is reached from every state this client
    // can be in. A failure inside the region is not swallowed: it becomes the
    // destroy reason, which is the fail-closed answer the reset-versus-destroy
    // model already gives every other uncertain outcome.
    //
    // The previous shape opened with a bare `client.on("error", …)`. A client
    // whose EventEmitter contract itself fails (a wrapping proxy, a replaced
    // max-listeners handler, a non-function listener guard) rejected the whole
    // disposal from that first line, and *nothing* released the client —
    // exactly the leak the boundary exists to prevent, reached through the
    // boundary. One such failure permanently consumes a pool slot.
    let destroy: Error | undefined;
    let absorbing = false;
    try {
      // Read inside the guarded region, never ahead of it (final review,
      // CRITICAL 2): `request` is an object the owner supplied, and once a
      // client is already held even a property read on it is a fallible
      // operation that must not be able to stand between that client and its
      // terminal action. A read that fails becomes the destroy reason, like
      // every other uncertain outcome.
      destroy = request.destroy;
      // The boundary owns this client's connection-level errors for the whole
      // of its own disposal, rather than depending on the caller having
      // attached a listener that survives long enough. pg-pool removes its own
      // idle-error listener the moment a client is checked out, so a socket
      // that fails while the reset below is in flight can otherwise reach an
      // EventEmitter with zero 'error' listeners — which is an uncaught
      // exception, not a caught failure. Attached before any statement is
      // issued, removed again only on the healthy path (where the pool
      // re-attaches its own); on the destructive path it deliberately stays, so
      // a second, delayed notification for the same root failure still lands
      // somewhere.
      client.on("error", reportSanitizedPoolError);
      absorbing = true;
      destroy = await decideDisposition(client, request, destroy);
      // Removed inside the guarded region, before the terminal action: the
      // owner's listener must not outlive the client's disposal, and a
      // removal that throws must condemn the session rather than strand it.
      if (request.ownerListener) client.removeListener("error", request.ownerListener);
    } catch (error) {
      destroy ??= errorValue(error);
    }
    if (!destroy) {
      // Healthy release: ownership goes back to the pool, which attaches its
      // own idle-error listener and resumes managing this client entirely, so
      // the boundary's own absorber is handed back too rather than left behind
      // to accumulate across reuses. Fallible, and therefore still inside the
      // guard: a client that cannot be cleanly detached from this owner's
      // handlers is not a client that can be proven safe for the next borrower.
      try {
        if (absorbing) client.removeListener("error", reportSanitizedPoolError);
      } catch (error) {
        destroy = errorValue(error);
      }
    }
    // The one irreducible statement: pg-pool's `release()` is the terminal
    // action itself, and there is no disposition available beyond it. It is
    // reached unconditionally, exactly once, from every path above.
    if (!destroy) {
      client.release();
      return "reused";
    }
    // The absorber installed above stays attached: a connection nothing will
    // ever touch again must never let a second, delayed 'error' notification
    // for the same root failure become an uncaught exception — pg-pool's own
    // excision and this owner's are two windows, and each covers what the
    // other does not.
    client.release(destroy);
    // Reporting is not disposition. The terminal action has already happened by
    // the time this runs, so a warning listener that throws must not turn a
    // correctly destroyed client into a reported disposal failure — and there
    // is, by construction, nowhere left to report that failure to.
    try {
      reportDestroyedMigrationClient(destroy);
    } catch {
      // Intentionally ignored: see above.
    }
    return "destroyed";
  })();
}

/**
 * PB-10 Step 3 Phase 2d final review, CRITICAL 1: the reset-versus-destroy
 * decision, extracted so that every fallible step of it sits inside the
 * disposer's guarded region and none of it can stand between a client and its
 * terminal release. Returns the reason the session must be destroyed, or
 * undefined when it reset cleanly and proved its baseline.
 */
async function decideDisposition(
  client: PoolClient,
  request: DisposeClientRequest,
  known: Error | undefined,
): Promise<Error | undefined> {
  let destroy = known;
  if (!destroy && request.workSettled?.() === false) {
    destroy = new Error("migration client work could not be proven settled; the session was destroyed rather than reset");
  }
  if (!destroy) {
    const budget = new AbortController();
    // Mapped to a value rather than left to reject: this promise can settle
    // arbitrarily long after the budget below has already given up on it —
    // in particular when destroying the client tears the socket out from
    // under an in-flight reset statement — and a rejection nothing is
    // awaiting by then would be an unhandled rejection in its own right.
    // Owned synchronously here, exactly once, so it never can be.
    const reset = resetPooledSession(client).then(
      () => undefined,
      (error: unknown) => errorValue(error),
    );
    // Deliberately a *referenced* timer, unlike the executor's unreferenced
    // supervision sleeps. An unreferenced budget does not hold the event loop
    // open, so a process whose only remaining work is a hung reset would
    // simply exit — abandoning the disposal decision entirely and leaving the
    // client neither reset nor destroyed, which is the one outcome this
    // boundary exists to make impossible. The wait is short and hard-bounded,
    // so holding the loop open for it costs nothing and guarantees the
    // terminal action is actually reached.
    const outcome = await Promise.race([
      reset,
      delay(SESSION_RESET_BUDGET_MS, "expired" as const, { signal: budget.signal }),
    ]);
    budget.abort();
    if (outcome === "expired") {
      destroy = new Error(`the pooled session reset did not complete within ${SESSION_RESET_BUDGET_MS}ms`);
    } else if (outcome !== undefined) {
      destroy = outcome;
    }
  }
  return destroy;
}

/**
 * PB-10 Step 3 Phase 2d: destroying a client is a correct, fail-closed outcome,
 * but a silent one leaves an operator unable to tell "nothing happened" from
 * "every deploy is discarding its migration connections". Narrowly scoped to
 * the migration client lifecycle — this is not Phase 2e's broad diagnostic
 * sanitization — and sanitized on exactly the same terms as every other
 * absorbed PostgreSQL client diagnostic: at most one whitelisted short `.code`,
 * never a message, stack, host, connection string, SQL text or raw object.
 */
async function inspectLockContention(client: PoolClient): Promise<LockDiagnostic[]> {
  const result = await client.query<LockDiagnostic>(`
    select a.pid as holder_pid,
           null::text as application_name,
           null::text as client_identity,
           a.state,
           -- ::text deliberately, in the database. node-postgres decodes an
           -- interval into a PostgresInterval *object*, which the diagnostic
           -- allowlist below (correctly) refuses, so against real PostgreSQL
           -- both ages silently became null and the one bounded, non-sensitive
           -- duration signal an operator has was lost. Casting here keeps the
           -- allowlist narrow — it still only ever accepts a short string of
           -- digits and separators — rather than teaching it about objects.
           case when a.xact_start is null then null else (clock_timestamp() - a.xact_start)::text end as transaction_age,
           case when a.query_start is null then null else (clock_timestamp() - a.query_start)::text end as query_age,
           a.wait_event_type,
           case
             when a.backend_type <> 'client backend' then 'non-client backend'
             when a.query ~* '^[[:space:]]*select[[:space:]]+pg_(try_)?advisory_lock' then 'advisory-lock command'
             else 'database command'
           end as command_summary
      from pg_catalog.pg_locks l
      join pg_catalog.pg_stat_activity a on a.pid = l.pid
     where l.locktype = 'advisory'
       and l.classid = $1::oid
       and l.objid = $2::oid
       and l.objsubid = 2
       and l.granted
     order by a.pid
  `, [...SCHEMA_ADVISORY_LOCK]);
  return result.rows;
}

function sanitizedLockDiagnostics(holders: LockDiagnostic[]): LockDiagnostic[] {
  return holders.map((holder) => {
    try {
      return {
        holder_pid: Number.isSafeInteger(holder.holder_pid) ? holder.holder_pid : 0,
        application_name: null,
        client_identity: null,
        state: typeof holder.state === "string" && /^[a-z ]{1,32}$/.test(holder.state) ? holder.state : null,
        transaction_age: typeof holder.transaction_age === "string" && /^[0-9: .+-]{1,40}$/.test(holder.transaction_age) ? holder.transaction_age : null,
        query_age: typeof holder.query_age === "string" && /^[0-9: .+-]{1,40}$/.test(holder.query_age) ? holder.query_age : null,
        wait_event_type: typeof holder.wait_event_type === "string" && /^[A-Za-z ]{1,40}$/.test(holder.wait_event_type) ? holder.wait_event_type : null,
        command_summary: ["non-client backend", "advisory-lock command", "database command"].includes(holder.command_summary)
          ? holder.command_summary
          : "database command",
      };
    } catch {
      return { holder_pid: 0, application_name: null, client_identity: null, state: null, transaction_age: null, query_age: null, wait_event_type: null, command_summary: "database command" };
    }
  });
}

interface NormalizedSchemaLockOptions {
  pollMs: number;
  budgetMs: number;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  diagnose: (holders: LockDiagnostic[]) => void;
}

/**
 * PB-10 Step 3 Phase 2d, CRITICAL 1: every deterministic caller-supplied lock
 * option is validated and defaulted here, by a pure function that touches no
 * connection at all — so the plan path can reject an invalid `pollMs` or
 * `budgetMs` *before* it checks a client out of the pool.
 *
 * Validating after acquisition is exactly how a checked-out, migration-owned
 * client used to escape with zero terminal release calls: the rejection
 * happened between `pool.connect()` and the installation of the ownership
 * boundary, so nothing ever released it. One such call permanently exhausts a
 * `max: 1` pool. Deterministic input validation belongs before acquisition;
 * everything after acquisition is covered by `withSchemaAdvisoryLock`'s
 * finalizer regardless — which is unconditional because its protected region
 * starts on the first statement of the function body and its disposal path
 * does not depend on any object constructed after acquisition (final review,
 * CRITICAL 2), not merely because a `finally` is written there.
 */
function normalizeSchemaLockOptions(options: SchemaLockOptions = {}): NormalizedSchemaLockOptions {
  const pollMs = options.pollMs ?? SCHEMA_LOCK_POLL_MS;
  const budgetMs = options.budgetMs ?? SCHEMA_LOCK_BUDGET_MS;
  assertCondition(Number.isFinite(pollMs) && pollMs > 0, "Schema-lock poll interval must be positive");
  assertCondition(Number.isFinite(budgetMs) && budgetMs >= 0, "Schema-lock budget must be nonnegative");
  for (const [name, value] of [["now", options.now], ["sleep", options.sleep], ["diagnose", options.diagnose]] as const) {
    assertCondition(value === undefined || typeof value === "function", `Schema-lock ${name} override must be a function`);
  }
  return {
    pollMs,
    budgetMs,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? ((milliseconds: number) => delay(milliseconds, undefined, { ref: false })),
    diagnose: options.diagnose ?? ((holders: LockDiagnostic[]) => {
      console.warn(`[migration-plan] schema lock contention: ${JSON.stringify(holders)}`);
    }),
  };
}

/**
 * PB-10 Step 3 Phase 2d: the action receives the terminal lifecycle boundary as
 * its second argument, so the migration executor disposes of its *own*
 * execution connection through the exact same code path this function disposes
 * of the pinned control connection through — one implementation, one
 * exactly-once guarantee, one reset-versus-destroy decision, for every
 * migration-owned pooled client. A caller that does not own a second connection
 * (the read-only plan path below) simply ignores it.
 *
 * PB-10 Step 3 Phase 2d, HIGH 1: this function, the disposer it hands out and
 * every type naming either of them are module-private, and live here rather
 * than in runner.ts precisely so that they can be. Both callers that need the
 * boundary — `executeMigrations(pool)` and `runMigrationPlan(pool)` — are
 * defined in this same file, so the ownership capability never crosses a module
 * boundary and therefore never appears in an emitted runtime export or `.d.ts`
 * declaration. Production code cannot obtain, invoke, replace, retain or wrap
 * it; runner.ts's `runMigrationPlan` is a thin delegation to the approved entry
 * point below, not a second way in.
 *
 * The exactly-once latch is created here, per call — as the first statement of
 * the protected region, never before it (final review, CRITICAL 2) — and covers
 * both clients: one migration run's ownership of a pooled client begins and ends
 * inside one invocation of this function, and a later run through the same pool
 * is a new episode that must dispose of its clients again from scratch.
 */
async function withSchemaAdvisoryLock<T>(
  client: PoolClient,
  action: (lockedClient: PoolClient, disposeClient: DisposeClient) => Promise<T>,
  options: SchemaLockOptions = {},
): Promise<T> {
  // PB-10 Step 3 Phase 2d final review, CRITICAL 2: the control client is
  // already checked out when this function is entered, so the protected region
  // starts on the *first statement* of the body. Nothing fallible — not even
  // the construction of the disposer that will finalize this client — is
  // allowed to run ahead of it. The previous shape built the disposer before
  // the `try`, which made the control client's finalization depend on the
  // successful construction of another lifecycle object; the fallback in the
  // `finally` below removes that dependency structurally rather than by
  // arguing that one particular constructor happens not to throw.
  //
  // Option normalization, callback construction, listener installation and lock
  // setup all happen inside the region too, so no rejection on any path can
  // leave this client without exactly one terminal disposition. The caller's own
  // deterministic options are additionally rejected before acquisition (see
  // normalizeSchemaLockOptions); this is the defence that does not depend on the
  // caller having done so.
  let disposeClient: DisposeClient | undefined;
  let acquired = false;
  let connectionError: Error | undefined;
  let onConnectionError: ((error: Error) => void) | undefined;
  let value: T | undefined;
  let actionError: Error | undefined;
  let cleanupError: Error | undefined;
  let disposalError: Error | undefined;
  try {
    const dispose = disposeClient = disposeOnce();
    const { pollMs, budgetMs, now, sleep, diagnose } = normalizeSchemaLockOptions(options);
    const startedAt = now();
    let rejectConnectionLoss!: (error: Error) => void;
    const connectionLost = new Promise<never>((_resolve, reject) => {
      rejectConnectionLoss = reject;
    });
    // connectionLost is raced against below, but only while a race is
    // actually in flight (lock polling, then the action itself). A
    // connection-level error can also arrive later — during the advisory
    // unlock attempt in the finally block, or in the gap immediately after —
    // when nothing is racing this promise any more; without a permanent
    // handler that later rejection would be an unhandled rejection in its own
    // right, on top of the ownership problem this function exists to avoid.
    connectionLost.catch(() => undefined);
    onConnectionError = (error: Error) => {
      connectionError = errorValue(error);
      rejectConnectionLoss(connectionError);
    };
    // A persistent listener, not .once(): ownership requires staying informed
    // of a connection failure for the client's entire held lifetime — lock
    // acquisition, the action, and the unlock/release cleanup that follows —
    // not just the first error observed before that cleanup begins. It is
    // removed only once release/destruction below is complete, at which point
    // the pool resumes its own management of the client.
    client.on("error", onConnectionError);

    // Bound every statement on the pinned connection before the first probe, so
    // a plan blocked behind concurrent DDL cannot hold the schema lock forever.
    //
    // These are session-scoped, deliberately: SET LOCAL has nowhere to live
    // outside a transaction, and this connection is in autocommit for its whole
    // held lifetime. PB-10 Step 3 Phase 2d closes what that used to leave
    // behind — the terminal boundary in the finally below resets and re-proves
    // the session baseline before this client is ever handed to another
    // borrower, so a shared pool is now as safe here as the single-use CLI pool.
    for (const [setting, milliseconds] of [
      ["statement_timeout", SCHEMA_STATEMENT_TIMEOUT_MS],
      ["lock_timeout", SCHEMA_LOCK_TIMEOUT_MS],
    ] as const) {
      await client.query("select set_config($1, $2, false)", [setting, String(milliseconds)]);
    }

    while (!acquired) {
      if (connectionError) throw connectionError;
      const result = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock($1, $2) as acquired",
        [...SCHEMA_ADVISORY_LOCK],
      );
      acquired = result.rows[0]?.acquired === true;
      if (acquired) break;

      diagnose(sanitizedLockDiagnostics(await inspectLockContention(client)));
      const elapsed = now() - startedAt;
      if (elapsed >= budgetMs) throw new Error(`Schema advisory lock was not acquired within ${budgetMs}ms`);
      await Promise.race([sleep(Math.min(pollMs, budgetMs - elapsed)), connectionLost]);
    }
    // PB-10 Step 3 Phase 2c: the migration action is *never* raced against
    // connectionLost, and never abandoned on a timer.
    //
    // Losing the pinned control connection is precisely the moment the action
    // is performing its one mandatory durable step: arming the
    // commit_outcome_unknown replay guard, deliberately over an independent
    // connection this failure does not touch. Everything this function owns —
    // the advisory lock, the pinned client, and the caller's own knowledge of
    // the outcome — is what keeps a *second* execution from replaying a
    // migration whose real outcome is unknown. Returning, releasing, or
    // unlocking while that append is still in flight hands ownership away
    // before the durable marker exists, which is the replay window itself.
    //
    // A deadline cannot make that safe: expiring one would abandon mandatory
    // durability work and release ownership anyway, only less predictably. So
    // there is no deadline here at all. The wait is bounded instead by the
    // things that genuinely bound it — every query still outstanding on a
    // lost connection is rejected by the driver as soon as it emits 'error',
    // and the durable fallback carries its own finite connect timeout and a
    // fixed retry count — and if the database is truly unreachable the action
    // fails closed on its own and rethrows here.
    const running = action(client, dispose);
    // Owned synchronously: `running` is the only object that can carry the
    // action's outcome, and nothing else ever attaches a handler to it, so an
    // inert observer is taken here rather than left to chance.
    running.catch(() => undefined);
    // The action's own outcome is authoritative whenever it produced one: it
    // — not the raw socket error — knows whether the ambiguity was durably
    // recorded and which error class the run actually ended on. A connection
    // failure observed while it was running is only surfaced when the action
    // itself completed without reporting a failure of its own.
    value = await running;
    if (connectionError) throw connectionError;
  } catch (error) {
    actionError = errorValue(error);
  } finally {
    // The lock is only worth releasing if the connection wasn't already
    // known bad going in, and doing so is skipped entirely once it is —
    // never depend on an unlock succeeding when connection health is
    // already uncertain. An ordinary SQL error from the action (or from
    // this unlock query itself) does not set connectionError: that signal
    // is reserved for the client's own 'error' event, which PostgreSQL
    // drivers raise specifically for connection-level failures (backend
    // termination, socket failure, connection reset) and never for a mere
    // query rejection — exactly the distinction an ownership decision here
    // needs to make.
    if (!connectionError && acquired) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "select pg_advisory_unlock($1, $2) as unlocked",
          [...SCHEMA_ADVISORY_LOCK],
        );
        assertCondition(result.rows[0]?.unlocked === true, "Schema advisory unlock returned false");
      } catch (error) {
        cleanupError = errorValue(error);
      }
    }
    // connectionError is read again here, after the unlock attempt (if any):
    // a connection failure observed at any point up to and including that
    // attempt — even one that arrives just as an apparently-successful
    // unlock response comes back — must still result in a destructive
    // release, never a healthy one trusted back into the pool.
    // PB-10 Step 3 Phase 2d: exactly one terminal disposition, through the one
    // boundary, on every path. Reached only *after* the advisory unlock above,
    // which is what keeps a healthy reset from ever being the thing that drops
    // this run's schema lock: DISCARD ALL calls pg_advisory_unlock_all(), so
    // resetting before the explicit unlock had been issued and asserted would
    // have quietly replaced Phase 2c's proven unlock with an unproven one.
    //
    // A destructive disposition still owns a listener swap, and the boundary
    // performs it: this client will never return to the pool, and a genuinely
    // dead connection can still emit a second, delayed 'error' notification for
    // the very same underlying failure (a query rejection and the raw socket's
    // own event, both stemming from one root termination, are not guaranteed to
    // be one event), which must never become an uncaught exception. A healthy
    // disposition instead stops listening entirely, so the pool's own idle
    // listener can attach. Both cases now live in one place.
    //
    // The session reset itself deliberately runs while onConnectionError is
    // still attached: a connection that dies mid-reset both sets
    // connectionError and rejects the reset statement, and either one alone
    // already destroys the client. Fail-closed twice over, never once short.
    //
    // PB-10 Step 3 Phase 2d final review, CRITICAL 2: `disposeOnce()` is the
    // first statement of the protected region, so the only way it can be
    // missing here is that its own construction failed — in which case no
    // disposer ever existed, no action ever ran and therefore nothing can
    // already have disposed of this client. Finalizing it directly is then both
    // safe and still exactly-once; ownership of the control client never
    // depends on another object having been built successfully.
    //
    // PB-10 Step 3 Phase 2d final review, CRITICAL 3: the disposal's own
    // failure is captured here rather than allowed to propagate out of this
    // `finally`. An exception thrown from a `finally` discards whatever the
    // `try` was already failing with, so an unguarded await on this line let a
    // failed cleanup silently replace — and erase — the migration's own primary
    // failure. It is composed with it below instead, exactly as the execution
    // connection's disposal already is.
    //
    // A `try`/`catch` rather than a trailing `.catch(…)`: `.catch` is only
    // attached once a promise exists, so it covers a *rejected* disposal and
    // not a disposer that throws before returning one. Both are captured here.
    try {
      await (disposeClient ?? disposeMigrationClient)(client, {
        destroy: connectionError ?? cleanupError,
        ownerListener: onConnectionError,
      });
    } catch (error) {
      disposalError = errorValue(error);
    }
  }

  // Primary first, always: `actionError` is the migration's own outcome, and
  // cleanup failures are additional information about it, never a replacement
  // for it. A single failure is thrown as itself (unchanged from Phase 2c's
  // contract); two or more are composed into one AggregateError whose first
  // element is the primary failure.
  const failures = [actionError, cleanupError, disposalError].filter((failure): failure is Error => failure !== undefined);
  if (failures.length > 1) throw new AggregateError(failures, "Migration plan and lock cleanup failed");
  if (failures.length === 1) throw failures[0];
  return value as T;
}

/**
 * The read-only migration plan, taken under the schema advisory lock and
 * disposed of through the very same terminal ownership boundary as an
 * execution run.
 *
 * PB-10 Step 3 Phase 2d, HIGH 1: this lives here, beside the boundary, so that
 * the boundary itself never has to be exported. runner.ts keeps its own
 * `runMigrationPlan` as a thin delegation to this function, preserving the
 * existing public plan surface without providing a second way to reach the
 * lock lifecycle or the client disposer.
 */
export async function runMigrationPlan(
  pool: Pool,
  options: SchemaLockOptions & { manifest?: MigrationManifest } = {},
): Promise<MigrationPlan> {
  try {
    const manifest = options.manifest ?? await checkManifest();
    normalizeSchemaLockOptions(options);
    const client = await pool.connect();
    return await withSchemaAdvisoryLock(client, async (lockedClient) => {
      await verifyControlSchema(lockedClient);
      const rows = await readAppliedRows(lockedClient);
      await assertNoLegacyLedgerDivergence(lockedClient, rows, manifest);
      return buildMigrationPlan(manifest, rows, options);
    }, options);
  } catch (error) {
    throw sanitizeMigrationError(error, "PB10_MIGRATION_PLAN_FAILED");
  }
}

async function executeVerifiedMigrations(
  pool: Pool,
  manifest: MigrationManifest,
  identity: ExecutionIdentity,
): Promise<ExecutionReport> {
  identity = validateExecutionIdentity(identity);
  guardPoolErrors(pool);
  const sleep = (milliseconds: number, signal?: AbortSignal) =>
    delay(milliseconds, undefined, { ref: false, signal });
  const now = Date.now;
  const runId = randomUUID();
  const migrationDirectory = path.join(repositoryRoot, "db", "migrations");

  const control = await pool.connect();
  return withSchemaAdvisoryLock(control, async (lockedControl, disposeClient) => {
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
    let runError: Error | undefined;
    let executionDisposalError: Error | undefined;
    let controlCleanupError: Error | undefined;

    // PB-10 Step 3 Phase 2c: pg-pool removes its own idle-error listener the
    // moment a client is checked out (_acquireClient), so a checked-out
    // client normally has no 'error' listener at all — a query rejection
    // surfaces the failure through its own promise, but a raw connection-
    // level 'error' event (the underlying socket itself failing, exactly
    // what a genuine post-COMMIT ambiguity is) has nothing to catch it and
    // becomes an uncaught exception. This mirrors the control connection's
    // own persistent listener below for exactly the same reason: whichever
    // outcome the query-rejection path already resolved to must be the only
    // one that matters, never a second, separately-emitted socket error.
    //
    // PB-10 Step 3 Phase 2d, CRITICAL 1: declared here, *installed* far below
    // and only from inside the ownership boundary. Creating the function
    // cannot throw; `execution.on(...)` can, and until this run's finalizer
    // exists there is nothing that would release the client if it did.
    const onExecutionError = (): void => undefined;

    // PB-10 Step 3 Phase 2d: the count of operations that own this execution
    // client and may still be using it. Every supervised operation and every
    // batched batch is registered here the instant it starts, and the terminal
    // boundary refuses to issue a single reset statement while any of them is
    // unproven — a reset racing an operation that still holds the session is
    // exactly the corruption Phase 2d exists to make impossible.
    //
    // A count, deliberately, rather than a drain: a client-owned operation that
    // has not settled may never settle at all (a cancellation PostgreSQL never
    // confirmed is precisely that case), so waiting on one is not an option the
    // boundary can be given. Unsettled work destroys the client instead, which
    // is both fail-closed and finite.
    //
    // `settle` cannot throw and the promise it is attached to already carries
    // its own outcome handling at every call site, so neither `.then` arm can
    // produce an unhandled rejection or an unowned outcome here.
    let outstandingExecutionWork = 0;
    const settle = (): void => { outstandingExecutionWork -= 1; };
    const noteExecutionWork = (work: Promise<unknown>): void => {
      outstandingExecutionWork += 1;
      void work.then(settle, settle);
    };

    // PB-10 Step 3 Phase 2d, CRITICAL 1: acquisition. From this line until the
    // `try` below, every statement is a bare declaration or a function-
    // expression construction — operations the language cannot fail — so the
    // finalizer is reachable from every state this client can be in. Listener
    // installation, callback invocation, option access, RunLog construction,
    // the independent-control acquirer and every other fallible step happen
    // *inside* the boundary. An earlier revision installed the execution
    // client's own 'error' listener here, between checkout and the try: a
    // synchronous throw from that single `execution.on(...)` call left a
    // checked-out client with zero terminal dispositions, and one such failure
    // permanently exhausts a `max: 1` pool.
    const execution = await pool.connect();

    // PB-10 Step 3 Phase 2d: one owner, one terminal action, exactly once —
    // and the exactly-once guarantee lives in the boundary itself (keyed by the
    // client object), not in a latch here, so a second caller reaching this
    // from a different code path can never issue a second release or a second
    // reset. Memoized so the connection-loss path below can start disposal
    // synchronously from an event handler while the run loop's own `finally`
    // still awaits the very same promise rather than leaving it detached.
    let executionDisposal: Promise<"reused" | "destroyed"> | undefined;
    const disposeExecution = (error?: Error): Promise<"reused" | "destroyed"> => {
      // PB-10 Step 3 Phase 2d final review, CRITICAL 2: the same CLAIM → EXECUTE
      // → SETTLE ordering the episode latch itself now uses, applied to this
      // run's own memo, because this is the *outer* of the two gates a reentrant
      // caller passes through and it had the identical defect.
      //
      // The previous shape assigned the memo from the result of the call:
      //
      //     executionDisposal = (async () => disposeClient(execution, …))();
      //
      // The async wrapper's body runs synchronously up to its first `await`, and
      // that body reaches straight into the disposer's listener installation.
      // A synchronous re-entry from there — `newListener` is emitted before the
      // listener is added, and the control client's 'error' handler below calls
      // this very function — found `executionDisposal` still `undefined`,
      // because the assignment had not happened yet, and started a second
      // disposition of an execution client that already had one in flight.
      //
      // The memo is now published *before* the body runs, as a bare deferred
      // whose construction is not observable to anything outside this function.
      // Any second caller — synchronous, reentrant, or an ordinary concurrent
      // one — receives this same handle and joins the disposition already
      // claimed; its `error` argument is deliberately ignored, because the first
      // claimant's reason is this episode's reason and a joiner must not be able
      // to start a second terminal action.
      if (executionDisposal) return executionDisposal;
      let claim!: (outcome: Promise<"reused" | "destroyed">) => void;
      executionDisposal = new Promise<"reused" | "destroyed">((resolve) => { claim = resolve; });
      // Owned synchronously, the same way every other promise this run starts
      // is: the connection-loss handler below starts disposal from an event
      // callback and drops the returned promise, so an inert observer is taken
      // here rather than relying on the run loop's own `finally` attaching one
      // before the microtask checkpoint. The `finally` still awaits this exact
      // promise and still captures its failure.
      executionDisposal.catch(() => undefined);
      claim((async () => disposeClient(execution, {
        destroy: error,
        ownerListener: onExecutionError,
        workSettled: () => outstandingExecutionWork === 0,
      }))());
      return executionDisposal;
    };
    const onControlError = (error: Error) => {
      // PB-10 Step 3 Phase 2d final review, CRITICAL 1: the total conversion.
      // `emit('error', x)` carries whatever value the emitter was given, and an
      // inline `String(x)` here threw *before* the disposal below was started —
      // an already-acquired execution client with zero terminal dispositions,
      // reached from an event handler nothing was guarding.
      controlLost = errorValue(error);
      // Destroy the execution connection immediately rather than at the end of
      // the run. Its transaction is still in flight, and without the control
      // connection nothing can record or supervise it — an orphaned COMMIT
      // would write an applied row for a run that has already aborted. The
      // returned promise is retained, never dropped: the run loop's `finally`
      // awaits this exact disposal, so nothing here is detached and no reset
      // statement can be in flight after this function returns.
      disposeExecution(controlLost);
    };
    // PB-10 Step 3 Phase 2d: ownership of `execution` becomes unconditional
    // from here on. Everything between acquiring it and the run loop used to
    // sit *outside* the try below — the execution client's own 'error'
    // listener, the control listener, the RunLog, the independent-control
    // acquirer — so a throw from any of them (a RunLog constructor that
    // rejected its inputs, say) leaked a checked-out client that nothing would
    // ever release: with a `max: 2` production pool, the second such failure
    // exhausts the pool permanently. The try starts immediately after
    // acquisition instead, so the terminal boundary in the `finally` is
    // reachable from every path that can exist once the client is held.
    try {
      // PB-10 Step 3 Phase 2d, CRITICAL 1: the first fallible statement of the
      // run, and deliberately the first one inside the boundary.
      //
      // Failing to install it is classified destructive rather than reusable,
      // through the ordinary reset-versus-destroy model rather than a
      // special-case release path. The justification is substantive, not
      // precautionary: this listener is the only thing standing between a
      // raw connection-level 'error' on this session and an uncaught
      // exception, the session reset the healthy path would otherwise run
      // issues real statements on that unprotected session, and a client whose
      // own EventEmitter contract just failed cannot be proven safe to hand to
      // the next borrower. "Uncertain" is never "reusable".
      try {
        execution.on("error", onExecutionError);
      } catch (error) {
        destroyExecution = errorValue(error);
        throw error;
      }
      lockedControl.once("error", onControlError);

      const runLog = new RunLog(lockedControl, runId, identity, manifest);
      const runStartedAt = now();
      // PB-10 Step 3 Phase 2c blocker 3: never contends with `lockedControl`/
      // `execution` for one of the pool's own (as low as 2) slots — see
      // independentControlAcquirer's own doc for why pool.connect() here would
      // deadlock.
      const acquireIndependentControl = independentControlAcquirer(pool);

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
          noteExecutionWork,
          acquireIndependentControl,
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
    } catch (error) {
      // PB-10 Step 3 Phase 2d, CRITICAL 1: held rather than propagated, so the
      // disposal below cannot be skipped and cannot silently replace it — the
      // same actionError/cleanupError composition withSchemaAdvisoryLock
      // already applies to the control connection.
      runError = errorValue(error);
    } finally {
      // PB-10 Step 3 Phase 2d final review, CRITICAL 1: the execution client's
      // terminal disposition is the *first* statement of this `finally`, and
      // nothing fallible is allowed in front of it.
      //
      // The previous shape opened with `lockedControl.removeListener(…)` — a
      // synchronous call on an object whose EventEmitter contract this code
      // does not own. A throw from it skipped the disposal entirely: the
      // execution client, already checked out, received *zero* terminal
      // disposition attempts and stayed checked out forever, while the control
      // client's own boundary went on releasing only the control client. One
      // occurrence permanently consumes a slot of a bounded production pool.
      //
      // The correction is the ownership rule itself, not a guard around that
      // one call: from the instant `execution` is acquired, the only statement
      // that may run before its disposition is one that cannot fail, and every
      // fallible operation that is *not* this client's disposition — listener
      // bookkeeping for the control client included — happens after it, inside
      // its own guard, and is composed into the run's outcome rather than
      // thrown out of this `finally`.
      //
      // Awaited, never fired and forgotten: the session reset issues real SQL
      // on this connection, and returning from here — let alone releasing the
      // control connection and the schema advisory lock above it — while that
      // is still in flight would hand ownership away mid-cleanup. Every durable
      // Phase 2c step (reconciliation, the ambiguity marker, the applied row,
      // every ledger event) has already completed by the time this runs: the
      // run loop above is what performs them, and this `finally` cannot begin
      // until it has left.
      //
      // The rejection is captured, never allowed to escape: a disposal that
      // failed must not become the reported failure in place of the run's own
      // error. It is composed with it below instead. A `try`/`catch` rather
      // than a trailing `.catch(…)`, so a disposer that throws before returning
      // a promise is captured on exactly the same terms as one that rejects.
      try {
        await disposeExecution(destroyExecution);
      } catch (error) {
        executionDisposalError = errorValue(error);
      }
      // Only now, and only inside its own guard: this is bookkeeping for a
      // *different* client, whose terminal boundary is withSchemaAdvisoryLock's
      // own `finally` and which is therefore disposed of regardless of what
      // happens here. A failure is a cleanup failure — composed below, never
      // thrown out of this `finally`, where it would silently replace the
      // migration's own outcome.
      try {
        lockedControl.removeListener("error", onControlError);
      } catch (error) {
        controlCleanupError = errorValue(error);
      }
    }

    // Primary first, always, exactly as withSchemaAdvisoryLock composes the
    // control connection's own failures: the run's own error is the migration's
    // outcome, and a cleanup or disposal failure is additional information
    // about it — never a replacement for it.
    const failures = [runError, executionDisposalError, controlCleanupError]
      .filter((failure): failure is Error => failure !== undefined);
    if (failures.length > 1) {
      throw new AggregateError(failures, "Migration execution and execution-connection disposal failed");
    }
    if (failures.length === 1) throw failures[0];

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
  try {
    if (arguments.length !== 1) {
      throw new Error("executeMigrations accepts exactly one Pool argument; alternate execution inputs are not supported");
    }
    const manifest = await checkManifest();
    return await executeVerifiedMigrations(pool, manifest, identityFromEnvironment());
  } catch (error) {
    throw sanitizeMigrationError(error, "PB10_MIGRATION_EXECUTION_FAILED");
  }
}
