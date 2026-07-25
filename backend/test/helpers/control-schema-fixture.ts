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
].map(([table_name, column_name, formatted_type, not_null, default_expression]) => ({
  table_name, column_name, formatted_type, not_null, default_expression,
}));

const compatibleConstraintDefinition = [
  readFileSync(path.join(repositoryRoot, "db", "control", "control-schema.sql"), "utf8"),
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
].join("\n");

export const constraintRows = [
  ["schema_migrations", "schema_migrations_pkey", "p"],
  ["schema_migrations", "schema_migrations_ordinal_key", "u"],
  ["schema_migrations", "schema_migrations_filename_key", "u"],
  ...["sm_id_ck", "sm_ordinal_ck", "sm_filename_ck", "sm_manifest_sha_ck", "sm_applied_sha_ck", "sm_phase_ck", "sm_categories_ck", "sm_categories_order_ck", "sm_mode_ck", "sm_baseline_ck", "sm_source_sha_ck", "sm_image_digest_ck"]
    .map((name) => ["schema_migrations", name, "c"]),
  ["migration_runs", "migration_runs_pkey", "p"],
  ["migration_runs", "migration_runs_run_id_event_sequence_key", "u"],
  ...["mr_id_ck", "mr_sequence_ck", "mr_type_ck", "mr_heartbeat_ck", "mr_statement_ck", "mr_runner_ck", "mr_source_sha_ck", "mr_image_digest_ck", "mr_sqlstate_ck", "mr_error_class_ck", "mr_metadata_ck"]
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

export const functionRows = [
  {
    function_name: "canonical_operation_categories",
    language_name: "sql",
    volatility: "i",
    security_definer: false,
    config: ["search_path=pg_catalog, pg_temp"],
    public_execute: false,
    runtime_execute: false,
  },
  {
    function_name: "reject_ledger_mutation",
    language_name: "plpgsql",
    volatility: "v",
    security_definer: false,
    config: ["search_path=pg_catalog, pg_temp"],
    public_execute: false,
    runtime_execute: false,
  },
];

export const privilegeRows = [{
  public_schema: false,
  public_tables: false,
  public_sequences: false,
  runtime_schema: false,
  runtime_tables: false,
  runtime_sequences: false,
}];
