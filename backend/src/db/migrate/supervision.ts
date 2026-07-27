import type { PoolClient } from "pg";
import type { MigrationManifestEntry } from "./manifest";
import { MigrationExecutionError, assertCondition, classify, sqlstateOf } from "./execution-errors";

/**
 * PB-10 Step 3 Phase 2a cancellation-confirmation state machine.
 *
 * Deliberately its own narrowly scoped internal module, not part of
 * execute.ts: execute.ts imports superviseOperation from here for its own
 * internal use and does not re-export it. executeMigrations(pool) remains
 * the sole production migration execution entry point — nothing in this
 * file is reachable except through that one call, or directly by the
 * focused unit tests that exercise this state machine in isolation.
 */

export const CANCELLATION_GRACE_MS = 10_000;
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

/**
 * The exact (and only) subset of execute.ts's internal MigrationContext that
 * superviseOperation depends on. execute.ts's MigrationContext also carries
 * runLog, handlers, identity, checksum, etc. that this function never
 * touches; this narrower shape is what lets this module — and its focused
 * unit tests — construct a context without any of execute.ts's other
 * internal machinery.
 */
export interface SupervisedOperationContext {
  entry: Pick<MigrationManifestEntry, "id">;
  control: PoolClient;
  execution: PoolClient;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  /** Set when the execution connection must be destroyed rather than returned to the pool. */
  destroyExecution: () => void;
}

type Settlement<T> =
  | { readonly status: "resolved"; readonly value: T }
  | { readonly status: "rejected"; readonly error: unknown };

type RaceOutcome<T> =
  | { readonly raced: "settled"; readonly settlement: Settlement<T> }
  | { readonly raced: "expired" };

async function raceSettlement<T>(
  context: SupervisedOperationContext,
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
  context: SupervisedOperationContext,
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

export async function superviseOperation(context: SupervisedOperationContext, sql: string, budgetMs: number): Promise<void> {
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
export async function superviseCallback<T>(
  context: SupervisedOperationContext,
  budgetMs: number,
  run: (client: PoolClient) => Promise<T>,
  failureDetail: string,
): Promise<T> {
  return superviseSettlement(context, budgetMs, () => run(context.execution), failureDetail);
}
