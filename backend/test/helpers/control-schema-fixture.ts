import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Catalog rows that satisfy verifyControlSchema, shared by the execution tests
 * so each case can focus on execution behaviour rather than re-stating the
 * Step-2 control-schema contract.
 */
const repositoryRoot = path.resolve(__dirname, "../../..");

export const columnRows = [
  ["schema_migrations", "migration_id", "text", true, null],
  ["schema_migrations", "ordinal", "integer", true, null],
  ["schema_migrations", "filename", "text", true, null],
  ["schema_migrations", "manifest_checksum_sha256", "character(64)", true, null],
  ["schema_migrations", "applied_checksum_sha256", "character(64)", false, null],
  ["schema_migrations", "lifecycle_phase", "text", true, null],
  ["schema_migrations", "operation_categories", "text[]", true, null],
  ["schema_migrations", "execution_mode", "text", true, null],
  ["schema_migrations", "applied_at", "timestamp with time zone", true, null],
  ["schema_migrations", "run_id", "uuid", true, null],
  ["schema_migrations", "baselined", "boolean", true, null],
  ["schema_migrations", "source_git_sha", "text", true, null],
  ["schema_migrations", "executor_image_digest", "text", true, null],
  ["schema_migrations", "commit_proof", "text", true, null],
  ["migration_runs", "event_id", "bigint", true, "nextval('migration_control.migration_runs_event_id_seq'::regclass)"],
  ["migration_runs", "run_id", "uuid", true, null],
  ["migration_runs", "migration_id", "text", true, null],
  ["migration_runs", "event_sequence", "integer", true, null],
  ["migration_runs", "event_type", "text", true, null],
  ["migration_runs", "occurred_at", "timestamp with time zone", true, "clock_timestamp()"],
  ["migration_runs", "runner_id", "text", false, null],
  ["migration_runs", "heartbeat_deadline", "timestamp with time zone", false, null],
  ["migration_runs", "statement_ordinal", "integer", false, null],
  ["migration_runs", "source_git_sha", "text", false, null],
  ["migration_runs", "executor_image_digest", "text", false, null],
  ["migration_runs", "sqlstate", "text", false, null],
  ["migration_runs", "error_class", "text", false, null],
  ["migration_runs", "metadata", "jsonb", true, null],
  ["migration_runs", "xact_id", "xid8", false, null],
  ["migration_runs", "attempt_token_sha256", "bytea", false, null],
].map(([table_name, column_name, formatted_type, not_null, default_expression]) => ({
  table_name, column_name, formatted_type, not_null, default_expression,
}));

/**
 * A stand-in constraint definition that contains every fragment
 * verifyControlSchema pins, sourced from the real SQL rather than restated —
 * so a fragment that no longer appears in the shipped schema fails here.
 *
 * All three installer files are concatenated: PB-10 Step 3 Phase 2c moved the
 * proof-path constraint bodies (commit_proof, xact_id, attempt_token_sha256)
 * into control-proof-path.sql so the fresh and upgrade paths share one
 * definition, and reading only control-schema.sql would silently stop covering
 * them.
 */
const compatibleConstraintDefinition = [
  readFileSync(path.join(repositoryRoot, "db", "control", "control-schema.sql"), "utf8"),
  readFileSync(path.join(repositoryRoot, "db", "control", "control-proof-path.sql"), "utf8"),
  readFileSync(path.join(repositoryRoot, "db", "control", "control-grants.sql"), "utf8"),
  "operation_categories = migration_control.canonical_operation_categories(operation_categories)",
  "PRIMARY KEY (migration_id)",
  "PRIMARY KEY (event_id)",
  "UNIQUE (ordinal)",
  "UNIQUE (filename)",
  "UNIQUE (run_id, event_sequence)",
  "WHEN ('schema'::text = ANY (operation_categories))",
  "WHEN ('data-correction'::text = ANY (operation_categories))",
  "WHEN ('security-policy'::text = ANY (operation_categories))",
  "WHEN ('function-replacement'::text = ANY (operation_categories))",
  "WHEN ('index'::text = ANY (operation_categories))",
  "WHEN ('seed-reference'::text = ANY (operation_categories))",
  // mr_marker_ck, as PostgreSQL deparses `statement_ordinal in (1, 2)`.
  "statement_ordinal = ANY (ARRAY[1, 2])",
].join("\n");

export const constraintRows = [
  ["schema_migrations", "schema_migrations_pkey", "p"],
  ["schema_migrations", "schema_migrations_ordinal_key", "u"],
  ["schema_migrations", "schema_migrations_filename_key", "u"],
  ...["sm_id_ck", "sm_ordinal_ck", "sm_filename_ck", "sm_manifest_sha_ck", "sm_applied_sha_ck", "sm_phase_ck", "sm_categories_ck", "sm_categories_order_ck", "sm_mode_ck", "sm_baseline_ck", "sm_source_sha_ck", "sm_image_digest_ck", "sm_commit_proof_ck", "sm_commit_proof_mode_ck"]
    .map((name) => ["schema_migrations", name, "c"]),
  ["migration_runs", "migration_runs_pkey", "p"],
  ["migration_runs", "migration_runs_run_id_event_sequence_key", "u"],
  ...["mr_id_ck", "mr_sequence_ck", "mr_type_ck", "mr_heartbeat_ck", "mr_statement_ck", "mr_runner_ck", "mr_source_sha_ck", "mr_image_digest_ck", "mr_sqlstate_ck", "mr_error_class_ck", "mr_metadata_ck", "mr_xact_ck", "mr_attempt_token_ck", "mr_marker_ck"]
    .map((name) => ["migration_runs", name, "c"]),
].map(([table_name, constraint_name, constraint_type]) => ({
  table_name,
  constraint_name,
  constraint_type,
  validated: true,
  deferrable: false,
  initially_deferred: false,
  definition: compatibleConstraintDefinition,
}));

