import { createHash, randomBytes } from "node:crypto";

/**
 * PB-10 Step 3 Phase 2c final review, CRITICAL 1 + CRITICAL 2.
 *
 * An in-memory stand-in for the SECURITY DEFINER functions in
 * db/control/control-proof-path.sql — claim_transaction,
 * record_transaction_binding, record_applied_migration and
 * record_progress_marker — plus the migration_control.proof_key row and the
 * four partial unique indexes that back them.
 *
 * It exists so the mocked suites model the *protocol*, not the SQL strings.
 * Every rule the real database enforces is enforced here too, and by the same
 * mechanism:
 *
 *   - a claim receipt is a keyed digest over a secret this object never
 *     exposes, so a fabricated or replayed claim is rejected rather than
 *     accepted with a different value;
 *   - claim_transaction reads the *current* transaction id from the caller's
 *     connection state, never from an argument, so no caller can name another
 *     transaction;
 *   - one attempt binds at most one transaction and one transaction binds at
 *     most one attempt (mr_one_binding_per_attempt / mr_one_attempt_per_xact),
 *     as hard errors;
 *   - one token arms exactly one attempt (mr_one_token_per_attempt);
 *   - an applied row can be recorded only through record_applied_migration,
 *     only with a live token, and — in transactional mode — only from inside
 *     the exact bound transaction, which is what makes commit_proof
 *     'transaction_atomic' mean what the evaluator believes it means.
 *
 * A mocked case that "passes" by returning a plausible string would prove
 * nothing; a case that passes against this object has exercised the same
 * refusals real PostgreSQL would produce. The durable proof that this model
 * and the SQL agree lives in the PostgreSQL regression suites
 * (migration-control-proof.pg.test.ts).
 */

export type ArmedAttempt = {
  digest: string;
  runId: string;
  migrationId: string;
  runnerId: string | null;
  sourceGitSha: string | null;
  executorImageDigest: string | null;
  metadata: Record<string, unknown>;
};

export type RecordedBinding = {
  attempt: ArmedAttempt;
  eventSequence: number;
  xactId: string;
};

export type RecordedApplied = {
  attempt: ArmedAttempt;
  manifestChecksum: string;
  lifecyclePhase: string;
  operationCategories: string[];
  commitProof: "transaction_atomic" | "post_hoc_verified";
};

export type RecordedMarker = {
  attempt: ArmedAttempt;
  eventSequence: number;
  ordinal: 1 | 2;
};

export const CLAIM = /^[0-9]{1,20}:[0-9a-f]{64}$/;

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Raised with the same SQLSTATE the corresponding RAISE in control-schema.sql uses. */
export class ProtectedPathError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProtectedPathError";
  }
}

export class ProtectedProofPath {
  /**
   * Stands in for migration_control.proof_key: owned by
   * migration_control_owner and granted to no role, so the execution role
   * cannot compute a receipt this object did not itself produce. Nothing
   * outside this class reads it, exactly as nothing outside the SECURITY
   * DEFINER functions can read the real row.
   */
  private readonly key = randomBytes(32).toString("hex");
  /** mr_one_token_per_attempt: token digest → the one attempt it armed. */
  private readonly armed = new Map<string, ArmedAttempt>();
  /** mr_one_binding_per_attempt: `${runId}|${migrationId}` → binding. */
  private readonly bindings = new Map<string, RecordedBinding>();
  /** mr_one_attempt_per_xact: xid8 → the attempt key that bound it. */
  private readonly boundXacts = new Map<string, string>();
  /** mr_one_marker_per_attempt: `${runId}|${migrationId}` → the ordinals recorded. */
  private readonly markers = new Map<string, Set<number>>();

  readonly recordedBindings: RecordedBinding[] = [];
  readonly recordedMarkers: RecordedMarker[] = [];
  readonly recordedApplied: RecordedApplied[] = [];

  private static attemptKey(attempt: ArmedAttempt): string {
    return `${attempt.runId}|${attempt.migrationId}`;
  }

  /**
   * The `started` INSERT's attempt_token_sha256 column. Called by the fake
   * control client when it sees a started row, mirroring the fact that the
   * executor writes the digest itself through its ordinary column-level
   * INSERT privilege while the token never leaves its memory.
   */
  arm(attempt: ArmedAttempt): void {
    if (this.armed.has(attempt.digest)) {
      throw new ProtectedPathError("23505", "duplicate key value violates unique constraint mr_one_token_per_attempt");
    }
    this.armed.set(attempt.digest, attempt);
  }

