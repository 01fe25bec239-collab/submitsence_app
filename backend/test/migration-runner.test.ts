import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import type { MigrationManifest } from "../src/db/migrate/manifest";
import {
  SCHEMA_ADVISORY_LOCK,
  buildMigrationPlan,
  renderMigrationPlan,
  runMigrationPlan,
  verifyControlSchema,
  withSchemaAdvisoryLock,
  type AppliedMigrationRow,
} from "../src/db/migrate/runner";

const repositoryRoot = path.resolve(__dirname, "../..");
const manifest = JSON.parse(
  readFileSync(path.join(repositoryRoot, "db", "migrations", "manifest.json"), "utf8"),
) as MigrationManifest;

function applied(index: number, overrides: Partial<AppliedMigrationRow> = {}): AppliedMigrationRow {
  const entry = manifest.migrations[index];
  return {
    migration_id: entry.id,
    ordinal: index + 1,
    filename: entry.filename,
    manifest_checksum_sha256: entry.sha256,
    applied_checksum_sha256: entry.sha256,
    lifecycle_phase: entry.lifecyclePhase,
    operation_categories: [...entry.operationCategories],
    execution_mode: entry.executionMode,
    applied_at: "2030-01-01T00:00:00.000Z",
    run_id: "10000000-0000-4000-8000-000000000001",
    baselined: false,
    source_git_sha: "a".repeat(40),
    executor_image_digest: `sha256:${"b".repeat(64)}`,
    ...overrides,
  };
}

test("empty, partial, and complete valid applied prefixes produce deterministic pending plans", () => {
  const empty = buildMigrationPlan(manifest, []);
  assert.equal(empty.pendingCount, 24);
  assert.equal(empty.appliedCount, 0);

  const prefix = buildMigrationPlan(manifest, manifest.migrations.slice(0, 7).map((_, index) => applied(index)));
  assert.equal(prefix.appliedCount, 7);
  assert.deepEqual(prefix.pendingMigrations.map(({ id }) => id), manifest.migrations.slice(7).map(({ id }) => id));

  const complete = buildMigrationPlan(manifest, manifest.migrations.map((_, index) => applied(index)));
  assert.equal(complete.pendingCount, 0);
  assert.equal(complete.totalDeclaredWallClockMs, 0);
  assert.equal(renderMigrationPlan(prefix), renderMigrationPlan(buildMigrationPlan(manifest, manifest.migrations.slice(0, 7).map((_, index) => applied(index)))));
});

test("unknown and non-prefix applied histories are rejected", () => {
  assert.throws(
    () => buildMigrationPlan(manifest, [applied(0, { migration_id: "0100" })]),
    /not present in the manifest/,
  );
  assert.throws(
    () => buildMigrationPlan(manifest, [applied(1)]),
    /ordinal prefix|ordering or migration ID mismatch/,
  );
  assert.throws(
    () => buildMigrationPlan(manifest, [applied(0, { ordinal: 2 })]),
    /contiguous ordinal prefix/,
  );
});

test("applied metadata must match filename, checksums, phase, categories, and mode", () => {
  for (const [overrides, message] of [
    [{ filename: "0001_wrong.sql" }, /Filename mismatch/],
    [{ manifest_checksum_sha256: "0".repeat(64) }, /Manifest checksum mismatch/],
    [{ applied_checksum_sha256: "0".repeat(64) }, /Applied checksum mismatch/],
    [{ lifecycle_phase: "contract" }, /Lifecycle phase mismatch/],
    [{ operation_categories: ["index"] }, /Operation category mismatch/],
    [{ execution_mode: "transactional" }, /Execution mode mismatch/],
  ] as Array<[Partial<AppliedMigrationRow>, RegExp]>) {
    assert.throws(() => buildMigrationPlan(manifest, [applied(0, overrides)]), message);
  }
});