export const triggerRows = [
  { table_name: "migration_runs", trigger_name: "migration_runs_reject_mutation", enabled: "A", trigger_type: 27, function_name: "reject_ledger_mutation" },
  { table_name: "migration_runs", trigger_name: "migration_runs_reject_truncate", enabled: "A", trigger_type: 34, function_name: "reject_ledger_mutation" },
  { table_name: "schema_migrations", trigger_name: "schema_migrations_reject_mutation", enabled: "A", trigger_type: 27, function_name: "reject_ledger_mutation" },
  { table_name: "schema_migrations", trigger_name: "schema_migrations_reject_truncate", enabled: "A", trigger_type: 34, function_name: "reject_ledger_mutation" },
];

/**
 * The three permanent relations verifyControlSchema requires: the two Step-2
 * ledger tables plus PB-10 Step 3 Phase 2c's protected proof key.
 */
export const tableRows = ["migration_runs", "proof_key", "schema_migrations"]
  .map((table_name) => ({ table_name }));

/**
 * Every function control-schema.sql creates, with the exact contract
 * verifyControlSchema pins. The four SECURITY DEFINER entries are the
 * protected proof path (CRITICAL 1 + CRITICAL 2): each is owned by
 * migration_control_owner — never by the execution role — carries a fixed
 * `search_path`, and is callable by neither PUBLIC nor the application role.
 */
export const functionRows = [
  ["canonical_operation_categories", "sql", "i", false],
  ["reject_ledger_mutation", "plpgsql", "v", false],
  ["attempt_for_token", "plpgsql", "s", true],
  ["claim_transaction", "plpgsql", "v", true],
  ["record_transaction_binding", "plpgsql", "v", true],
  ["record_applied_migration", "plpgsql", "v", true],
  ["record_progress_marker", "plpgsql", "v", true],
].map(([function_name, language_name, volatility, security_definer]) => ({
  function_name,
  language_name,
  volatility,
  security_definer,
  owner_role: "migration_control_owner",
  config: ["search_path=pg_catalog, pg_temp"],
  public_execute: false,
  runtime_execute: false,
}));

/**
 * CRITICAL 1 + CRITICAL 2: the runtime role-separation probe. Every field is
 * the *safe* answer — a correctly installed schema gives the execution role
 * none of these capabilities. Individual cases flip one field to prove the
 * corresponding fail-closed assertion actually fires.
 */
export const separationRows = [{
  is_superuser: false,
  owns_control_schema: false,
  member_of_owner: false,
  can_insert_applied: false,
  can_write_binding: false,
  can_read_proof_key: false,
  can_mutate_ledger: false,
}];

export const privilegeRows = [{
  public_schema: false,
  public_tables: false,
  public_sequences: false,
  runtime_schema: false,
  runtime_tables: false,
  runtime_sequences: false,
}];

export interface ControlSchemaDrift {
  /** Drop proof_key and migration_runs from the relation inventory. */
  missingTables?: boolean;
  /** Corrupt sm_id_ck's definition so the pinned-fragment check fails. */
  constraintDrift?: boolean;
  /** Remove the statement-level TRUNCATE-rejection triggers. */
  droppedTruncateTriggers?: boolean;
  /** Overlay onto the role-separation probe, e.g. `{ is_superuser: true }`. */
  separation?: Partial<(typeof separationRows)[number]>;
  /** Overlay onto the PUBLIC/runtime privilege probe. */
  privileges?: Partial<(typeof privilegeRows)[number]>;
}

/**
 * The single answer table for verifyControlSchema's catalog probes, shared by
 * every mocked suite. It lives here rather than being restated per test file
 * because a fixture that drifts from runner.ts's actual queries silently stops
 * exercising the contract it is supposed to model — which is exactly how the
 * proof-path probes were left unmodelled in two separate places.
 *
 * Returns undefined when the SQL is not a control-schema probe, so callers can
 * fall through to their own handlers.
 */
export function answerControlSchemaQuery(
  sql: string,
  drift: ControlSchemaDrift = {},
): { rows: unknown[]; rowCount: number } | undefined {
  const rows = (value: unknown[]) => ({ rows: value, rowCount: value.length });
  if (sql.includes("c.relkind in ('r', 'p')")) {
    return rows(drift.missingTables ? [{ table_name: "schema_migrations" }] : tableRows);
  }
  if (sql.includes("pg_attribute")) return rows(columnRows);
  if (sql.includes("pg_constraint")) {
    return rows(drift.constraintDrift
      ? constraintRows.map((row) => row.constraint_name === "sm_id_ck" ? { ...row, definition: "CHECK (true)" } : row)
      : constraintRows);
  }
  if (sql.includes("pg_trigger")) {
    return rows(drift.droppedTruncateTriggers
      ? triggerRows.filter((row) => !row.trigger_name.endsWith("_reject_truncate"))
      : triggerRows);
  }
  if (sql.includes("p.provolatile")) return rows(functionRows);
  // Ordered before the control_namespace probe: both mention pg_namespace, but
  // only the separation probe reads current_user's own privileges.
  if (sql.includes("as is_superuser")) {
    return rows([{ ...separationRows[0], ...drift.separation }]);
  }
  if (sql.includes("control_namespace")) {
    return rows([{ ...privilegeRows[0], ...drift.privileges }]);
  }
  return undefined;
}
