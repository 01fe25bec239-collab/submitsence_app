import { Pool, type PoolClient } from "pg";
import {
  type MigrationManifest,
  type MigrationManifestEntry,
} from "./manifest";

export const SCHEMA_ADVISORY_LOCK = [1398096461, 1] as const;
export const SCHEMA_LOCK_POLL_MS = 5_000;
export const SCHEMA_LOCK_BUDGET_MS = 60_000;
// Bound the plan once the advisory lock is held: without these a catalog read
// blocked behind concurrent DDL would hold the schema lock indefinitely.
export const SCHEMA_STATEMENT_TIMEOUT_MS = 30_000;
export const SCHEMA_LOCK_TIMEOUT_MS = 5_000;
export const LEGACY_LEDGER_TABLE = "public.infrastructure_schema_migrations";

const SHA256 = /^[0-9a-f]{64}$/;
export const GIT_SHA = /^[0-9a-f]{7,64}$/;
export const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AppliedMigrationRow {
  migration_id: string;
  ordinal: number;
  filename: string;
  manifest_checksum_sha256: string;
  applied_checksum_sha256: string | null;
  lifecycle_phase: string;
  operation_categories: string[];
  execution_mode: string;
  applied_at: Date | string;
  run_id: string;
  baselined: boolean;
  source_git_sha: string;
  executor_image_digest: string;
}

export interface MigrationPlan {
  schemaVersion: 1;
  manifestSchemaVersion: 1;
  legacyBoundary: string;
  database: {
    controlSchema: "verified";
    appliedSet: "valid-prefix";
  };
  appliedCount: number;
  pendingCount: number;
  pendingMigrations: Array<{
    id: string;
    filename: string;
    sha256: string;
    lifecyclePhase: MigrationManifestEntry["lifecyclePhase"];
    operationCategories: MigrationManifestEntry["operationCategories"];
    executionMode: MigrationManifestEntry["executionMode"];
    requiredRuntimeEpoch: number | null;
    timeouts: MigrationManifestEntry["timeouts"];
  }>;
  totalDeclaredWallClockMs: number;
  advisoryLock: {
    namespaceKey: number;
    purposeKey: number;
    pollMs: number;
    budgetMs: number;
  };
  warnings: string[];
}

export type LockDiagnostic = {
  holder_pid: number;
  application_name: string | null;
  client_identity: string | null;
  state: string | null;
  transaction_age: string | null;
  query_age: string | null;
  wait_event_type: string | null;
  command_summary: string;
};

export interface SchemaLockOptions {
  pollMs?: number;
  budgetMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  diagnose?: (holders: LockDiagnostic[]) => void;
}

const expectedColumns = new Map<string, Map<string, { type: string; nullable: boolean; defaultIncludes?: string }>>([
  ["schema_migrations", new Map([
    ["migration_id", { type: "text", nullable: false }],
    ["ordinal", { type: "integer", nullable: false }],
    ["filename", { type: "text", nullable: false }],
    ["manifest_checksum_sha256", { type: "character(64)", nullable: false }],
    ["applied_checksum_sha256", { type: "character(64)", nullable: true }],
    ["lifecycle_phase", { type: "text", nullable: false }],
    ["operation_categories", { type: "text[]", nullable: false }],
    ["execution_mode", { type: "text", nullable: false }],
    ["applied_at", { type: "timestamp with time zone", nullable: false }],
    ["run_id", { type: "uuid", nullable: false }],
    ["baselined", { type: "boolean", nullable: false }],
    ["source_git_sha", { type: "text", nullable: false }],
    ["executor_image_digest", { type: "text", nullable: false }],
    // PB-10 Step 3 Phase 2c final review, CRITICAL 1: the database's own
    // classification of how this applied row came to exist. Written only by
    // migration_control.record_applied_migration; the execution role has no
    // INSERT privilege on this table at all.
    ["commit_proof", { type: "text", nullable: false }],
  ])],
  ["migration_runs", new Map([
    ["event_id", { type: "bigint", nullable: false, defaultIncludes: "nextval" }],
    ["run_id", { type: "uuid", nullable: false }],
    ["migration_id", { type: "text", nullable: false }],
    ["event_sequence", { type: "integer", nullable: false }],
    ["event_type", { type: "text", nullable: false }],
    ["occurred_at", { type: "timestamp with time zone", nullable: false, defaultIncludes: "clock_timestamp()" }],
    ["runner_id", { type: "text", nullable: true }],
    ["heartbeat_deadline", { type: "timestamp with time zone", nullable: true }],
    ["statement_ordinal", { type: "integer", nullable: true }],
    ["source_git_sha", { type: "text", nullable: true }],
    ["executor_image_digest", { type: "text", nullable: true }],
    ["sqlstate", { type: "text", nullable: true }],
    ["error_class", { type: "text", nullable: true }],
    ["metadata", { type: "jsonb", nullable: false }],
    // PB-10 Step 3 Phase 2c final review, CRITICAL 1: the transaction-outcome
    // binding (see db/control/control-schema.sql).
    ["xact_id", { type: "xid8", nullable: true }],
    // CRITICAL 2: sha256 of the attempt's claim token. The token itself is
    // never stored, so SELECT on this table does not confer the ability to
    // reach the protected proof path for any attempt.
    ["attempt_token_sha256", { type: "bytea", nullable: true }],
  ])],
]);

