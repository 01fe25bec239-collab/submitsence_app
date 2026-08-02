import type { BatchedHandler, NontransactionalHandler } from "./execute";

/**
 * The migration-handler registry, as two pure lookup functions rather than a
 * map object.
 *
 * PB-10 Step 3 Phase 2c final review: the emitted build must expose no
 * mutable registry — anything with `set`/`delete`/`clear` on it would be an
 * in-process injection point for an alternate migration executor, which is
 * exactly what the encapsulation test in
 * backend/test/migration-execute.test.ts forbids. These are therefore total
 * functions over a closed, reviewed set of migration ids, not a container:
 * nothing loaded in the same process can add an entry to them, and the
 * emitted `handlers.js` contains no branch that can ever return a handler
 * until one is written here and reviewed.
 *
 * No migration above the legacy boundary needs a handler yet, so both
 * currently return undefined for every id and every nontransactional/batched
 * manifest entry fails closed on `unsupported_handler`.
 *
 * This is its own module purely so that it is a *module* — the sealed test
 * adapter (backend/test/helpers/migration-execute.ts) substitutes it through
 * the same `Module._load` interception, scoped to execute.ts's own import,
 * that it already uses for `./manifest` and `node:timers/promises`. That
 * substitution exists only inside the test process: no production code path,
 * environment variable, or export makes it reachable, and executeMigrations()
 * itself is unchanged. It is what lets the batch-lifecycle regression suites
 * drive a real batched handler against real PostgreSQL through the public
 * entry point without the emitted build ever exposing a way to do so.
 */
export function nontransactionalHandlerFor(migrationId: string): NontransactionalHandler | undefined {
  void migrationId;
  return undefined;
}

export function batchedHandlerFor(migrationId: string): BatchedHandler | undefined {
  void migrationId;
  return undefined;
}
