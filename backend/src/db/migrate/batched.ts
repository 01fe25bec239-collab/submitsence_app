import type { PoolClient } from "pg";
import { MigrationExecutionError, classify } from "./execution-errors";
import {
  applyTimeouts,
  errorSqlstate,
  insertAppliedRow,
  monotonicMs,
  recordedErrorClass,
  remainingBudgetMs,
  type MigrationContext,
} from "./execution-context";
import { superviseCallback } from "./supervision";
import type { BatchedContext } from "./execute";

/**
 * PB-10 Step 3 Phase 2b: the real batched-mode orchestration, extracted
 * into its own narrowly scoped internal module for exactly the same reason
 * supervision.ts is its own module — so it can be imported both by
 * execute.ts (for its own internal use, never re-exported) and directly by
 * focused tests, without adding any injectable executor, mutable handler
 * registry, or alternate execution entry point to execute.ts's public
 * surface. execute.ts imports executeBatched from here and calls it exactly
 * as it called its own former inline implementation — same signature
 * (`context: MigrationContext`), same handler lookup via
 * `context.handlers.batched`, same behaviour — nothing about
 * executeMigrations(pool)'s public contract changes.
 *
 * batched.ts only ever imports the `BatchedContext` *type* back from
 * execute.ts — erased at compile time, so there is no runtime circular
 * dependency between this file and execute.ts.
 */

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
export async function executeBatched(context: MigrationContext): Promise<void> {
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
  // One aggregate deadline for the whole migration, shared across every
  // batch. No batch — however quickly it individually finishes — ever
  // resets it or receives a fresh budget.
  const deadlineMs = monotonicMs() + entry.timeouts.wallClockMs;
  await runLog.append(entry.id, "started", { execution_mode: "batched" }, {
    heartbeatDeadline: new Date(Date.now() + entry.timeouts.wallClockMs),
  });

  let batchNumber = 0;
  const batchContext: BatchedContext = {
    migrationId: entry.id,
    runBatch: async <T>(batch: (client: PoolClient) => Promise<T>): Promise<T> => {
      const budget = remainingBudgetMs(deadlineMs);
      if (budget <= 0) {
        throw new MigrationExecutionError(
          "wall_clock_exceeded",
          "the migration's wall-clock budget was exhausted before the next batch could start",
          entry.id,
        );
      }
      batchNumber += 1;
      const number = batchNumber;
      await execution.query("begin");
      try {
        await applyTimeouts(execution, entry.timeouts, true);
        // The control-side supervisor supplies the remaining migration
        // budget. PostgreSQL keeps the independently declared per-statement
        // and per-transaction ceilings; setting transaction_timeout to the
        // same value as the supervisor can terminate the session before the
        // accepted pg_cancel_backend/57014 confirmation path runs.
        const value = await superviseCallback(context, budget, batch, `batch ${number} failed`);
        await execution.query("commit");
        await runLog.append(entry.id, "operation_completed", { execution_mode: "batched", batch_number: number });
        return value;
      } catch (error) {
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
            throw new MigrationExecutionError(
              "cancellation_unverified",
              `batch ${number} rollback could not be confirmed`,
              entry.id,
              sqlstate,
            );
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
        // behaviour, preserved exactly.
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
    const errorClass = recordedErrorClass(error);
    await runLog.append(entry.id, "execution_failed", { execution_mode: "batched", batch_number: batchNumber }, {
      sqlstate: errorSqlstate(error),
      errorClass,
    });
    throw classify(error, errorClass, entry.id, "batched execution failed");
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