  /** migration_control.attempt_for_token: resolves a token or raises 42501. */
  private attemptForToken(token: unknown): ArmedAttempt {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
      throw new ProtectedPathError("42501", "migration attempt token is malformed");
    }
    const attempt = this.armed.get(tokenDigest(token));
    if (attempt === undefined) {
      throw new ProtectedPathError("42501", "migration attempt token does not identify a started attempt");
    }
    return attempt;
  }

  private receipt(attempt: ArmedAttempt, xactId: string): string {
    return createHash("sha256").update(`${this.key}|${attempt.digest}|${xactId}`, "utf8").digest("hex");
  }

  /**
   * migration_control.claim_transaction. `currentXactId` stands in for
   * pg_current_xact_id() — supplied by the *connection*, never by the caller's
   * arguments, which is the whole point of CRITICAL 2's half one.
   */
  claimTransaction(token: unknown, currentXactId: string | null): string {
    const attempt = this.attemptForToken(token);
    if (currentXactId === null) {
      throw new ProtectedPathError("25P01", "claim_transaction was called outside a transaction");
    }
    if (this.bindings.has(ProtectedProofPath.attemptKey(attempt))) {
      throw new ProtectedPathError("55000", "this migration attempt already has a durable transaction binding");
    }
    return `${currentXactId}:${this.receipt(attempt, currentXactId)}`;
  }

  /**
   * migration_control.record_transaction_binding. Verifies the receipt against
   * the unreadable key, then applies both partial unique indexes as errors.
   */
  recordTransactionBinding(token: unknown, eventSequence: unknown, claim: unknown): RecordedBinding {
    const attempt = this.attemptForToken(token);
    if (typeof claim !== "string" || !CLAIM.test(claim)) {
      throw new ProtectedPathError("42501", "transaction binding claim is malformed");
    }
    const [xactId, receipt] = claim.split(":");
    if (receipt !== this.receipt(attempt, xactId)) {
      throw new ProtectedPathError("42501", "transaction binding claim is not authentic for this migration attempt");
    }
    const key = ProtectedProofPath.attemptKey(attempt);
    if (this.bindings.has(key)) {
      throw new ProtectedPathError("23505", "duplicate key value violates unique constraint mr_one_binding_per_attempt");
    }
    if (this.boundXacts.has(xactId)) {
      throw new ProtectedPathError("23505", "duplicate key value violates unique constraint mr_one_attempt_per_xact");
    }
    const binding: RecordedBinding = { attempt, eventSequence: Number(eventSequence), xactId };
    this.bindings.set(key, binding);
    this.boundXacts.set(xactId, key);
    this.recordedBindings.push(binding);
    return binding;
  }

  /**
   * migration_control.record_applied_migration. The only writer of the applied
   * ledger, and the sole decider of commit_proof: a transactional attempt must
   * be executing inside the exact transaction its durable binding names.
   */
  recordApplied(
    token: unknown,
    manifestChecksum: unknown,
    lifecyclePhase: unknown,
    operationCategories: unknown,
    currentXactId: string | null,
  ): RecordedApplied {
    const attempt = this.attemptForToken(token);
    const executionMode = attempt.metadata.execution_mode;
    if (typeof attempt.metadata.checksum_sha256 !== "string"
      || typeof attempt.metadata.migration_filename !== "string"
      || typeof attempt.metadata.migration_ordinal !== "number"
      || typeof executionMode !== "string") {
      throw new ProtectedPathError(
        "55000",
        "the started attempt does not carry the identity required to record an applied migration",
      );
    }
    let commitProof: RecordedApplied["commitProof"];
    if (executionMode === "transactional") {
      const binding = this.bindings.get(ProtectedProofPath.attemptKey(attempt));
      if (binding === undefined) {
        throw new ProtectedPathError(
          "55000",
          "a transactional migration has no durable transaction binding; refusing to record unprovable commit proof",
        );
      }
      if (binding.xactId !== currentXactId) {
        throw new ProtectedPathError(
          "42501",
          "commit proof must be recorded from inside the exact bound migration transaction",
        );
      }
      commitProof = "transaction_atomic";
    } else {
      commitProof = "post_hoc_verified";
    }
    const applied: RecordedApplied = {
      attempt,
      manifestChecksum: String(manifestChecksum),
      lifecyclePhase: String(lifecyclePhase),
      operationCategories: (operationCategories ?? []) as string[],
      commitProof,
    };
    this.recordedApplied.push(applied);
    return applied;
  }

  /**
   * migration_control.record_progress_marker. Enforces the same three rules the
   * SQL does, as errors rather than as a reader's later interpretation: only 1
   * or 2 is a marker, marker 2 cannot precede marker 1, and neither ordinal can
   * be recorded twice for one attempt (mr_one_marker_per_attempt). Every
   * identity field on the returned row is the attempt's own, never the
   * caller's.
   */
  recordProgressMarker(token: unknown, eventSequence: unknown, ordinal: unknown): RecordedMarker {
    const attempt = this.attemptForToken(token);
    if (ordinal !== 1 && ordinal !== 2) {
      throw new ProtectedPathError("42501", "unknown migration progress marker");
    }
    const key = ProtectedProofPath.attemptKey(attempt);
    const recorded = this.markers.get(key) ?? new Set<number>();
    if (ordinal === 2 && !recorded.has(1)) {
      throw new ProtectedPathError(
        "55000",
        "the durable-work marker cannot precede the armed marker for this migration attempt",
      );
    }
    if (recorded.has(ordinal)) {
      throw new ProtectedPathError("23505", "duplicate key value violates unique constraint mr_one_marker_per_attempt");
    }
    recorded.add(ordinal);
    this.markers.set(key, recorded);
    const marker: RecordedMarker = { attempt, eventSequence: Number(eventSequence), ordinal };
    this.recordedMarkers.push(marker);
    return marker;
  }

  bindingFor(runId: string, migrationId: string): RecordedBinding | undefined {
    return this.bindings.get(`${runId}|${migrationId}`);
  }
}