const expectedConstraints = new Map<string, Map<string, "p" | "u" | "c">>([
  ["schema_migrations", new Map([
    ["schema_migrations_pkey", "p"],
    ["schema_migrations_ordinal_key", "u"],
    ["schema_migrations_filename_key", "u"],
    ["sm_id_ck", "c"],
    ["sm_ordinal_ck", "c"],
    ["sm_filename_ck", "c"],
    ["sm_manifest_sha_ck", "c"],
    ["sm_applied_sha_ck", "c"],
    ["sm_phase_ck", "c"],
    ["sm_categories_ck", "c"],
    ["sm_categories_order_ck", "c"],
    ["sm_mode_ck", "c"],
    ["sm_baseline_ck", "c"],
    ["sm_source_sha_ck", "c"],
    ["sm_image_digest_ck", "c"],
    ["sm_commit_proof_ck", "c"],
    ["sm_commit_proof_mode_ck", "c"],
  ])],
  ["migration_runs", new Map([
    ["migration_runs_pkey", "p"],
    ["migration_runs_run_id_event_sequence_key", "u"],
    ["mr_id_ck", "c"],
    ["mr_sequence_ck", "c"],
    ["mr_type_ck", "c"],
    ["mr_heartbeat_ck", "c"],
    ["mr_statement_ck", "c"],
    ["mr_runner_ck", "c"],
    ["mr_source_sha_ck", "c"],
    ["mr_image_digest_ck", "c"],
    ["mr_sqlstate_ck", "c"],
    ["mr_error_class_ck", "c"],
    ["mr_metadata_ck", "c"],
    ["mr_xact_ck", "c"],
    ["mr_attempt_token_ck", "c"],
    ["mr_marker_ck", "c"],
  ])],
]);

