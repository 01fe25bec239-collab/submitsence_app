/**
 * Shared error-classification primitives for the migration execution path.
 * Split out of execute.ts as its own leaf module — pure error
 * classification, no database access, no execution authority of its own —
 * so execute.ts's manifest/runner/execution-errors dependency graph stays
 * acyclic even after the PB-10 Step 3 Phase 2c final review merged every
 * other internal (formerly batched.ts, execution-context.ts, supervision.ts)
 * directly into execute.ts as module-private code.
 *
 * ERROR_CLASSES and MigrationExecutionError remain part of execute.ts's
 * public surface — it re-exports both unchanged — this module is not
 * itself a new public entry point.
 */

import { DatabaseError } from "pg";

export const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Fixed error vocabulary. Errors carry a classification, a SQLSTATE and an
 * identifier — never a PostgreSQL message, which can quote row values.
 *
 * PB-10 Step 3 Phase 2c final review, HIGH 1: this collection and the
 * `ErrorClass` union derived from it are part of execute.ts's *published*
 * surface — execute.ts re-exports both, `tsc` emits them into execute.d.ts,
 * and every value here has already been written into
 * `migration_control.migration_runs.error_class` on real installations,
 * where the ledger is INSERT-only and those rows can never be rewritten.
 *
 * A value is therefore never removed from this collection merely because the
 * current implementation stopped *producing* it. Removing one narrows an
 * exported union (breaking exhaustive switches and assignability for existing
 * consumers) and makes the reader unable to name a class that is still
 * physically present in stored history. Deprecated values stay listed, stay
 * assignable and stay readable; see LEGACY_ERROR_CLASSES below for the ones
 * no current execution path emits.
 */
export const ERROR_CLASSES = [
  "cancellation_unverified",
  "checksum_drift",
  "commit_outcome_unknown",
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

/**
 * HIGH 1: classes retained for compatibility that no current execution path
 * emits. They remain fully valid `ErrorClass` values — historical ledger rows
 * carry them and must stay readable — but the history evaluator never treats
 * one as authoritative outcome proof, so an attempt whose only terminal
 * evidence is a legacy class fails closed and requires operator resolution.
 *
 * - `stale_legacy_attempt` — written by the pre-Phase-2c legacy-verbatim
 *   evaluator, which inferred a safe retry from an event label alone. That
 *   inference is exactly what CRITICAL 1 removed; the value survives so the
 *   rows it is stored on remain interpretable.
 *
 * Declared as a frozen tuple rather than a Set: every emitted migrate module is
 * inspected by the public-surface regression for exported values carrying
 * `set`/`delete`/`clear`, because such a value is a mutable registry an
 * in-process caller could reach into. A `Set` — even one typed `ReadonlySet` —
 * is exactly that shape at runtime, so the compatibility list is published in a
 * shape that cannot be mutated at all.
 */
export const LEGACY_ERROR_CLASSES = Object.freeze(["stale_legacy_attempt"] as const) satisfies readonly ErrorClass[];

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

export function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * PB-10 Step 3 Phase 2c blocker 2: a `.code` field shaped like a SQLSTATE is
 * not proof of anything — a client-local Error can carry any `code` an
 * application or test chooses to assign it (query timeouts, socket errors,
 * generic driver failures all do exactly this in practice). The only proof
 * that a COMMIT was genuinely rejected by the PostgreSQL server itself, and
 * not merely by some client-side transport failure, is that the error is a
 * `pg.DatabaseError` — the exact class pg-protocol's wire-level parser
 * constructs from a real server ErrorResponse and nothing else (see
 * pg-protocol/dist/parser.js's parseErrorMessage, the only call site that
 * ever constructs one). node-postgres never uses this class for client-local
 * failures: timeouts and connection-termination errors are always plain
 * `Error` instances. Anything else — including an object that merely passes
 * an `instanceof Error` check with a five-character `.code` — is refused as
 * authoritative here, no matter how it was constructed.
 */
export function sqlstateOf(error: unknown): string | null {
  if (!(error instanceof DatabaseError)) return null;
  const code = error.code;
  return typeof code === "string" && SQLSTATE.test(code) ? code : null;
}

/**
 * Collapses any driver or server error into the fixed vocabulary. The original
 * message is dropped on purpose: it can contain SQL text, bound parameters or
 * conflicting row values.
 */
export function classify(error: unknown, errorClass: ErrorClass, migrationId: string, detail: string): MigrationExecutionError {
  if (error instanceof MigrationExecutionError) return error;
  return new MigrationExecutionError(errorClass, detail, migrationId, sqlstateOf(error));
}

/**
 * PB-10 Step 3 Phase 2c final review, HIGH 6: the single sanitized diagnostic
 * path for any PostgreSQL client error the migration runner absorbs rather
 * than propagates — a pool's own delayed 'error' event, a second delayed
 * error on an already-destructively-released client (execution or the pinned
 * advisory-lock control connection), or a delayed error on an independently-
 * acquired fallback connection. Reads at most one whitelisted `.code` field
 * (a short driver error code or SQLSTATE) and never touches `.message`,
 * `.stack`, `.hostname`, `.address`, `.config`, a connection string/URL, SQL
 * text, certificate material, or the raw error/client object itself — any of
 * which can carry secrets or topology. `process.emitWarning` is documented to
 * never throw and never become an `uncaughtException`/`unhandledRejection`,
 * so this can never itself crash the process it is trying to keep alive.
 *
 * Absorbing such an error silently is not an option: an operator would have
 * no signal at all that a connection died underneath a migration run.
 */
const SAFE_ERROR_CODE = /^[A-Za-z0-9_]{1,10}$/;

export function safePoolErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && SAFE_ERROR_CODE.test(code)) return code;
  }
  return "UNKNOWN";
}

/**
 * One root connection failure legitimately reaches this reporter through more
 * than one owner: the runner's own listener on a destructively-released
 * client, and pg-pool's `_release`/idleListener, which re-attaches its own
 * listener even on a destructive release, excises the client and re-emits the
 * *same* error object at pool level (where execute.ts's pool guard absorbs
 * it). Both listeners are required — each covers a window the other does not
 * — so the duplicate is suppressed here, at the single reporting point,
 * rather than by removing an owner or by accepting two warnings for one
 * failure. Identity-keyed and weakly held: distinct failures always report
 * separately, and nothing is retained.
 */
const alreadyReported = new WeakSet<object>();

export function reportSanitizedPoolError(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    if (alreadyReported.has(error)) return;
    alreadyReported.add(error);
  }
  process.emitWarning(
    `[pg_pool_client_error] a PostgreSQL connection used by the migration runner reported a delayed error (code=${safePoolErrorCode(error)}); the affected connection was already excised and is never reused`,
    { code: "PB10_MIGRATION_POOL_ERROR" },
  );
}