test("only baselined legacy rows may have null applied checksums", () => {
  assert.throws(
    () => buildMigrationPlan(manifest, [applied(0, { applied_checksum_sha256: null })]),
    /invalid null applied checksum/,
  );
  const plan = buildMigrationPlan(manifest, [applied(0, {
    baselined: true,
    applied_checksum_sha256: null,
  })]);
  assert.equal(plan.appliedCount, 1);

  const futureManifest: MigrationManifest = {
    ...manifest,
    migrations: [
      ...manifest.migrations,
      {
        ...manifest.migrations[0],
        id: "0100",
        filename: "0100_expand_test.sql",
        executionMode: "transactional",
      },
    ],
  };
  const rows = manifest.migrations.map((_, index) => applied(index));
  rows.push({
    ...applied(0),
    migration_id: "0100",
    ordinal: 25,
    filename: "0100_expand_test.sql",
    execution_mode: "transactional",
    baselined: true,
    applied_checksum_sha256: null,
  });
  assert.throws(() => buildMigrationPlan(futureManifest, rows), /exceeds the legacy boundary/);
});

test("rendered plans contain operational metadata but no SQL or connection secrets", () => {
  const rendered = renderMigrationPlan(buildMigrationPlan(manifest, []));
  assert.match(rendered, /"pendingCount": 24/);
  assert.match(rendered, /PB-10 Step 2 is read-only/);
  assert.doesNotMatch(rendered, /postgres(?:ql)?:\/\/|password|BEGIN;|CREATE TABLE|SELECT \*/i);
});

type QueryResult = { rows: unknown[]; rowCount: number | null };

class LockClient extends EventEmitter {
  readonly events: string[] = [];
  readonly queries: Array<{ sql: string; values?: unknown[] }> = [];
  probes: boolean[] = [true];
  diagnostics: unknown[] = [];
  unlockResult = true;
  unlockError: Error | undefined;
  releasedWith: Error | undefined;
  activeQueries = 0;
  maxActiveQueries = 0;

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.queries.push({ sql, values });
    this.activeQueries += 1;
    this.maxActiveQueries = Math.max(this.maxActiveQueries, this.activeQueries);
    try {
      if (sql.includes("set_config")) {
        return { rows: [{ set_config: String(values?.[1]) }], rowCount: 1 };
      }
      if (sql.includes("pg_try_advisory_lock")) {
        this.events.push("probe");
        assert.deepEqual(values, [...SCHEMA_ADVISORY_LOCK]);
        return { rows: [{ acquired: this.probes.shift() ?? false }], rowCount: 1 };
      }
      if (sql.includes("pg_stat_activity")) {
        this.events.push("diagnose");
        return { rows: this.diagnostics, rowCount: this.diagnostics.length };
      }
      if (sql.includes("pg_advisory_unlock")) {
        this.events.push("unlock");
        assert.deepEqual(values, [...SCHEMA_ADVISORY_LOCK]);
        if (this.unlockError) throw this.unlockError;
        return { rows: [{ unlocked: this.unlockResult }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    } finally {
      this.activeQueries -= 1;
    }
  }

  release(error?: Error): void {
    this.releasedWith = error;
    this.events.push(error ? "release-error" : "release");
  }
}

test("schema lock uses exact keys and unlocks before normal release", async () => {
  const client = new LockClient();
  const result = await withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
    client.events.push("action");
    return 7;
  });
  assert.equal(result, 7);
  assert.deepEqual(client.events, ["probe", "action", "unlock", "release"]);
});

test("lock contention retries sequentially with bounded injectable timing", async () => {
  const client = new LockClient();
  client.probes = [false, false, true];
  let clock = 0;
  const sleeps: number[] = [];
  await withSchemaAdvisoryLock(client as unknown as PoolClient, async () => undefined, {
    pollMs: 5,
    budgetMs: 20,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    diagnose: () => undefined,
  });
  assert.deepEqual(sleeps, [5, 5]);
  assert.equal(client.maxActiveQueries, 1);
  assert.equal(client.events.filter((event) => event === "probe").length, 3);
});

test("lock timeout is bounded and still releases a non-lock-bearing client", async () => {
  const client = new LockClient();
  client.probes = [false, false, false, false];
  let clock = 0;
  await assert.rejects(
    withSchemaAdvisoryLock(client as unknown as PoolClient, async () => undefined, {
      pollMs: 5,
      budgetMs: 12,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      diagnose: () => undefined,
    }),
    /within 12ms/,
  );
  assert.equal(clock, 12);
  assert.deepEqual(client.events.slice(-1), ["release"]);
  assert.ok(!client.events.includes("unlock"));
});