const constraintDefinitionFragments = new Map<string, string[]>([
  ["schema_migrations_pkey", ["PRIMARY KEY (migration_id)"]],
  ["schema_migrations_ordinal_key", ["UNIQUE (ordinal)"]],
  ["schema_migrations_filename_key", ["UNIQUE (filename)"]],
  ["sm_id_ck", ["migration_id ~ '^[0-9]{4}$'"]],
  ["sm_ordinal_ck", ["ordinal > 0"]],
  ["sm_filename_ck", ["filename ~ '^[0-9]{4}_", "left", "migration_id"]],
  ["sm_manifest_sha_ck", ["manifest_checksum_sha256 ~ '^[0-9a-f]{64}$'"]],
  ["sm_applied_sha_ck", ["applied_checksum_sha256 IS NULL", "applied_checksum_sha256 ~ '^[0-9a-f]{64}$'"]],
  ["sm_phase_ck", ["lifecycle_phase", "'expand'", "'backfill'", "'contract'"]],
  ["sm_categories_ck", [
    "cardinality(operation_categories) > 0",
    "operation_categories <@",
    "'schema'",
    "'data-correction'",
    "'security-policy'",
    "'function-replacement'",
    "'index'",
    "'seed-reference'",
    "'schema'::text = ANY (operation_categories)",
    "'data-correction'::text = ANY (operation_categories)",
    "'security-policy'::text = ANY (operation_categories)",
    "'function-replacement'::text = ANY (operation_categories)",
    "'index'::text = ANY (operation_categories)",
    "'seed-reference'::text = ANY (operation_categories)",
  ]],
  ["sm_categories_order_ck", ["operation_categories = migration_control.canonical_operation_categories(operation_categories)"]],
  // PB-10 Step 3 Phase 2c final review, CRITICAL 1: the applied row's own
  // record of how the database classified its provenance. Pinned here because
  // the evaluator refuses a transactional attempt's applied row unless it says
  // 'transaction_atomic' — a schema that silently permitted any other value on
  // a transactional row would let a post-hoc row masquerade as atomic proof.
  ["sm_commit_proof_ck", ["commit_proof", "'transaction_atomic'", "'post_hoc_verified'", "'baseline'"]],
  ["sm_commit_proof_mode_ck", [
    "commit_proof = 'transaction_atomic'",
    "NOT baselined",
    "execution_mode = 'transactional'",
    "commit_proof = 'post_hoc_verified'",
    "'nontransactional'",
    "'batched'",
    "'legacy-verbatim'",
    "commit_proof = 'baseline'",
  ]],
  ["sm_mode_ck", ["execution_mode", "'legacy-verbatim'", "'transactional'", "'nontransactional'", "'batched'"]],
  ["sm_baseline_ck", ["baselined", "applied_checksum_sha256 IS NULL", "execution_mode = 'legacy-verbatim'", "NOT baselined", "applied_checksum_sha256 IS NOT NULL"]],
  ["sm_source_sha_ck", ["source_git_sha ~ '^[0-9a-f]{7,64}$'"]],
  ["sm_image_digest_ck", ["executor_image_digest ~ '^sha256:[0-9a-f]{64}$'"]],
  ["migration_runs_pkey", ["PRIMARY KEY (event_id)"]],
  ["migration_runs_run_id_event_sequence_key", ["UNIQUE (run_id, event_sequence)"]],
  ["mr_id_ck", ["migration_id ~ '^[0-9]{4}$'"]],
  ["mr_sequence_ck", ["event_sequence > 0"]],
  ["mr_type_ck", ["event_type", "'started'", "'heartbeat'", "'transaction_rolled_back'", "'operation_completed'", "'execution_failed'", "'applied_committed'", "'verification_failed'", "'succeeded'", "'stale_reclaimed'"]],
  ["mr_heartbeat_ck", ["heartbeat_deadline IS NULL", "event_type", "'started'", "'heartbeat'"]],
  ["mr_statement_ck", ["statement_ordinal IS NULL", "statement_ordinal > 0"]],
  ["mr_xact_ck", ["xact_id is null", "event_type = 'heartbeat'"]],
  // CRITICAL 2: the attempt claim digest lives on the `started` row and
  // nowhere else, and is a full sha256. A schema that allowed it on a later
  // event would let a second row re-arm an attempt that was already armed.
  ["mr_attempt_token_ck", ["attempt_token_sha256 IS NULL", "event_type = 'started'", "octet_length(attempt_token_sha256) = 32"]],
  // PB-10 Step 3 Phase 2c final review, CRITICAL: an H2 progress marker is a
  // `heartbeat` row carrying statement_ordinal 1 or 2 and no transaction
  // binding, and nothing else in the ledger may take that shape. The privilege
  // model (control-grants.sql withholds INSERT on statement_ordinal) is what
  // makes markers unforgeable; this constraint is what stops another event type
  // from impersonating one.
  ["mr_marker_ck", ["event_type <> 'heartbeat'", "statement_ordinal IS NULL", "statement_ordinal = ANY (ARRAY[1, 2])", "xact_id IS NULL"]],
  ["mr_runner_ck", ["runner_id IS NULL", "runner_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'"]],
  ["mr_source_sha_ck", ["source_git_sha IS NULL", "source_git_sha ~ '^[0-9a-f]{7,64}$'"]],
  ["mr_image_digest_ck", ["executor_image_digest IS NULL", "executor_image_digest ~ '^sha256:[0-9a-f]{64}$'"]],
  ["mr_sqlstate_ck", ["sqlstate IS NULL", "sqlstate ~ '^[0-9A-Z]{5}$'"]],
  ["mr_error_class_ck", ["error_class IS NULL", "error_class ~ '^[a-z][a-z0-9_]{0,63}$'"]],
  ["mr_metadata_ck", [
    "jsonb_typeof(metadata) = 'object'",
    "duration_ms",
    "elapsed_ms",
    "rows_affected",
    "statement_count",
    "batch_number",
    "retry_count",
    "operation_category",
    "execution_mode",
    "migration_filename",
    "migration_ordinal",
    "verification",
    "reclaim_reason",
    "9007199254740991",
    "trunc",
    "metadata -> 'duration_ms'",
    "metadata -> 'elapsed_ms'",
    "metadata -> 'rows_affected'",
    "metadata -> 'statement_count'",
    "metadata -> 'batch_number'",
    "metadata -> 'retry_count'",
    "metadata -> 'migration_filename'",
    "metadata -> 'migration_ordinal'",
    "'passed'",
    "'failed'",
    "'heartbeat_expired'",
    "'connection_lost'",
    "'operator_approved'",
  ]],
]);

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}


function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateAppliedRow(row: AppliedMigrationRow, entry: MigrationManifestEntry, index: number, legacyBoundary: string): void {
  assertCondition(Number.isInteger(row.ordinal) && row.ordinal === index + 1, `Applied history is not a contiguous ordinal prefix at ${row.migration_id}`);
  assertCondition(row.migration_id === entry.id, `Applied history ordering or migration ID mismatch at ordinal ${row.ordinal}`);
  assertCondition(row.filename === entry.filename, `Filename mismatch for migration ${entry.id}`);
  assertCondition(SHA256.test(row.manifest_checksum_sha256) && row.manifest_checksum_sha256 === entry.sha256, `Manifest checksum mismatch for migration ${entry.id}`);
  assertCondition(row.lifecycle_phase === entry.lifecyclePhase, `Lifecycle phase mismatch for migration ${entry.id}`);
  assertCondition(Array.isArray(row.operation_categories) && sameStrings(row.operation_categories, entry.operationCategories), `Operation category mismatch for migration ${entry.id}`);
  assertCondition(row.execution_mode === entry.executionMode, `Execution mode mismatch for migration ${entry.id}`);
  assertCondition(UUID.test(row.run_id), `Invalid run_id for migration ${entry.id}`);
  assertCondition(Number.isFinite(new Date(row.applied_at).getTime()), `Invalid applied_at for migration ${entry.id}`);
  assertCondition(GIT_SHA.test(row.source_git_sha), `Invalid source_git_sha for migration ${entry.id}`);
  assertCondition(IMAGE_DIGEST.test(row.executor_image_digest), `Invalid executor_image_digest for migration ${entry.id}`);

  if (row.baselined) {
    assertCondition(Number(row.migration_id) <= Number(legacyBoundary), `Baselined migration ${entry.id} exceeds the legacy boundary`);
    assertCondition(row.execution_mode === "legacy-verbatim", `Baselined migration ${entry.id} is not legacy-verbatim`);
    assertCondition(row.applied_checksum_sha256 === null, `Baselined migration ${entry.id} must not claim observed deployed bytes`);
  } else {
    assertCondition(row.applied_checksum_sha256 !== null, `Migration ${entry.id} has an invalid null applied checksum`);
    assertCondition(SHA256.test(row.applied_checksum_sha256) && row.applied_checksum_sha256 === entry.sha256, `Applied checksum mismatch for migration ${entry.id}`);
  }
}

