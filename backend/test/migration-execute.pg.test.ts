import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { Client, Pool } from "pg";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import { executeMigrations } from "../src/db/migrate/execute";
import { assertDistinctDatabases } from "../src/db/migrate/database-identity";
import { SCHEMA_ADVISORY_LOCK } from "../src/db/migrate/runner";
import { executeMigrationsForTest } from "./helpers/migration-execute";

/**
 * Real-PostgreSQL contract for PB-10 Step 3. Registered only when a disposable
 * target is supplied, so the default suite keeps exactly the two documented
 * integration skips instead of gaining more.
 *
 *   MIGRATION_TEST_DATABASE_URL=postgres://... node --import tsx --test test/migration-execute.pg.test.ts
 *
 * Every case drops and reinstalls migration_control, so the target must be
 * disposable.
 */
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required for the destructive PB-10 PostgreSQL suite in CI");
}

if (!databaseUrl) {
  test("pg: destructive migration suite requires a dedicated disposable database", {
    skip: "MIGRATION_TEST_DATABASE_URL is not set; refusing to drop schemas in a shared or unidentified database",
  }, () => undefined);
} else {
  const repositoryRoot = path.resolve(__dirname, "../..");
  const controlSchemaSql = readFileSync(path.join(repositoryRoot, "db", "control", "control-schema.sql"), "utf8");

  const identity = {
    sourceGitSha: "5324116250977b5e8ac24bc83b6cae89ebcbd990",
    executorImageDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    runnerId: "pb10-pg-contract",
  };
  const timeouts = { lockMs: 5_000, statementMs: 60_000, transactionMs: 300_000, idleInTransactionMs: 60_000, wallClockMs: 900_000 };
  const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

  const root = mkdtempSync(path.join(os.tmpdir(), "pb10-execute-pg-"));
  mkdirSync(path.join(root, "db", "migrations"), { recursive: true });

  const files: Record<string, Buffer> = {
    "0001_legacy_contract.sql": Buffer.from(
      "begin;\r\ncreate table demo (id integer primary key, label text);\r\ninsert into demo values (1, 'a'), (2, 'a');\r\ncommit;\n",
      "utf8",
    ),
    "0100_transactional_contract.sql": Buffer.from("alter table demo add column note text;\n", "utf8"),
    "0101_concurrent_index_contract.sql": Buffer.from(
      "create index concurrently demo_label_idx on demo (label);\n",
      "utf8",
    ),
  };
  for (const [filename, bytes] of Object.entries(files)) {
    writeFileSync(path.join(root, "db", "migrations", filename), bytes);
  }
  after(() => rmSync(root, { recursive: true, force: true }));

  const entry = (
    id: string,
    filename: string,
    executionMode: MigrationManifestEntry["executionMode"],
    operationCategories: MigrationManifestEntry["operationCategories"],
  ): MigrationManifestEntry => ({
    id,
    filename,
    sha256: sha256(files[filename]),
    lifecyclePhase: "expand",
    operationCategories,
    executionMode,
    requiredRuntimeEpoch: null,
    timeouts,
  });

  const legacy = entry("0001", "0001_legacy_contract.sql", "legacy-verbatim", ["schema"]);
  const transactional = entry("0100", "0100_transactional_contract.sql", "transactional", ["schema"]);
  const concurrentIndex = entry("0101", "0101_concurrent_index_contract.sql", "nontransactional", ["index"]);

  const manifestOf = (...migrations: MigrationManifestEntry[]): MigrationManifest => ({
    schemaVersion: 1,
    legacyBoundary: "0099",
    migrations,
  });

  let admin: Client;
  const pools: Pool[] = [];

  const newPool = (): Pool => {
    const pool = new Pool({ connectionString: databaseUrl, max: 3, application_name: "pb10-step3-contract" });
    pools.push(pool);
    return pool;
  };

  const execute = (pool: Pool, manifest: MigrationManifest) =>
    executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: root });

  const count = async (relation: string): Promise<number> => {
    const result = await admin.query<{ total: string }>(`select count(*)::text as total from ${relation}`);
    return Number(result.rows[0].total);
  };

  const assertFreshDatabase = async (): Promise<void> => {
    const result = await admin.query<{
      app_absent: boolean;
      public_relations: string;
      public_routines: string;
      public_types: string;
      public_policies: string;
      public_extensions: string;
      applied_rows: string;
      event_rows: string;
    }>(`
      select pg_catalog.to_regnamespace('app') is null as app_absent,
             (select count(*) from pg_catalog.pg_class c
                join pg_catalog.pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public')::text as public_relations,
             (select count(*) from pg_catalog.pg_proc p
                join pg_catalog.pg_namespace n on n.oid = p.pronamespace
               where n.nspname in ('public', 'app'))::text as public_routines,
             (select count(*) from pg_catalog.pg_type t
                join pg_catalog.pg_namespace n on n.oid = t.typnamespace
               where n.nspname in ('public', 'app'))::text as public_types,
             (select count(*) from pg_catalog.pg_policy p
                join pg_catalog.pg_class c on c.oid = p.polrelid
                join pg_catalog.pg_namespace n on n.oid = c.relnamespace
               where n.nspname in ('public', 'app'))::text as public_policies,
             (select count(*) from pg_catalog.pg_extension e
                join pg_catalog.pg_namespace n on n.oid = e.extnamespace
               where n.nspname in ('public', 'app'))::text as public_extensions,
             (select count(*) from migration_control.schema_migrations)::text as applied_rows,
             (select count(*) from migration_control.migration_runs)::text as event_rows
    `);
    assert.deepEqual(result.rows[0], {
      app_absent: true,
      public_relations: "0",
      public_routines: "0",
      public_types: "0",
      public_policies: "0",
      public_extensions: "0",
      applied_rows: "0",
      event_rows: "0",
    });
  };

  const resetDatabase = async (): Promise<void> => {
    await admin.query("drop schema if exists migration_control cascade");
    await admin.query("drop schema if exists app cascade");
    await admin.query("drop schema if exists public cascade");
    await admin.query("create schema public");
    await admin.query(controlSchemaSql);
  };

  const createLegacyLedger = async (
    filenames: string[],
    timestamps: Date[] = filenames.map((_, index) => new Date(Date.UTC(2030, 0, index + 1))),
  ): Promise<void> => {
    await admin.query(`
      create table public.infrastructure_schema_migrations (
        filename text not null,
        applied_at timestamptz not null
      )
    `);
    for (const [index, filename] of filenames.entries()) {
      await admin.query(
        "insert into public.infrastructure_schema_migrations(filename, applied_at) values ($1, $2)",
        [filename, timestamps[index]],
      );
    }
  };

  const insertControlRow = async (
    migration: MigrationManifestEntry,
    ordinal: number,
    overrides: { id?: string; filename?: string; manifestChecksum?: string } = {},
  ): Promise<void> => {
    await admin.query(
      `insert into migration_control.schema_migrations
         (migration_id, ordinal, filename, manifest_checksum_sha256, applied_checksum_sha256,
          lifecycle_phase, operation_categories, execution_mode, applied_at, run_id,
          baselined, source_git_sha, executor_image_digest)
       values ($1, $2, $3, $4, $4, $5, $6, $7, now(), $8, false, $9, $10)`,
      [
        overrides.id ?? migration.id,
        ordinal,
        overrides.filename ?? migration.filename,
        overrides.manifestChecksum ?? migration.sha256,
        migration.lifecyclePhase,
        migration.operationCategories,
        migration.executionMode,
        `20000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
        identity.sourceGitSha,
        identity.executorImageDigest,
      ],
    );
  };

  const insertAttemptEvents = async (
    migrationId: string,
    runId: string,
    events: Array<{
      type: string;
      errorClass?: string;
      statementOrdinal?: number | null;
      metadata?: Record<string, unknown>;
      sqlstate?: string | null;
    }>,
  ): Promise<void> => {
    for (const [index, event] of events.entries()) {
      const failed = event.type === "transaction_rolled_back" || event.type === "execution_failed";
      await admin.query(
         `insert into migration_control.migration_runs
           (run_id, migration_id, event_sequence, event_type, source_git_sha,
            executor_image_digest, error_class, heartbeat_deadline, metadata, statement_ordinal, sqlstate)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
        [
          runId,
          migrationId,
          index + 1,
          event.type,
          identity.sourceGitSha,
          identity.executorImageDigest,
          event.errorClass ?? (failed ? "sql_failed" : null),
          event.type === "started" ? new Date(Date.now() + 60_000) : null,
          JSON.stringify(event.metadata ?? {
            execution_mode: "legacy-verbatim",
            migration_filename: legacy.filename,
            migration_ordinal: 1,
          }),
          event.statementOrdinal === undefined ? (failed ? 1 : null) : event.statementOrdinal,
          event.sqlstate === undefined ? (failed ? "23505" : null) : event.sqlstate,
        ],
      );
    }
  };

  const assertBlockedWithoutWrites = async (
    pool: Pool,
    candidate: MigrationManifest,
    pattern: RegExp,
  ): Promise<void> => {
    const appliedBefore = await count("migration_control.schema_migrations");
    const eventsBefore = await count("migration_control.migration_runs");
    await assert.rejects(execute(pool, candidate), pattern);
    assert.equal(await count("migration_control.schema_migrations"), appliedBefore);
    assert.equal(await count("migration_control.migration_runs"), eventsBefore);
  };

  before(async () => {
    // Must run before any connection is opened or any query issued: this
    // suite drops and recreates schemas every test, so if
    // MIGRATION_TEST_DATABASE_URL and TEST_DATABASE_URL happen to name the
    // same physical database, that destructive reset must never execute.
    await assertDistinctDatabases(
      { a: databaseUrl, b: process.env.TEST_DATABASE_URL },
      { a: "MIGRATION_TEST_DATABASE_URL", b: "TEST_DATABASE_URL" },
    );
    admin = new Client({ connectionString: databaseUrl, application_name: "pb10-step3-admin" });
    await admin.connect();
  });

  after(async () => {
    // admin is only assigned once assertDistinctDatabases in before() has
    // resolved without throwing. When it rejects (the two credentials name
    // the same physical database), before() never reaches that assignment,
    // so there is nothing to clean up here — and nothing was ever connected
    // to, so there is no leaked connection either. The rejection itself
    // still fails every test in the suite loudly (node:test reports a
    // before-hook failure for each), so this guard only removes a spurious
    // secondary TypeError; it does not suppress or soften the original
    // safety failure.
    if (admin === undefined) return;
    await Promise.all(pools.map((pool) => pool.end()));
    await resetDatabase();
    await admin.end();
  });

  beforeEach(async () => {
    await resetDatabase();
    await assertFreshDatabase();
  });

  test("pg: reset removes every application-schema object class", async () => {
    await admin.query("create schema app");
    await admin.query("create type public.cleanup_probe_type as enum ('ready')");
    await admin.query("create table public.cleanup_probe (id integer primary key)");
    await admin.query("alter table public.cleanup_probe enable row level security");
    await admin.query("create policy cleanup_probe_policy on public.cleanup_probe using (true)");
    await admin.query("create sequence public.cleanup_probe_sequence");
    await admin.query("create view public.cleanup_probe_view as select id from public.cleanup_probe");
    await admin.query("create function app.cleanup_probe_function() returns integer language sql as 'select 1'");
    await admin.query("create procedure app.cleanup_probe_procedure() language sql as 'select 1'");
    await admin.query("create extension pg_trgm with schema public");

    await resetDatabase();
    await assertFreshDatabase();
  });

  test("pg: source and compiled production APIs use canonical manifest, root, and environment identity", async () => {
    const buildRoot = mkdtempSync(path.join(os.tmpdir(), "pb10-pg-production-"));
    const previous = {
      source: process.env.MIGRATION_SOURCE_GIT_SHA,
      digest: process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST,
      runner: process.env.MIGRATION_RUNNER_ID,
    };
    process.env.MIGRATION_SOURCE_GIT_SHA = identity.sourceGitSha;
    process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = identity.executorImageDigest;
    process.env.MIGRATION_RUNNER_ID = identity.runnerId;

    try {
      await resetDatabase();

      const rejectedPool = newPool();
      await assert.rejects(
        executeMigrations(rejectedPool, { manifest: manifestOf(legacy) } as never),
        /exactly one Pool argument/,
      );
      assert.equal(rejectedPool.totalCount, 0, "alternate input must be rejected before pool.connect()");

      const sourcePool = newPool();
      const committed = JSON.parse(
        readFileSync(path.join(repositoryRoot, "db", "migrations", "manifest.json"), "utf8"),
      ) as MigrationManifest;
      const report = await executeMigrations(sourcePool);
      assert.equal(report.executedCount, committed.migrations.length);
      assert.deepEqual(report.executed.map(({ filename }) => filename), committed.migrations.map(({ filename }) => filename));
      assert.equal(await count("migration_control.schema_migrations"), committed.migrations.length);

      const applied = await admin.query<{
        source_git_sha: string;
        executor_image_digest: string;
      }>("select source_git_sha, executor_image_digest from migration_control.schema_migrations");
      assert.ok(applied.rows.every((row) =>
        row.source_git_sha === identity.sourceGitSha
        && row.executor_image_digest === identity.executorImageDigest));

      const eventsBefore = await count("migration_control.migration_runs");
      const sourceRerun = await executeMigrations(sourcePool);
      assert.equal(sourceRerun.outcome, "no-op");
      assert.equal(await count("migration_control.migration_runs"), eventsBefore);

      cpSync(path.join(repositoryRoot, ".gitattributes"), path.join(buildRoot, ".gitattributes"));
      cpSync(path.join(repositoryRoot, "db"), path.join(buildRoot, "db"), { recursive: true });
      mkdirSync(path.join(buildRoot, "backend"), { recursive: true });
      symlinkSync(path.join(repositoryRoot, "backend", "node_modules"), path.join(buildRoot, "backend", "node_modules"));
      const compiler = path.join(repositoryRoot, "backend", "node_modules", "typescript", "bin", "tsc");
      const built = spawnSync(process.execPath, [
        compiler,
        "--project", path.join(repositoryRoot, "backend", "tsconfig.json"),
        "--outDir", path.join(buildRoot, "backend", "dist"),
      ], { encoding: "utf8" });
      assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
      const compiled = require(path.join(buildRoot, "backend", "dist", "db", "migrate", "execute.js")) as {
        executeMigrations(target: Pool): ReturnType<typeof executeMigrations>;
      };
      const compiledReport = await compiled.executeMigrations(sourcePool);
      assert.equal(compiledReport.outcome, "no-op");
      assert.equal(compiledReport.pendingBefore, sourceRerun.pendingBefore);
      assert.equal(await count("migration_control.migration_runs"), eventsBefore);
    } finally {
      if (previous.source === undefined) delete process.env.MIGRATION_SOURCE_GIT_SHA;
      else process.env.MIGRATION_SOURCE_GIT_SHA = previous.source;
      if (previous.digest === undefined) delete process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST;
      else process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = previous.digest;
      if (previous.runner === undefined) delete process.env.MIGRATION_RUNNER_ID;
      else process.env.MIGRATION_RUNNER_ID = previous.runner;
      rmSync(buildRoot, { recursive: true, force: true });
      await resetDatabase();
    }
  });

  test("pg: transactional migration commits its SQL and applied row together", async () => {
    const pool = newPool();
    const report = await execute(pool, manifestOf(legacy, transactional));

    assert.deepEqual(report.executed.map(({ id }) => id), ["0001", "0100"]);
    assert.equal(await count("migration_control.schema_migrations"), 2);

    const column = await admin.query(
      "select 1 from information_schema.columns where table_name = 'demo' and column_name = 'note'",
    );
    assert.equal(column.rowCount, 1, "the transactional migration's DDL is committed");

    const rows = await admin.query<{ migration_id: string; ordinal: number; execution_mode: string; baselined: boolean }>(
      "select migration_id, ordinal, execution_mode, baselined from migration_control.schema_migrations order by ordinal",
    );
    assert.deepEqual(rows.rows.map(({ ordinal }) => ordinal), [1, 2]);
    assert.deepEqual(rows.rows.map(({ execution_mode }) => execution_mode), ["legacy-verbatim", "transactional"]);
    assert.ok(rows.rows.every(({ baselined }) => baselined === false));
  });

  test("pg: the recorded applied checksum is exactly the executed file's bytes", async () => {
    const pool = newPool();
    await execute(pool, manifestOf(legacy));
    const row = await admin.query<{ applied_checksum_sha256: string; manifest_checksum_sha256: string }>(
      "select applied_checksum_sha256, manifest_checksum_sha256 from migration_control.schema_migrations where migration_id = '0001'",
    );
    assert.equal(row.rows[0].applied_checksum_sha256.trim(), sha256(files["0001_legacy_contract.sql"]));
    assert.equal(row.rows[0].manifest_checksum_sha256.trim(), sha256(files["0001_legacy_contract.sql"]));
  });

  test("pg: equal control and legacy ledgers are compatible", async () => {
    const pool = newPool();
    await execute(pool, manifestOf(legacy, transactional));
    await createLegacyLedger([legacy.filename, transactional.filename]);
    const report = await execute(pool, manifestOf(legacy, transactional));
    assert.equal(report.outcome, "no-op");
  });

  test("pg: tied legacy timestamps fail before migration or ledger writes", async () => {
    const tied = new Date("2030-01-01T00:00:00.000Z");
    for (const candidate of [
      [legacy.filename, transactional.filename],
      [transactional.filename, legacy.filename],
      [legacy.filename, transactional.filename, concurrentIndex.filename],
    ]) {
      await createLegacyLedger(candidate, candidate.map(() => tied));
      const pool = newPool();
      await assert.rejects(
        execute(pool, manifestOf(legacy, transactional, concurrentIndex)),
        /ambiguous applied_at timestamps; manual reconciliation is required/,
      );
      assert.equal(await count("migration_control.schema_migrations"), 0);
      assert.equal(await count("migration_control.migration_runs"), 0);
      await admin.query("drop table public.infrastructure_schema_migrations");
    }
  });

  test("pg: a partial control prefix plus longer legacy ledger is blocked before writes", async () => {
    const pool = newPool();
    await execute(pool, manifestOf(legacy));
    await createLegacyLedger([legacy.filename, transactional.filename]);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy, transactional), /legacy rows: 2, control rows: 1/);
    const column = await admin.query(
      "select 1 from information_schema.columns where table_name = 'demo' and column_name = 'note'",
    );
    assert.equal(column.rowCount, 0);
  });

  test("pg: a longer control ledger plus shorter legacy ledger is blocked before writes", async () => {
    const pool = newPool();
    await execute(pool, manifestOf(legacy, transactional));
    await createLegacyLedger([legacy.filename]);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy, transactional), /legacy rows: 1, control rows: 2/);
  });

  test("pg: an empty control ledger plus populated legacy ledger is blocked before writes", async () => {
    const pool = newPool();
    await createLegacyLedger([legacy.filename]);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy), /legacy rows: 1, control rows: 0/);
  });

  test("pg: legacy compatibility rejects checksum drift", async () => {
    const pool = newPool();
    await insertControlRow(legacy, 1, { manifestChecksum: "0".repeat(64) });
    await createLegacyLedger([legacy.filename]);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy), /Manifest checksum mismatch/);
  });

  test("pg: legacy compatibility rejects order drift", async () => {
    const pool = newPool();
    await insertControlRow(legacy, 1);
    await insertControlRow(transactional, 2);
    await createLegacyLedger([transactional.filename, legacy.filename]);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy, transactional), /incompatible/);
  });

  test("pg: legacy compatibility rejects filename drift", async () => {
    const pool = newPool();
    await insertControlRow(legacy, 1);
    await insertControlRow(transactional, 2);
    await createLegacyLedger([legacy.filename, "0100_filename_drift.sql"]);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy, transactional), /incompatible/);
  });

  test("pg: legacy compatibility rejects non-prefix control state", async () => {
    const pool = newPool();
    await insertControlRow(transactional, 1);
    await createLegacyLedger([transactional.filename]);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy, transactional), /ordering or migration ID mismatch/);
  });

  test("pg: duplicate legacy rows are blocked where the legacy structure permits them", async () => {
    const pool = newPool();
    await insertControlRow(legacy, 1);
    await insertControlRow(transactional, 2);
    await createLegacyLedger([legacy.filename, legacy.filename]);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy, transactional), /incompatible/);
  });

  test("pg: a failing transactional migration rolls back and leaves no applied row", async () => {
    const pool = newPool();
    await execute(pool, manifestOf(legacy));

    const broken = { ...transactional, filename: "0100_broken_contract.sql" };
    const brokenBytes = Buffer.from("alter table demo add column note text;\nselect 1 / 0;\n", "utf8");
    files[broken.filename] = brokenBytes;
    writeFileSync(path.join(root, "db", "migrations", broken.filename), brokenBytes);
    broken.sha256 = sha256(brokenBytes);

    await assert.rejects(execute(pool, manifestOf(legacy, broken)), /sql_failed/);

    assert.equal(await count("migration_control.schema_migrations"), 1, "no applied row for the failed migration");
    const column = await admin.query(
      "select 1 from information_schema.columns where table_name = 'demo' and column_name = 'note'",
    );
    assert.equal(column.rowCount, 0, "the DDL rolled back with the ledger row");

    // The failure events survived on the control connection.
    const events = await admin.query<{ event_type: string; sqlstate: string | null; error_class: string | null }>(
      "select event_type, sqlstate, error_class from migration_control.migration_runs where migration_id = '0100' order by event_sequence",
    );
    assert.deepEqual(events.rows.map(({ event_type }) => event_type), ["started", "transaction_rolled_back", "execution_failed"]);
    assert.equal(events.rows[1].sqlstate, "22012");
    assert.equal(events.rows[1].error_class, "sql_failed");
  });

  test("pg: a known legacy SQL failure with confirmed rollback may retry", async () => {
    const pool = newPool();
    const filename = "0002_retry_contract.sql";
    const failedBytes = Buffer.from(
      "begin;\ncreate table retry_demo (id integer);\nselect 1 / 0;\ncommit;\n",
      "utf8",
    );
    files[filename] = failedBytes;
    writeFileSync(path.join(root, "db", "migrations", filename), failedBytes);
    const failed = entry("0002", filename, "legacy-verbatim", ["schema"]);

    await assert.rejects(execute(pool, manifestOf(failed)), /sql_failed/);
    const absent = await admin.query("select pg_catalog.to_regclass('public.retry_demo') as relation");
    assert.equal(absent.rows[0].relation, null);

    const retryBytes = Buffer.from("begin;\ncreate table retry_demo (id integer);\ncommit;\n", "utf8");
    const renamedFilename = "0002_renamed_after_failure.sql";
    files[renamedFilename] = retryBytes;
    writeFileSync(path.join(root, "db", "migrations", renamedFilename), retryBytes);
    const renamed = entry("0002", renamedFilename, "legacy-verbatim", ["schema"]);
    await assertBlockedWithoutWrites(pool, manifestOf(renamed), /stale_legacy_attempt/);

    files[filename] = retryBytes;
    writeFileSync(path.join(root, "db", "migrations", filename), retryBytes);
    const retry = entry("0002", filename, "legacy-verbatim", ["schema"]);
    const report = await execute(pool, manifestOf(retry));
    assert.equal(report.executedCount, 1);

    const events = await admin.query<{ event_type: string; statement_ordinal: number | null }>(
      "select event_type, statement_ordinal from migration_control.migration_runs where migration_id = '0002' order by occurred_at, event_sequence",
    );
    assert.deepEqual(events.rows.map(({ event_type }) => event_type), [
      "started", "transaction_rolled_back", "execution_failed",
      "started", "operation_completed", "applied_committed", "succeeded",
    ]);
    assert.deepEqual(events.rows.map(({ statement_ordinal }) => statement_ordinal), [
      null, 1, 1, null, null, null, null,
    ]);
    await admin.query("drop table retry_demo");
  });

  test("pg: malformed legacy retry identities fail before SQL or ledger writes", async () => {
    const exactMetadata = {
      execution_mode: "legacy-verbatim",
      migration_filename: legacy.filename,
      migration_ordinal: 1,
    };
    const cases: Array<[string, Array<{
      type: string;
      statementOrdinal?: number | null;
      metadata?: Record<string, unknown>;
    }>]> = [
      ["started = 99", [
        { type: "started", statementOrdinal: 99 },
        { type: "transaction_rolled_back" },
        { type: "execution_failed" },
      ]],
      ["transaction_rolled_back = 99", [
        { type: "started" },
        { type: "transaction_rolled_back", statementOrdinal: 99 },
        { type: "execution_failed" },
      ]],
      ["execution_failed = 99", [
        { type: "started" },
        { type: "transaction_rolled_back" },
        { type: "execution_failed", statementOrdinal: 99 },
      ]],
      ["required value is null", [
        { type: "started" },
        { type: "transaction_rolled_back", statementOrdinal: null },
        { type: "execution_failed" },
      ]],
      ["required null has a value", [
        { type: "started", statementOrdinal: 1 },
        { type: "transaction_rolled_back" },
        { type: "execution_failed" },
      ]],
      ["failure ordinals are inconsistent", [
        { type: "started" },
        { type: "transaction_rolled_back" },
        { type: "execution_failed", statementOrdinal: 2 },
      ]],
      ["filename is absent", [
        { type: "started", metadata: { execution_mode: "legacy-verbatim", migration_ordinal: 1 } },
        { type: "transaction_rolled_back", metadata: { execution_mode: "legacy-verbatim", migration_ordinal: 1 } },
        { type: "execution_failed", metadata: { execution_mode: "legacy-verbatim", migration_ordinal: 1 } },
      ]],
      ["filenames are inconsistent within the run", [
        { type: "started", metadata: exactMetadata },
        { type: "transaction_rolled_back", metadata: {
          ...exactMetadata,
          migration_filename: "0001_renamed_after_failure.sql",
        } },
        { type: "execution_failed", metadata: exactMetadata },
      ]],
    ];

    for (const [name, events] of cases) {
      await resetDatabase();
      await insertAttemptEvents("0001", "30000000-0000-4000-8000-000000000099", events);
      const pool = newPool();
      await assertBlockedWithoutWrites(pool, manifestOf(legacy), /stale_legacy_attempt/);
      const relation = await admin.query("select pg_catalog.to_regclass('public.demo') as relation");
      assert.equal(relation.rows[0].relation, null, name);
    }
  });

  test("pg: operation_completed without an applied row remains blocked", async () => {
    const pool = newPool();
    await insertAttemptEvents("0001", "30000000-0000-4000-8000-000000000001", [
      { type: "started" },
      { type: "operation_completed" },
    ]);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy), /stale_legacy_attempt/);
  });

  test("pg: legacy connection loss remains blocked", async () => {
    const pool = newPool();
    await insertAttemptEvents("0001", "30000000-0000-4000-8000-000000000002", [
      { type: "started" },
      { type: "execution_failed", errorClass: "control_connection_lost" },
    ]);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy), /stale_legacy_attempt/);
  });

  test("pg: an unknown legacy COMMIT outcome remains blocked", async () => {
    const pool = newPool();
    await insertAttemptEvents("0001", "30000000-0000-4000-8000-000000000003", [
      { type: "started" },
      { type: "execution_failed", errorClass: "sql_failed" },
    ]);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy), /stale_legacy_attempt/);
  });

  test("pg: events for another run block automatic legacy retry", async () => {
    const pool = newPool();
    const safeFailure = [
      { type: "started" },
      { type: "transaction_rolled_back" },
      { type: "execution_failed" },
    ];
    await insertAttemptEvents("0001", "30000000-0000-4000-8000-000000000004", safeFailure);
    await insertAttemptEvents("0001", "30000000-0000-4000-8000-000000000005", safeFailure);
    await assertBlockedWithoutWrites(pool, manifestOf(legacy), /stale_legacy_attempt/);
  });

  test("pg: the attempt event stream is strictly append-only", async () => {
    const pool = newPool();
    await execute(pool, manifestOf(legacy));
    assert.ok(await count("migration_control.migration_runs") > 0);

    for (const statement of [
      "update migration_control.migration_runs set event_type = 'succeeded'",
      "delete from migration_control.migration_runs",
      "truncate migration_control.migration_runs",
      "update migration_control.schema_migrations set baselined = true",
      "delete from migration_control.schema_migrations",
    ]) {
      await assert.rejects(admin.query(statement), (error: Error & { code?: string }) => error.code === "55000");
    }

    const sequences = await admin.query<{ event_sequence: number }>(
      "select event_sequence from migration_control.migration_runs order by event_sequence",
    );
    assert.deepEqual(sequences.rows.map(({ event_sequence }) => event_sequence), [1, 2, 3, 4]);
  });

  test("pg: losing the control connection aborts the run and records no applied row", async () => {
    const pool = newPool();
    const slow = { ...transactional, filename: "0100_slow_contract.sql" };
    // DDL first, then a sleep: if the orphaned transaction ever commits, the
    // column survives and the assertions below catch it.
    const slowBytes = Buffer.from("alter table demo add column note text;\nselect pg_sleep(3);\n", "utf8");
    files[slow.filename] = slowBytes;
    writeFileSync(path.join(root, "db", "migrations", slow.filename), slowBytes);
    slow.sha256 = sha256(slowBytes);

    await execute(pool, manifestOf(legacy));

    const pending = assert.rejects(
      execute(pool, manifestOf(legacy, slow)),
      (error: Error & { code?: string }) => error.code === "57P01",
    );
    // Terminate the control backend (the one holding the advisory lock) mid-run.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.query(
      `select pg_terminate_backend(pid)
         from pg_stat_activity
        where application_name = 'pb10-step3-contract'
          and pid <> pg_backend_pid()
          and query ilike '%migration_runs%'`,
    );
    await pending;

    // Give any orphaned execution backend more than the migration's own runtime
    // to finish and try to commit; a correct run has already destroyed it.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    assert.equal(await count("migration_control.schema_migrations"), 1, "the interrupted migration recorded nothing");
    const orphan = await admin.query(
      "select 1 from information_schema.columns where table_name = 'demo' and column_name = 'note'",
    );
    assert.equal(orphan.rowCount, 0, "an aborted run must not leave committed DDL behind");
    const lock = await admin.query<{ present: boolean }>(
      `select exists (
         select 1 from pg_locks
          where locktype = 'advisory' and classid = $1::oid and objid = $2::oid and objsubid = 2 and granted
       ) as present`,
      [...SCHEMA_ADVISORY_LOCK],
    );
    assert.equal(lock.rows[0].present, false, "the advisory lock is released when the backend dies");
  });

  test("pg: re-running with nothing pending writes nothing at all", async () => {
    const pool = newPool();
    await execute(pool, manifestOf(legacy, transactional));
    const events = await count("migration_control.migration_runs");

    const rerun = await execute(pool, manifestOf(legacy, transactional));
    assert.equal(rerun.outcome, "no-op");
    assert.equal(rerun.executedCount, 0);
    assert.equal(await count("migration_control.schema_migrations"), 2);
    assert.equal(await count("migration_control.migration_runs"), events, "a no-op run appends no events");
  });
}
