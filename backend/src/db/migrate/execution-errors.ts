/**
 * Shared error-classification primitives for the migration execution path.
 * Split out of execute.ts so backend/src/db/migrate/supervision.ts can use
 * the exact same fixed error vocabulary without a circular import between
 * the two (execute.ts imports superviseOperation from supervision.ts;
 * supervision.ts needs MigrationExecutionError/classify, which must
 * therefore live somewhere neither module owns).
 *
 * ERROR_CLASSES and MigrationExecutionError remain part of execute.ts's
 * public surface — it re-exports both unchanged — this module is not
 * itself a new public entry point.
 */

export const SQLSTATE = /^[0-9A-Z]{5}$/;

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

export function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function sqlstateOf(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code;
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
