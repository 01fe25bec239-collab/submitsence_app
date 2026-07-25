import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { Client, Pool } from "pg";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import {
  executeMigrations,
  inspectConcurrentIndex,
  type MigrationHandlers,
  type NontransactionalState,
} from "../src/db/migrate/execute";
import { SCHEMA_ADVISORY_LOCK } from "../src/db/migrate/runner";

/**
 * Real-PostgreSQL contract for PB-10 Step 3. Registered only when a disposable
 * target is supplied, so the default suite keeps exactly the two documented
 * integration skips instead of gaining more.
 *
 *   TEST_DATABASE_URL=postgres://... node --import tsx --test test/migration-execute.pg.test.ts
 *
 * Every case drops and reinstalls migration_control, so the target must be
 * disposable.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl) {
  const repositoryRoot = path.resolve(__dirname, "../..");
  const controlSchemaSql = readFileSync(path.join(repositoryRoot, "db", "control", "control-schema.sql"), "utf8");

  const identity = {
    sourceGitSha: "c".repeat(40),
    executorImageDigest: `sha256:${"d".repeat(64)}`,
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

  const noHandlers: MigrationHandlers = { nontransactional: new Map(), batched: new Map() };
  const indexHandler = {
    inspect: (client: Parameters<typeof inspectConcurrentIndex>[0]): Promise<NontransactionalState> =>
      inspectConcurrentIndex(client, "public", "demo_label_idx"),
  };

  let admin: Client;
  const pools: Pool[] = [];

  const newPool = (): Pool => {
    const pool = new Pool({ connectionString: databaseUrl, max: 3, application_name: "pb10-step3-contract" });
    pools.push(pool);
    return pool;
  };

  const execute = (pool: Pool, manifest: MigrationManifest, handlers: MigrationHandlers = noHandlers) =>
    executeMigrations(pool, { manifest, identity, handlers, repositoryRoot: root });

  const count = async (relation: string): Promise<number> => {
    const result = await admin.query<{ total: string }>(`select count(*)::text as total from ${relation}`);
    return Number(result.rows[0].total);
  };

  before(async () => {
    admin = new Client({ connectionString: databaseUrl, application_name: "pb10-step3-admin" });
    await admin.connect();
  });

  after(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.query("drop table if exists demo cascade");
    // Leave the target as this file found it: a freshly installed, empty
    // control schema, so surrounding steps stay order-independent.
    await admin.query("drop schema if exists migration_control cascade");
    await admin.query(controlSchemaSql);
    await admin.end();
  });

  beforeEach(async () => {
    await admin.query("drop schema if exists migration_control cascade");
    await admin.query("drop table if exists demo cascade");
    await admin.query(controlSchemaSql);
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

  test("pg: a second runner is excluded while the schema advisory lock is held", async () => {
    const holder = new Client({ connectionString: databaseUrl, application_name: "pb10-lock-holder" });
    await holder.connect();
    try {
      const held = await holder.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock($1, $2) as acquired",
        [...SCHEMA_ADVISORY_LOCK],
      );
      assert.equal(held.rows[0].acquired, true);

      const pool = newPool();
      await assert.rejects(
        executeMigrations(pool, {
          manifest: manifestOf(legacy),
          identity,
          handlers: noHandlers,
          repositoryRoot: root,
          pollMs: 50,
          budgetMs: 150,
          diagnose: () => undefined,
        }),
        /Schema advisory lock was not acquired/,
      );
      assert.equal(await count("migration_control.schema_migrations"), 0, "the excluded runner wrote nothing");
      assert.equal(await count("migration_control.migration_runs"), 0);
    } finally {
      await holder.end();
    }
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

    const pending = execute(pool, manifestOf(legacy, slow));
    // Terminate the control backend (the one holding the advisory lock) mid-run.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.query(
      `select pg_terminate_backend(pid)
         from pg_stat_activity
        where application_name = 'pb10-step3-contract'
          and pid <> pg_backend_pid()
          and query ilike '%migration_runs%'`,
    );
    await assert.rejects(pending);

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

  test("pg: a nontransactional index is recorded only after its verifier confirms it", async () => {
    const pool = newPool();
    const report = await execute(
      pool,
      manifestOf(legacy, concurrentIndex),
      { nontransactional: new Map([["0101", indexHandler]]), batched: new Map() },
    );

    assert.deepEqual(report.executed.map(({ id, adopted }) => [id, adopted]), [["0001", false], ["0101", false]]);
    const index = await admin.query<{ indisvalid: boolean }>(
      "select i.indisvalid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = 'demo_label_idx'",
    );
    assert.equal(index.rows[0].indisvalid, true);
    assert.equal(await count("migration_control.schema_migrations where migration_id = '0101'"), 1);

    const events = await admin.query<{ event_type: string }>(
      "select event_type from migration_control.migration_runs where migration_id = '0101' order by event_sequence",
    );
    assert.deepEqual(events.rows.map(({ event_type }) => event_type), [
      "started", "operation_completed", "applied_committed", "succeeded",
    ]);
  });

  test("pg: an invalid concurrent index is never blindly replayed", async () => {
    const pool = newPool();
    await execute(pool, manifestOf(legacy));

    // demo holds duplicate labels, so a concurrent UNIQUE build fails and leaves
    // an invalid index behind — the exact state that must not be retried blindly.
    await assert.rejects(admin.query("create unique index concurrently demo_label_idx on demo (label)"));
    const invalid = await admin.query<{ indisvalid: boolean }>(
      "select i.indisvalid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = 'demo_label_idx'",
    );
    assert.equal(invalid.rows[0].indisvalid, false, "an invalid index must be present for this contract");

    await assert.rejects(
      execute(pool, manifestOf(legacy, concurrentIndex), {
        nontransactional: new Map([["0101", indexHandler]]),
        batched: new Map(),
      }),
      /verifier_state_invalid/,
    );

    assert.equal(await count("migration_control.schema_migrations"), 1, "no applied row for an unrecoverable state");
    const events = await admin.query<{ event_type: string; error_class: string | null }>(
      "select event_type, error_class from migration_control.migration_runs where migration_id = '0101' order by event_sequence",
    );
    assert.deepEqual(events.rows.map(({ event_type }) => event_type), ["started", "verification_failed"]);
    assert.equal(events.rows[1].error_class, "verifier_state_invalid");
  });

  test("pg: a valid but unrecorded concurrent index is adopted rather than rebuilt", async () => {
    const pool = newPool();
    await execute(pool, manifestOf(legacy));
    await admin.query("create index concurrently demo_label_idx on demo (label)");

    const report = await execute(pool, manifestOf(legacy, concurrentIndex), {
      nontransactional: new Map([["0101", indexHandler]]),
      batched: new Map(),
    });
    assert.equal(report.executed[0].adopted, true);
    assert.equal(await count("migration_control.schema_migrations"), 2);
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