export function buildMigrationPlan(
  manifest: MigrationManifest,
  appliedRows: AppliedMigrationRow[],
  lockOptions: Pick<SchemaLockOptions, "pollMs" | "budgetMs"> = {},
): MigrationPlan {
  const manifestById = new Map(manifest.migrations.map((entry) => [entry.id, entry]));
  for (const row of appliedRows) {
    assertCondition(manifestById.has(row.migration_id), `Applied migration ${row.migration_id} is not present in the manifest`);
  }
  assertCondition(appliedRows.length <= manifest.migrations.length, "Applied history is longer than the manifest");

  for (const [index, row] of appliedRows.entries()) {
    validateAppliedRow(row, manifest.migrations[index], index, manifest.legacyBoundary);
  }

  const pending = manifest.migrations.slice(appliedRows.length).map((entry) => ({
    id: entry.id,
    filename: entry.filename,
    sha256: entry.sha256,
    lifecyclePhase: entry.lifecyclePhase,
    operationCategories: [...entry.operationCategories],
    executionMode: entry.executionMode,
    requiredRuntimeEpoch: entry.requiredRuntimeEpoch,
    timeouts: { ...entry.timeouts },
  }));

  return {
    schemaVersion: 1,
    manifestSchemaVersion: manifest.schemaVersion,
    legacyBoundary: manifest.legacyBoundary,
    database: {
      controlSchema: "verified",
      appliedSet: "valid-prefix",
    },
    appliedCount: appliedRows.length,
    pendingCount: pending.length,
    pendingMigrations: pending,
    totalDeclaredWallClockMs: pending.reduce((total, entry) => total + entry.timeouts.wallClockMs, 0),
    advisoryLock: {
      namespaceKey: SCHEMA_ADVISORY_LOCK[0],
      purposeKey: SCHEMA_ADVISORY_LOCK[1],
      pollMs: lockOptions.pollMs ?? SCHEMA_LOCK_POLL_MS,
      budgetMs: lockOptions.budgetMs ?? SCHEMA_LOCK_BUDGET_MS,
    },
    warnings: [
      "PB-10 Step 3 execution is implemented; migrate:plan remains read-only.",
      "Current legacy checksums do not prove historical deployed bytes.",
      "Persistent environments have not been baselined.",
    ],
  };
}