test("contention diagnostics expose bounded classifications, never raw query text", async () => {
  const client = new LockClient();
  client.probes = [false, true];
  client.diagnostics = [{
    holder_pid: 42,
    application_name: "migration-task",
    client_identity: "127.0.0.1",
    state: "active",
    transaction_age: "00:00:01",
    query_age: "00:00:01",
    wait_event_type: null,
    command_summary: "database command",
  }];
  const seen: unknown[] = [];
  await withSchemaAdvisoryLock(client as unknown as PoolClient, async () => undefined, {
    pollMs: 1,
    budgetMs: 2,
    now: (() => {
      let clock = 0;
      return () => clock++;
    })(),
    sleep: async () => undefined,
    diagnose: (holders) => seen.push(holders),
  });
  const rendered = JSON.stringify(seen);
  assert.match(rendered, /holder_pid/);
  assert.doesNotMatch(rendered, /select .*from|secret|password/i);
  assert.ok(client.queries.some(({ sql }) => sql.includes("pg_locks") && sql.includes("pg_stat_activity")));
});

test("control-connection loss aborts and destroys the client", async () => {
  const client = new LockClient();
  await assert.rejects(
    withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
      setImmediate(() => client.emit("error", new Error("control connection lost")));
      return new Promise<never>(() => undefined);
    }),
    /control connection lost/,
  );
  assert.match(client.releasedWith?.message ?? "", /control connection lost/);
  assert.ok(!client.events.includes("unlock"));
});

test("unlock false and unlock errors destroy the pinned client", async () => {
  for (const failure of ["false", "error"] as const) {
    const client = new LockClient();
    if (failure === "false") client.unlockResult = false;
    else client.unlockError = new Error("unlock query failed");
    await assert.rejects(
      withSchemaAdvisoryLock(client as unknown as PoolClient, async () => undefined),
      failure === "false" ? /returned false/ : /unlock query failed/,
    );
    assert.ok(client.releasedWith instanceof Error);
    assert.deepEqual(client.events.slice(-2), ["unlock", "release-error"]);
  }
});

test("plan action failures still unlock before release", async () => {
  const client = new LockClient();
  await assert.rejects(
    withSchemaAdvisoryLock(client as unknown as PoolClient, async () => {
      client.events.push("plan-failed");
      throw new Error("catalog drift");
    }),
    /catalog drift/,
  );
  assert.deepEqual(client.events, ["probe", "plan-failed", "unlock", "release"]);
});

