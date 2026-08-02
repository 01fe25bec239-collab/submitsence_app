import { DatabaseError } from "pg";

/**
 * PB-10 Step 3 Phase 2c blocker 2: constructs a genuine `pg.DatabaseError` —
 * the exact class pg-protocol's wire-level parser builds from a real server
 * ErrorResponse (see execution-errors.ts's sqlstateOf) — so tests that must
 * simulate an *authoritative* PostgreSQL rejection do so with the same class
 * the production code now requires, not a plain Error with a look-alike
 * `.code` field (which sqlstateOf now deliberately refuses to trust).
 */
export function pgError(message: string, code: string): DatabaseError {
  const error = new DatabaseError(message, 0, "error");
  error.code = code;
  return error;
}