export function renderMigrationPlan(plan: MigrationPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export async function verifyControlSchema(client: PoolClient): Promise<void> {
  const schema = await client.query<{ present: boolean }>(
    "select pg_catalog.to_regnamespace($1) is not null as present",
    ["migration_control"],
  );
  assertCondition(
    schema.rows[0]?.present === true,
    "Control schema migration_control does not exist; install db/control/control-schema.sql before planning",
  );

  const objects = await client.query<{ table_name: string }>(`
    select c.relname as table_name
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relkind in ('r', 'p')
     order by c.relname
  `, ["migration_control"]);
  assertCondition(
    // PB-10 Step 3 Phase 2c final review, CRITICAL 1: proof_key joins the two
    // Step-2 ledger tables. It holds the key behind the transaction-binding
    // receipt, is owned by migration_control_owner, and is granted to no
    // role at all — the execution role cannot read it, which is what stops it
    // computing a receipt for any (attempt, transaction) pair the protected
    // functions did not themselves produce. Its absence would silently
    // disable that protection, so it is required here, not merely tolerated.
    sameStrings(objects.rows.map(({ table_name }) => table_name), ["migration_runs", "proof_key", "schema_migrations"]),
    "migration_control must contain exactly the two permanent ledger tables and the protected proof key",
  );

  const columns = await client.query<{
    table_name: string;
    column_name: string;
    formatted_type: string;
    not_null: boolean;
    default_expression: string | null;
  }>(`
    select c.relname as table_name,
           a.attname as column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) as formatted_type,
           a.attnotnull as not_null,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expression
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid
      left join pg_catalog.pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
     where n.nspname = $1
       and c.relname = any($2::text[])
       and a.attnum > 0
       and not a.attisdropped
     order by c.relname, a.attnum
  `, ["migration_control", ["schema_migrations", "migration_runs"]]);
  const seenColumns = new Map<string, Set<string>>();
  for (const column of columns.rows) {
    const expected = expectedColumns.get(column.table_name)?.get(column.column_name);
    assertCondition(expected, `Unexpected control-schema column ${column.table_name}.${column.column_name}`);
    assertCondition(column.formatted_type === expected.type, `Incompatible type for ${column.table_name}.${column.column_name}`);
    assertCondition(column.not_null === !expected.nullable, `Incompatible nullability for ${column.table_name}.${column.column_name}`);
    if (expected.defaultIncludes) {
      assertCondition(column.default_expression?.includes(expected.defaultIncludes), `Incompatible default for ${column.table_name}.${column.column_name}`);
    } else {
      assertCondition(column.default_expression === null, `Unexpected default for ${column.table_name}.${column.column_name}`);
    }
    const seen = seenColumns.get(column.table_name) ?? new Set<string>();
    seen.add(column.column_name);
    seenColumns.set(column.table_name, seen);
  }
  for (const [table, expected] of expectedColumns) {
    assertCondition(seenColumns.get(table)?.size === expected.size, `Missing required columns from migration_control.${table}`);
    assertCondition(!seenColumns.get(table)?.has("status"), `Mutable status column is prohibited on migration_control.${table}`);
  }

  const constraints = await client.query<{
    table_name: string;
    constraint_name: string;
    constraint_type: "p" | "u" | "c";
    validated: boolean;
    deferrable: boolean;
    initially_deferred: boolean;
    definition: string;
  }>(`
    select c.relname as table_name,
           con.conname as constraint_name,
           con.contype as constraint_type,
           con.convalidated as validated,
           con.condeferrable as deferrable,
           con.condeferred as initially_deferred,
           pg_catalog.pg_get_constraintdef(con.oid, false) as definition
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class c on c.oid = con.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = any($2::text[])
     order by c.relname, con.conname
  `, ["migration_control", ["schema_migrations", "migration_runs"]]);
  const seenConstraints = new Map<string, Set<string>>();
  for (const constraint of constraints.rows) {
    const expected = expectedConstraints.get(constraint.table_name)?.get(constraint.constraint_name);
    assertCondition(expected === constraint.constraint_type, `Unexpected or incompatible constraint ${constraint.table_name}.${constraint.constraint_name}`);
    assertCondition(
      constraint.validated && !constraint.deferrable && !constraint.initially_deferred,
      `Constraint ${constraint.table_name}.${constraint.constraint_name} is not immediate and validated`,
    );
    assertCondition(
      constraintDefinitionFragments.get(constraint.constraint_name)?.every((fragment) =>
        constraint.definition.toLowerCase().includes(fragment.toLowerCase())),
      `Constraint definition drift for ${constraint.table_name}.${constraint.constraint_name}`,
    );
    const seen = seenConstraints.get(constraint.table_name) ?? new Set<string>();
    seen.add(constraint.constraint_name);
    seenConstraints.set(constraint.table_name, seen);
  }
  for (const [table, expected] of expectedConstraints) {
    assertCondition(seenConstraints.get(table)?.size === expected.size, `Missing required constraints from migration_control.${table}`);
  }

  const triggers = await client.query<{ table_name: string; trigger_name: string; enabled: string; trigger_type: number; function_name: string }>(`
    select c.relname as table_name,
           t.tgname as trigger_name,
           t.tgenabled as enabled,
           t.tgtype as trigger_type,
           p.proname as function_name
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_proc p on p.oid = t.tgfoid
     where n.nspname = $1 and not t.tgisinternal
     order by c.relname, t.tgname
  `, ["migration_control"]);
  // 27 = ROW|BEFORE|DELETE|UPDATE, 34 = STATEMENT|BEFORE|TRUNCATE. TRUNCATE does
  // not fire row triggers, so both are required for an immutable ledger.
  const expectedTriggers = [
    ["schema_migrations", "schema_migrations_reject_mutation", 27],
    ["schema_migrations", "schema_migrations_reject_truncate", 34],
    ["migration_runs", "migration_runs_reject_mutation", 27],
    ["migration_runs", "migration_runs_reject_truncate", 34],
  ] as const;
  assertCondition(
    triggers.rows.length === expectedTriggers.length,
    `Control ledger tables must have exactly ${expectedTriggers.length} mutation-rejection triggers`,
  );
  for (const [table, trigger, triggerType] of expectedTriggers) {
    assertCondition(
      triggers.rows.some((row) =>
        row.table_name === table
        && row.trigger_name === trigger
        && row.enabled === "A"
        && row.trigger_type === triggerType
        && row.function_name === "reject_ledger_mutation"),
      `Missing enabled mutation-rejection trigger ${trigger} on migration_control.${table}`,
    );
  }

  const functionContract = await client.query<{
    function_name: string;
    language_name: string;
    volatility: string;
    security_definer: boolean;
    owner_role: string;
    config: string[] | null;
    public_execute: boolean;
    runtime_execute: boolean;
  }>(`
    select p.proname as function_name,
           l.lanname as language_name,
           p.provolatile::text as volatility,
           p.prosecdef as security_definer,
           pg_catalog.pg_get_userbyid(p.proowner) as owner_role,
           p.proconfig as config,
           exists (
             select 1
               from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
              where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
           ) as public_execute,
           case when pg_catalog.to_regrole('submitsense_app') is null then false
             else pg_catalog.has_function_privilege(
               pg_catalog.to_regrole('submitsense_app'),
               p.oid,
               'EXECUTE'
             )
           end as runtime_execute
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_language l on l.oid = p.prolang
     where n.nspname = $1
     order by p.proname
  `, ["migration_control"]);
  // canonical_operation_categories backs sm_categories_order_ck, so its
  // contract is as load-bearing as the mutation-rejection function's.
  //
  // PB-10 Step 3 Phase 2c final review, CRITICAL 1 + CRITICAL 2: the last four
  // are the protected proof path, and their SECURITY DEFINER flag is verified
  // as *required* rather than merely permitted. If one of them were silently
  // replaced by a SECURITY INVOKER function it would execute with the
  // migration execution role's own (deliberately insufficient) privileges and
  // every proof would fail — but a definer function owned by the *wrong* role
  // would instead execute with whatever that role can do, which is why the
  // owner is pinned here too. A fixed search_path is mandatory on all of them:
  // a SECURITY DEFINER function without one is the classic privilege-
  // escalation vector (CVE-2018-1058).
  const expectedFunctions = [
    ["canonical_operation_categories", "sql", "i", false],
    ["reject_ledger_mutation", "plpgsql", "v", false],
    ["attempt_for_token", "plpgsql", "s", true],
    ["claim_transaction", "plpgsql", "v", true],
    ["record_transaction_binding", "plpgsql", "v", true],
    ["record_applied_migration", "plpgsql", "v", true],
    // PB-10 Step 3 Phase 2c final review, CRITICAL: the sole writer of an H2
    // progress marker. A marker permits SAFE_TO_RETRY, so it needs the same
    // protected provenance as commit proof and transaction bindings.
    ["record_progress_marker", "plpgsql", "v", true],
  ] as const;
  assertCondition(
    functionContract.rows.length === expectedFunctions.length,
    `migration_control must contain exactly ${expectedFunctions.length} control functions`,
  );
  for (const [name, language, volatility, securityDefiner] of expectedFunctions) {
    const contract = functionContract.rows.find((row) => row.function_name === name);
    assertCondition(
      contract
      && contract.language_name === language
      && contract.volatility === volatility
      && contract.security_definer === securityDefiner
      && contract.owner_role === "migration_control_owner"
      && contract.config?.includes("search_path=pg_catalog, pg_temp")
      && contract.public_execute === false
      && contract.runtime_execute === false,
      `Control function contract is incompatible for migration_control.${name}`,
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // PB-10 Step 3 Phase 2c final review, CRITICAL 1 + CRITICAL 2: role
  // separation, verified at runtime against the connection the migration will
  // actually run on.
  //
  // Every unforgeability property this schema provides rests on one fact:
  // the role executing migration SQL cannot write proof directly. That is a
  // property of the *installation*, not of the SQL files in this repository —
  // an operator who installed the old single-owner way, granted the runner
  // ownership back, or simply runs migrations as a superuser has silently
  // reinstated forgeable commit proof, and nothing else in this codebase
  // would notice. So it is asserted here, before a single byte of migration
  // SQL runs, and the run fails closed if it does not hold.
  //
  // Note this is checked with has_*_privilege against current_user, which
  // accounts for privileges reached through role membership as well as direct
  // grants — a runner that merely *inherits* the owner's rights fails just as
  // a directly-granted one does.
  const separation = await client.query<{
    is_superuser: boolean;
    owns_control_schema: boolean;
    member_of_owner: boolean;
    can_insert_applied: boolean;
    can_write_binding: boolean;
    can_write_marker: boolean;
    can_read_proof_key: boolean;
    can_mutate_ledger: boolean;
  }>(`
    select
      (select rolsuper from pg_catalog.pg_roles where rolname = current_user) as is_superuser,
      pg_catalog.pg_has_role(current_user, n.nspowner, 'USAGE') as owns_control_schema,
      coalesce(
        pg_catalog.pg_has_role(current_user, pg_catalog.to_regrole('migration_control_owner'), 'USAGE'),
        false
      ) as member_of_owner,
      pg_catalog.has_table_privilege('migration_control.schema_migrations', 'INSERT') as can_insert_applied,
      pg_catalog.has_column_privilege('migration_control.migration_runs', 'xact_id', 'INSERT') as can_write_binding,
      pg_catalog.has_column_privilege('migration_control.migration_runs', 'statement_ordinal', 'INSERT') as can_write_marker,
      coalesce(
        pg_catalog.has_table_privilege('migration_control.proof_key', 'SELECT'),
        false
      ) as can_read_proof_key,
      (pg_catalog.has_table_privilege('migration_control.schema_migrations', 'UPDATE')
       or pg_catalog.has_table_privilege('migration_control.schema_migrations', 'DELETE')
       or pg_catalog.has_table_privilege('migration_control.schema_migrations', 'TRUNCATE')
       or pg_catalog.has_table_privilege('migration_control.migration_runs', 'UPDATE')
       or pg_catalog.has_table_privilege('migration_control.migration_runs', 'DELETE')
       or pg_catalog.has_table_privilege('migration_control.migration_runs', 'TRUNCATE')) as can_mutate_ledger
      from pg_catalog.pg_namespace n
     where n.nspname = 'migration_control'
  `);
  const roleModel = separation.rows[0];
  assertCondition(roleModel, "Could not determine the migration_control ownership model");
  assertCondition(
    roleModel.is_superuser !== true,
    "The migration runner is connected as a superuser, which bypasses every privilege the commit-proof design relies on; connect as the dedicated migration execution role (see db/README.md)",
  );
  assertCondition(
    roleModel.owns_control_schema !== true && roleModel.member_of_owner !== true,
    "The migration runner owns (or is a member of the owner of) migration_control, so it could forge commit proof directly; reinstall the control schema with role separation (see db/README.md)",
  );
  assertCondition(
    roleModel.can_insert_applied !== true,
    "The migration runner can INSERT into migration_control.schema_migrations directly, so an applied row is not authoritative commit proof; reinstall the control schema with role separation (see db/README.md)",
  );
  assertCondition(
    roleModel.can_write_binding !== true,
    "The migration runner can write migration_control.migration_runs.xact_id directly, so a transaction binding is not authoritative; reinstall the control schema with role separation (see db/README.md)",
  );
  assertCondition(
    roleModel.can_write_marker !== true,
    "The migration runner can write migration_control.migration_runs.statement_ordinal directly, so an H2 progress marker is not authoritative and replay could be authorized by forged evidence; reinstall the control schema with role separation (see db/README.md)",
  );
  assertCondition(
    roleModel.can_read_proof_key !== true,
    "The migration runner can read migration_control.proof_key, so it could forge a transaction-binding receipt; reinstall the control schema with role separation (see db/README.md)",
  );
  assertCondition(
    roleModel.can_mutate_ledger !== true,
    "The migration runner holds UPDATE, DELETE or TRUNCATE on a control ledger table; the ledger must be append-only for the execution role",
  );

  const privileges = await client.query<{
    public_schema: boolean;
    public_tables: boolean;
    public_sequences: boolean;
    runtime_schema: boolean;
    runtime_tables: boolean;
    runtime_sequences: boolean;
  }>(`
    with control_namespace as (
      select oid, nspowner, nspacl
        from pg_catalog.pg_namespace
       where nspname = $1
    ),
    control_relations as (
      select c.oid, c.relkind, c.relowner, c.relacl
        from pg_catalog.pg_class c
        join control_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p', 'S')
    )
    select
      exists (
        select 1 from control_namespace n,
        lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) acl
        where acl.grantee = 0
      ) as public_schema,
      exists (
        select 1 from control_relations r,
        lateral pg_catalog.aclexplode(coalesce(r.relacl, pg_catalog.acldefault('r', r.relowner))) acl
        where r.relkind in ('r', 'p') and acl.grantee = 0
      ) as public_tables,
      exists (
        select 1 from control_relations r,
        lateral pg_catalog.aclexplode(coalesce(r.relacl, pg_catalog.acldefault('S', r.relowner))) acl
        where r.relkind = 'S' and acl.grantee = 0
      ) as public_sequences,
      case when pg_catalog.to_regrole('submitsense_app') is null then false
        else pg_catalog.has_schema_privilege(pg_catalog.to_regrole('submitsense_app'), (select oid from control_namespace), 'USAGE,CREATE')
      end as runtime_schema,
      case when pg_catalog.to_regrole('submitsense_app') is null then false
        else exists (
          select 1 from control_relations r
           where r.relkind in ('r', 'p')
             and pg_catalog.has_table_privilege(pg_catalog.to_regrole('submitsense_app'), r.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        )
      end as runtime_tables,
      case when pg_catalog.to_regrole('submitsense_app') is null then false
        else exists (
          select 1 from control_relations r
           where r.relkind = 'S'
             and pg_catalog.has_sequence_privilege(pg_catalog.to_regrole('submitsense_app'), r.oid, 'USAGE,SELECT,UPDATE')
        )
      end as runtime_sequences
  `, ["migration_control"]);
  const access = privileges.rows[0];
  assertCondition(
    privileges.rows.length === 1
    && !access.public_schema
    && !access.public_tables
    && !access.public_sequences
    && !access.runtime_schema
    && !access.runtime_tables
    && !access.runtime_sequences,
    "PUBLIC or submitsense_app has migration-control runtime privileges",
  );
}



/**
 * The legacy ledger has filenames and timestamps but no checksums. A compatible
 * state therefore requires the control ledger to be a valid manifest prefix and
 * the complete legacy filename sequence to match it exactly.
 */
export async function assertNoLegacyLedgerDivergence(
  client: PoolClient,
  appliedRows: AppliedMigrationRow[],
  manifest: MigrationManifest,
): Promise<void> {
  const present = await client.query<{ present: boolean }>(
    "select pg_catalog.to_regclass($1) is not null as present",
    [LEGACY_LEDGER_TABLE],
  );
  if (present.rows[0]?.present !== true) return;
  const legacy = await client.query<{ filename: string; applied_at: unknown }>(
    `select filename, applied_at
       from ${LEGACY_LEDGER_TABLE}
      order by applied_at`,
  );
  const timestamps = legacy.rows.map(({ applied_at }) => (
    applied_at instanceof Date
      ? applied_at.getTime()
      : typeof applied_at === "string"
        ? new Date(applied_at).getTime()
        : Number.NaN
  ));
  assertCondition(
    timestamps.every(Number.isFinite),
    `Legacy migration ledger ${LEGACY_LEDGER_TABLE} has invalid applied_at timestamps; manual reconciliation is required`,
  );
  const ambiguous = timestamps.some((timestamp, index) => index > 0 && timestamp === timestamps[index - 1]);
  assertCondition(
    !ambiguous,
    `Legacy migration ledger ${LEGACY_LEDGER_TABLE} has ambiguous applied_at timestamps; manual reconciliation is required`,
  );
  buildMigrationPlan(manifest, appliedRows);
  const compatible = legacy.rows.length === appliedRows.length
    && legacy.rows.every(({ filename }, index) => filename === appliedRows[index]?.filename);
  assertCondition(
    compatible,
    `Legacy migration ledger ${LEGACY_LEDGER_TABLE} is incompatible with migration_control.schema_migrations `
    + `(legacy rows: ${legacy.rows.length}, control rows: ${appliedRows.length})`,
  );
}

export async function readAppliedRows(client: PoolClient): Promise<AppliedMigrationRow[]> {
  const result = await client.query<AppliedMigrationRow>(`
    select migration_id,
           ordinal,
           filename,
           manifest_checksum_sha256,
           applied_checksum_sha256,
           lifecycle_phase,
           operation_categories,
           execution_mode,
           applied_at,
           run_id,
           baselined,
           source_git_sha,
           executor_image_digest
      from migration_control.schema_migrations
     order by ordinal
  `);
  return result.rows;
}

/**
 * The read-only migration plan. Unchanged public surface, unchanged behavior.
 *
 * PB-10 Step 3 Phase 2d, HIGH 1: the schema-lock lifecycle boundary and the
 * migration-client disposer it owns are module-private declarations inside
 * execute.ts, so that no emitted runtime export and no emitted `.d.ts`
 * declaration anywhere in the build hands a production caller the ability to
 * obtain, invoke, replace, retain or wrap them. Both callers that need the
 * boundary therefore live in that one file, and this function is a thin
 * delegation to the one there — a compatibility surface, not a second entry
 * point: it acquires nothing, owns nothing, and adds no capability of its own.
 *
 * Imported lazily for the same reason `main()` below imports the executor
 * lazily: execute.ts depends on this module, so a top-level import would be a
 * load-time cycle.
 */
export async function runMigrationPlan(
  pool: Pool,
  options: SchemaLockOptions & { manifest?: MigrationManifest } = {},
): Promise<MigrationPlan> {
  const { runMigrationPlan: planUnderSchemaLock } = await import("./execute");
  return planUnderSchemaLock(pool, options);
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  assertCondition(
    command === "plan" || command === "execute",
    `Unsupported migration command "${command ?? ""}". PB-10 supports only: plan, execute`,
  );
  assertCondition(arguments_.length === 0 || sameStrings(arguments_, ["--json"]), `Usage: runner.ts ${command} [--json]`);
  assertCondition(process.env.DATABASE_URL, "DATABASE_URL is required");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: `submitsense-migration-${command}`,
    ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: true } : undefined,
    // Execution holds the control and execution connections concurrently; the
    // plan path keeps its original single-connection pool defaults.
    ...(command === "execute" ? { max: 2 } : {}),
  });
  try {
    if (command === "plan") {
      process.stdout.write(renderMigrationPlan(await runMigrationPlan(pool)));
    } else {
      // Imported lazily: execute.ts depends on this module, so a top-level
      // import would be a load-time cycle.
      const { executeMigrations, renderExecutionReport } = await import("./execute");
      process.stdout.write(renderExecutionReport(await executeMigrations(pool)));
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(() => {
    try {
      process.stderr.write(process.argv[2] === "execute" ? "Migration execution failed\n" : "Migration plan failed\n");
    } catch {
      // The command has already failed; never create a raw fallback path.
    }
    process.exitCode = 1;
  });
}
