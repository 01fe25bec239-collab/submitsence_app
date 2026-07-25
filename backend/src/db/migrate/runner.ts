import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import {
  checkManifest,
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

type LockDiagnostic = {
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

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
      "PB-10 Step 2 is read-only; migration execution is not implemented.",
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
    sameStrings(objects.rows.map(({ table_name }) => table_name), ["migration_runs", "schema_migrations"]),
    "migration_control must contain exactly the two Step-2 permanent tables",
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
    config: string[] | null;
    public_execute: boolean;
    runtime_execute: boolean;
  }>(`
    select p.proname as function_name,
           l.lanname as language_name,
           p.provolatile::text as volatility,
           p.prosecdef as security_definer,
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
  const expectedFunctions = [
    ["canonical_operation_categories", "sql", "i"],
    ["reject_ledger_mutation", "plpgsql", "v"],
  ] as const;
  assertCondition(
    functionContract.rows.length === expectedFunctions.length,
    `migration_control must contain exactly ${expectedFunctions.length} control functions`,
  );
  for (const [name, language, volatility] of expectedFunctions) {
    const contract = functionContract.rows.find((row) => row.function_name === name);
    assertCondition(
      contract
      && contract.language_name === language
      && contract.volatility === volatility
      && contract.security_definer === false
      && contract.config?.includes("search_path=pg_catalog, pg_temp")
      && contract.public_execute === false
      && contract.runtime_execute === false,
      `Control function contract is incompatible for migration_control.${name}`,
    );
  }

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

async function inspectLockContention(client: PoolClient): Promise<LockDiagnostic[]> {
  const result = await client.query<LockDiagnostic>(`
    select a.pid as holder_pid,
           nullif(left(a.application_name, 80), '') as application_name,
           left(coalesce(a.client_addr::text, a.client_hostname, 'local'), 80) as client_identity,
           a.state,
           case when a.xact_start is null then null else clock_timestamp() - a.xact_start end as transaction_age,
           case when a.query_start is null then null else clock_timestamp() - a.query_start end as query_age,
           a.wait_event_type,
           case
             when a.backend_type <> 'client backend' then 'non-client backend'
             when a.query ~* '^[[:space:]]*select[[:space:]]+pg_(try_)?advisory_lock' then 'advisory-lock command'
             else 'database command'
           end as command_summary
      from pg_catalog.pg_locks l
      join pg_catalog.pg_stat_activity a on a.pid = l.pid
     where l.locktype = 'advisory'
       and l.classid = $1::oid
       and l.objid = $2::oid
       and l.objsubid = 2
       and l.granted
     order by a.pid
  `, [...SCHEMA_ADVISORY_LOCK]);
  return result.rows;
}

export async function withSchemaAdvisoryLock<T>(
  client: PoolClient,
  action: (lockedClient: PoolClient) => Promise<T>,
  options: SchemaLockOptions = {},
): Promise<T> {
  const pollMs = options.pollMs ?? SCHEMA_LOCK_POLL_MS;
  const budgetMs = options.budgetMs ?? SCHEMA_LOCK_BUDGET_MS;
  assertCondition(Number.isFinite(pollMs) && pollMs > 0, "Schema-lock poll interval must be positive");
  assertCondition(Number.isFinite(budgetMs) && budgetMs >= 0, "Schema-lock budget must be nonnegative");
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds, undefined, { ref: false }));
  const diagnose = options.diagnose ?? ((holders: LockDiagnostic[]) => {
    console.warn(`[migration-plan] schema lock contention: ${JSON.stringify(holders)}`);
  });
  const startedAt = now();
  let acquired = false;
  let connectionError: Error | undefined;
  let rejectConnectionLoss!: (error: Error) => void;
  const connectionLost = new Promise<never>((_resolve, reject) => {
    rejectConnectionLoss = reject;
  });
  const onConnectionError = (error: Error) => {
    connectionError = errorValue(error);
    rejectConnectionLoss(connectionError);
  };
  client.once("error", onConnectionError);

  let value: T | undefined;
  let actionError: Error | undefined;
  let cleanupError: Error | undefined;
  try {
    // Bound every statement on the pinned connection before the first probe, so
    // a plan blocked behind concurrent DDL cannot hold the schema lock forever.
    // ponytail: session-scoped; the CLI pool is single-use and ended straight
    // after the plan. Reset these on release if a shared pool ever runs a plan.
    for (const [setting, milliseconds] of [
      ["statement_timeout", SCHEMA_STATEMENT_TIMEOUT_MS],
      ["lock_timeout", SCHEMA_LOCK_TIMEOUT_MS],
    ] as const) {
      await client.query("select set_config($1, $2, false)", [setting, String(milliseconds)]);
    }

    while (!acquired) {
      if (connectionError) throw connectionError;
      const result = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock($1, $2) as acquired",
        [...SCHEMA_ADVISORY_LOCK],
      );
      acquired = result.rows[0]?.acquired === true;
      if (acquired) break;

      diagnose(await inspectLockContention(client));
      const elapsed = now() - startedAt;
      if (elapsed >= budgetMs) throw new Error(`Schema advisory lock was not acquired within ${budgetMs}ms`);
      await Promise.race([sleep(Math.min(pollMs, budgetMs - elapsed)), connectionLost]);
    }
    value = await Promise.race([action(client), connectionLost]);
  } catch (error) {
    actionError = errorValue(error);
  } finally {
    client.removeListener("error", onConnectionError);
    if (connectionError) {
      client.release(connectionError);
    } else if (acquired) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "select pg_advisory_unlock($1, $2) as unlocked",
          [...SCHEMA_ADVISORY_LOCK],
        );
        assertCondition(result.rows[0]?.unlocked === true, "Schema advisory unlock returned false");
        client.release();
      } catch (error) {
        cleanupError = errorValue(error);
        client.release(cleanupError);
      }
    } else {
      client.release();
    }
  }

  if (actionError && cleanupError) throw new AggregateError([actionError, cleanupError], "Migration plan and lock cleanup failed");
  if (actionError) throw actionError;
  if (cleanupError) throw cleanupError;
  return value as T;
}

/**
 * Read-only probe for the legacy executor's ledger. infra/scripts/migrate.sh
 * records applied migrations in public.infrastructure_schema_migrations, which
 * the control schema knows nothing about. An empty control ledger beside a
 * populated legacy one means the environment was migrated but never baselined,
 * so the applied set is unknown rather than empty. Fail closed: never infer
 * applied state from the legacy rows, and never copy them across.
 */
export async function assertNoLegacyLedgerDivergence(
  client: PoolClient,
  appliedCount: number,
): Promise<void> {
  if (appliedCount > 0) return;
  const present = await client.query<{ present: boolean }>(
    "select pg_catalog.to_regclass($1) is not null as present",
    [LEGACY_LEDGER_TABLE],
  );
  if (present.rows[0]?.present !== true) return;
  const legacy = await client.query<{ legacy_rows: string }>(
    `select count(*)::text as legacy_rows from ${LEGACY_LEDGER_TABLE}`,
  );
  const legacyRows = Number(legacy.rows[0]?.legacy_rows ?? 0);
  assertCondition(
    legacyRows === 0,
    `Legacy migration ledger ${LEGACY_LEDGER_TABLE} has ${legacyRows} row(s) while `
    + "migration_control.schema_migrations is empty; this environment was migrated by "
    + "infra/scripts/migrate.sh and has not been baselined, so the applied set is unknown. "
    + "Baseline adoption is not implemented in PB-10 Step 2.",
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

export async function runMigrationPlan(
  pool: Pool,
  options: SchemaLockOptions & { manifest?: MigrationManifest } = {},
): Promise<MigrationPlan> {
  const manifest = options.manifest ?? await checkManifest();
  const client = await pool.connect();
  return withSchemaAdvisoryLock(client, async (lockedClient) => {
    await verifyControlSchema(lockedClient);
    const rows = await readAppliedRows(lockedClient);
    await assertNoLegacyLedgerDivergence(lockedClient, rows.length);
    return buildMigrationPlan(manifest, rows, options);
  }, options);
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
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