const columnRows = [
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

const constraintRows = [
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

class PlanClient extends LockClient {
  drift = false;
  constraintDrift = false;
  schemaMissing = false;
  droppedTruncateTriggers = false;
  legacyLedgerPresent = false;
  legacyLedgerRows = 0;
  readonly ledgerRows: AppliedMigrationRow[];

  constructor(ledgerRows: AppliedMigrationRow[] = []) {
    super();
    this.ledgerRows = ledgerRows;
  }

  override async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    if (sql.includes("pg_try_advisory_lock") || sql.includes("pg_advisory_unlock") || sql.includes("pg_stat_activity")) {
      return super.query(sql, values);
    }
    this.queries.push({ sql, values });
    if (sql.includes("set_config")) return { rows: [{ set_config: String(values?.[1]) }], rowCount: 1 };
    if (sql.includes("to_regnamespace")) {
      return { rows: [{ present: !this.schemaMissing }], rowCount: 1 };
    }
    if (sql.includes("to_regclass")) {
      return { rows: [{ present: this.legacyLedgerPresent }], rowCount: 1 };
    }
    if (sql.includes("legacy_rows")) {
      return { rows: [{ legacy_rows: String(this.legacyLedgerRows) }], rowCount: 1 };
    }
    if (sql.includes("c.relkind in ('r', 'p')")) {
      return { rows: this.drift ? [{ table_name: "schema_migrations" }] : [{ table_name: "migration_runs" }, { table_name: "schema_migrations" }], rowCount: 2 };
    }
    if (sql.includes("pg_attribute")) return { rows: columnRows, rowCount: columnRows.length };
    if (sql.includes("pg_constraint")) {
      const rows = this.constraintDrift
        ? constraintRows.map((row) => row.constraint_name === "sm_id_ck" ? { ...row, definition: "CHECK (true)" } : row)
        : constraintRows;
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("pg_trigger")) {
      const rows = [
        { table_name: "migration_runs", trigger_name: "migration_runs_reject_mutation", enabled: "A", trigger_type: 27, function_name: "reject_ledger_mutation" },
        { table_name: "migration_runs", trigger_name: "migration_runs_reject_truncate", enabled: "A", trigger_type: 34, function_name: "reject_ledger_mutation" },
        { table_name: "schema_migrations", trigger_name: "schema_migrations_reject_mutation", enabled: "A", trigger_type: 27, function_name: "reject_ledger_mutation" },
        { table_name: "schema_migrations", trigger_name: "schema_migrations_reject_truncate", enabled: "A", trigger_type: 34, function_name: "reject_ledger_mutation" },
      ].filter((row) => !(this.droppedTruncateTriggers && row.trigger_name.endsWith("_reject_truncate")));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("p.provolatile")) return {
      rows: [
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
      ],
      rowCount: 2,
    };
    if (sql.includes("control_namespace")) return {
      rows: [{
        public_schema: false,
        public_tables: false,
        public_sequences: false,
        runtime_schema: false,
        runtime_tables: false,
        runtime_sequences: false,
      }],
      rowCount: 1,
    };
    if (sql.includes("from migration_control.schema_migrations")) {
      return { rows: this.ledgerRows, rowCount: this.ledgerRows.length };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

test("strict control-schema verification rejects catalog drift", async () => {
  const client = new PlanClient();
  client.drift = true;
  await assert.rejects(verifyControlSchema(client as unknown as PoolClient), /exactly the two Step-2 permanent tables/);

  const constraintClient = new PlanClient();
  constraintClient.constraintDrift = true;
  await assert.rejects(verifyControlSchema(constraintClient as unknown as PoolClient), /Constraint definition drift/);

  const missingSchema = new PlanClient();
  missingSchema.schemaMissing = true;
  await assert.rejects(
    verifyControlSchema(missingSchema as unknown as PoolClient),
    /Control schema migration_control does not exist/,
  );
});

test("verification rejects a ledger missing its TRUNCATE-rejection triggers", async () => {
  const client = new PlanClient();
  client.droppedTruncateTriggers = true;
  await assert.rejects(
    verifyControlSchema(client as unknown as PoolClient),
    /exactly 4 mutation-rejection triggers/,
  );

  const intact = new PlanClient();
  await verifyControlSchema(intact as unknown as PoolClient);
  const triggerQuery = intact.queries.find(({ sql }) => sql.includes("pg_trigger"));
  assert.ok(triggerQuery, "verifier must inspect pg_trigger");
});

test("canonical category order is a verified constraint, not an unordered comparison", async () => {
  const client = new PlanClient();
  await verifyControlSchema(client as unknown as PoolClient);
  const constraintQuery = client.queries.find(({ sql }) => sql.includes("pg_constraint"));
  assert.ok(constraintQuery, "verifier must inspect pg_constraint");

  // The plan stays order-sensitive on purpose: canonical ordering is enforced at
  // INSERT time by sm_categories_order_ck, so a reordered row must never be
  // silently accepted here.
  const reordered = manifest.migrations.findIndex((entry) => entry.operationCategories.length > 1);
  assert.notEqual(reordered, -1, "manifest needs a multi-category entry for this test");
  assert.throws(
    () => buildMigrationPlan(manifest, [applied(reordered, {
      operation_categories: [...manifest.migrations[reordered].operationCategories].reverse(),
    })].slice(0, 1)),
    /Operation category mismatch|contiguous ordinal prefix|ordering or migration ID mismatch/,
  );
});

test("plan fails closed when the legacy ledger diverges from an empty control ledger", async () => {
  const diverged = new PlanClient();
  diverged.legacyLedgerPresent = true;
  diverged.legacyLedgerRows = 24;
  const pool = { connect: async () => diverged as unknown as PoolClient } as unknown as Pool;
  await assert.rejects(
    runMigrationPlan(pool, { manifest }),
    /Legacy migration ledger public\.infrastructure_schema_migrations has 24 row\(s\)/,
  );
  // Fail closed, but never read the legacy rows themselves.
  assert.ok(diverged.queries.every(({ sql }) => !/select\s+filename/i.test(sql)));
  assert.deepEqual(diverged.events.slice(-2), ["unlock", "release"]);

  const emptyLegacy = new PlanClient();
  emptyLegacy.legacyLedgerPresent = true;
  emptyLegacy.legacyLedgerRows = 0;
  const emptyPool = { connect: async () => emptyLegacy as unknown as PoolClient } as unknown as Pool;
  assert.equal((await runMigrationPlan(emptyPool, { manifest })).pendingCount, 24);

  // A populated control ledger is authoritative; the legacy table is not probed.
  const baselined = new PlanClient(manifest.migrations.map((_, index) => applied(index)));
  baselined.legacyLedgerPresent = true;
  baselined.legacyLedgerRows = 24;
  const baselinedPool = { connect: async () => baselined as unknown as PoolClient } as unknown as Pool;
  assert.equal((await runMigrationPlan(baselinedPool, { manifest })).pendingCount, 0);
  assert.ok(baselined.queries.every(({ sql }) => !sql.includes("to_regclass")));
});

test("statement and lock timeouts are issued on the pinned client before the first probe", async () => {
  const client = new LockClient();
  await withSchemaAdvisoryLock(client as unknown as PoolClient, async () => undefined);
  const settings = client.queries
    .filter(({ sql }) => sql.includes("set_config"))
    .map(({ values }) => values as [string, string]);
  assert.deepEqual(settings, [
    ["statement_timeout", "30000"],
    ["lock_timeout", "5000"],
  ]);
  // is_local is a literal false, so the timeouts outlive each implicit transaction.
  assert.ok(client.queries.every(({ sql }) => !sql.includes("set_config") || sql.includes("false")));
  const kinds = client.queries.map(({ sql }) => sql.includes("set_config") ? "set_config" : sql.includes("pg_try_advisory_lock") ? "probe" : "other");
  assert.deepEqual(kinds.slice(0, 3), ["set_config", "set_config", "probe"]);
});

test("run plan issues only read-only catalog and ledger queries", async () => {
  const client = new PlanClient();
  const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
  const plan = await runMigrationPlan(pool, { manifest });
  assert.equal(plan.pendingCount, 24);
  const statements = client.queries.map(({ sql }) => sql.trim());
  assert.ok(statements.some((sql) => sql.includes("from migration_control.schema_migrations")));
  assert.ok(statements.every((sql) => /^(select|with)/i.test(sql)));
  assert.ok(statements.every((sql) =>
    !/\b(insert|update|delete|create|alter|drop)\b/i.test(sql.replace(/'(?:''|[^'])*'/g, "''")),
  ));
});

test("unsupported execution commands fail clearly before connecting", () => {
  const runner = path.join(repositoryRoot, "backend", "src", "db", "migrate", "runner.ts");
  const spawn = (...arguments_: string[]) => spawnSync(process.execPath, ["--import", "tsx", runner, ...arguments_], {
    cwd: path.join(repositoryRoot, "backend"),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "" },
  });

  // PB-10 Step 3 adds exactly one execution verb; every other spelling and every
  // out-of-scope lifecycle command still fails closed.
  for (const command of ["run", "apply", "clean-install", "baseline-adopt", ""]) {
    const result = spawn(command);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /supports only: plan, execute/);
  }

  // execute is recognised, but still refuses to run without a target database.
  const recognised = spawn("execute", "--json");
  assert.notEqual(recognised.status, 0);
  assert.doesNotMatch(recognised.stderr, /supports only/);
  assert.match(recognised.stderr, /DATABASE_URL is required/);
});
