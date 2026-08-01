import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { ERROR_CLASSES } from "../src/db/migrate/execute";
import { ERROR_CLASSES as SOURCE_ERROR_CLASSES, LEGACY_ERROR_CLASSES } from "../src/db/migrate/execution-errors";

/**
 * PB-10 Step 3 Phase 2c final review, HIGH 1: the published error-class
 * vocabulary is a compatibility surface, and this is the durable test for it.
 *
 * The previous session removed `stale_legacy_attempt` from ERROR_CLASSES
 * because no current execution path emits it, then restored it after review —
 * but added no test, so the same removal could happen again silently. Three
 * things make that removal a breaking change rather than a tidy-up:
 *
 *   1. `migration_control.migration_runs` is INSERT-only and its rows can
 *      never be rewritten, so real installations still physically contain
 *      rows carrying that value. A reader that cannot name the class cannot
 *      describe its own history.
 *   2. `ErrorClass` is derived from this collection and both are re-exported
 *      from execute.ts and emitted into execute.d.ts. Narrowing an exported
 *      union breaks exhaustive switches and assignability for consumers.
 *   3. mr_error_class_ck accepts any lowercase identifier, so the database
 *      will keep such a row forever regardless of what TypeScript believes.
 *
 * The safety property that makes retaining it harmless is asserted here too:
 * a legacy class is never accepted as authoritative outcome proof, so an
 * attempt whose only terminal evidence carries one stays blocked.
 */

/** Every class any shipped generation of this runner has ever written. */
const HISTORICALLY_WRITTEN = [
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

test("H1: ERROR_CLASSES still contains every previously supported value", () => {
  for (const value of HISTORICALLY_WRITTEN) {
    assert.ok(
      (ERROR_CLASSES as readonly string[]).includes(value),
      `${value} was removed from ERROR_CLASSES; historical migration_runs rows carry it and must stay readable`,
    );
  }
  // And nothing unrelated was added or removed: the published set is exactly
  // the historical set, so a new class cannot slip into the public union
  // without this list — and the review of what it means — being updated.
  assert.deepEqual(
    [...ERROR_CLASSES].sort(),
    [...HISTORICALLY_WRITTEN].sort(),
    "the published error-class vocabulary changed; update HISTORICALLY_WRITTEN deliberately, never incidentally",
  );
  // execute.ts re-exports the leaf module's collection rather than restating it.
  assert.deepEqual([...ERROR_CLASSES], [...SOURCE_ERROR_CLASSES]);
});

test("H1: every legacy class is retained, and none of them is accepted as outcome proof", () => {
  for (const value of LEGACY_ERROR_CLASSES) {
    assert.ok(
      (ERROR_CLASSES as readonly string[]).includes(value),
      `${value} is listed as a legacy class but is not assignable as an ErrorClass`,
    );
  }

  // The fail-closed half. terminalProof only ever clears an attempt on an
  // execution_failed event whose class is in ROLLBACK_PROVABLE_CLASSES; that
  // set is module-private, so it is read from the source and asserted to be
  // disjoint from the legacy set. A legacy class joining it would silently
  // restore exactly the label-trusting inference CRITICAL 1 removed.
  const source = readFileSync(path.resolve(__dirname, "../src/db/migrate/execute.ts"), "utf8");
  const declaration = /const ROLLBACK_PROVABLE_CLASSES = new Set<string>\(\[(.*?)\]\)/s.exec(source);
  assert.ok(declaration, "ROLLBACK_PROVABLE_CLASSES must remain a single literal declaration for this check to be meaningful");
  const provable = [...declaration[1].matchAll(/"([a-z_]+)"/g)].map(([, value]) => value);
  assert.ok(provable.length > 0, "failed to parse ROLLBACK_PROVABLE_CLASSES");
  for (const legacy of LEGACY_ERROR_CLASSES) {
    assert.ok(
      !provable.includes(legacy),
      `${legacy} is a legacy class and must never be treated as proof that a transaction rolled back`,
    );
  }

  // No current execution path emits a legacy class either — the value exists
  // to be *read*, not written.
  for (const legacy of LEGACY_ERROR_CLASSES) {
    assert.ok(
      !new RegExp(`errorClass: "${legacy}"`).test(source),
      `${legacy} is a compatibility-only class and must not be emitted by new executions`,
    );
  }
});

test("H1: the emitted declaration and runtime keep the same vocabulary", () => {
  const buildRoot = mkdtempSync(path.join(os.tmpdir(), "pb10-error-class-"));
  try {
    const compiler = path.resolve(__dirname, "../node_modules/typescript/bin/tsc");
    execFileSync(process.execPath, [
      compiler,
      "--project", path.resolve(__dirname, "../tsconfig.json"),
      "--outDir", buildRoot,
      "--declaration",
    ], { encoding: "utf8" });

    // Loaded in a clean child process with NODE_PATH pointed at this
    // project's real node_modules: the disposable build directory has none of
    // its own, so requiring execute.js in-process would fail on `pg` rather
    // than tell us anything about the vocabulary.
    const emitted = path.join(buildRoot, "db", "migrate", "execute.js");
    const probe = execFileSync(process.execPath, [
      "-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(emitted)}).ERROR_CLASSES))`,
    ], { encoding: "utf8", env: { ...process.env, NODE_PATH: path.resolve(__dirname, "../node_modules") } });
    assert.deepEqual((JSON.parse(probe) as string[]).sort(), [...HISTORICALLY_WRITTEN].sort(),
      "the emitted build's runtime vocabulary must match the source's");

    // execute.d.ts must still publish the collection and the union derived
    // from it, so a consumer's `ErrorClass` keeps accepting historical values.
    // It re-exports both from the leaf module rather than restating them, so
    // the re-export is asserted here and the literal members where they are
    // actually emitted.
    const declaration = readFileSync(path.join(buildRoot, "db", "migrate", "execute.d.ts"), "utf8");
    assert.match(declaration, /export \{[^}]*\bERROR_CLASSES\b[^}]*\} from "\.\/execution-errors"/);
    assert.match(declaration, /export \{[^}]*\btype ErrorClass\b[^}]*\} from "\.\/execution-errors"/);
    // The compatibility list itself is not part of execute.ts's public surface.
    assert.ok(!/export .*LEGACY_ERROR_CLASSES/.test(declaration),
      "LEGACY_ERROR_CLASSES is an internal annotation, not a published export of execute.ts");

    const leaf = readFileSync(path.join(buildRoot, "db", "migrate", "execution-errors.d.ts"), "utf8");
    const emittedTuple = /export declare const ERROR_CLASSES: readonly \[(.*?)\];/s.exec(leaf);
    assert.ok(emittedTuple, "ERROR_CLASSES must stay a readonly literal tuple, or ErrorClass stops being a literal union");
    for (const value of HISTORICALLY_WRITTEN) {
      assert.ok(
        emittedTuple[1].includes(`"${value}"`),
        `${value} is absent from the emitted declaration; the exported union narrowed`,
      );
    }
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
});

after(() => {
  // The emitted build directory is removed above; nothing else to release.
});
