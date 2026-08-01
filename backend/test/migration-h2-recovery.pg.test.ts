import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { Client, Pool, type PoolClient } from "pg";
import type {
  BatchedContext,
  BatchedHandler,
  NontransactionalHandler,
  NontransactionalState,
} from "../src/db/migrate/execute";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import { assertDistinctDatabases } from "../src/db/migrate/database-identity";
import { installControlSchema, type ControlSchemaInstall } from "./helpers/control-schema-install";
import { executeMigrationsForTest } from "./helpers/migration-execute";

/**
 * PB-10 Step 3 Phase 2c, HIGH 2 — mode-specific safe recovery, against real
 * PostgreSQL, driven exclusively through executeMigrations(pool).
 *
 * Every case here builds its blocking-or-not history the only way production
 * ever does: by really running a migration that really fails, on a real
 * connection, and then really running it again. Nothing is hand-inserted, so
 * what is asserted is the behaviour of the two-stage decision system against
 * the ledger rows the executor itself wrote — including the durable progress
 * markers, whose whole purpose is to survive the process that wrote them.
 *
 *   MIGRATION_TEST_DATABASE_URL=postgres://... TEST_DATABASE_URL=postgres://... \
 *     node --import tsx --test test/migration-h2-recovery.pg.test.ts
 */
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required for the destructive PB-10 Phase 2c H2 recovery suite in CI");
}

if (!databaseUrl) {
  test("pg: H2 mode-specific recovery suite requires a dedicated disposable database", {
    skip: "MIGRATION_TEST_DATABASE_URL is not set; refusing to drop schemas in a shared or unidentified database",
  }, () => undefined);
} else {
  const identity = {
    sourceGitSha: "5324116250977b5e8ac24bc83b6cae89ebcbd990",
    executorImageDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    runnerId: "pb10-h2-recovery-pg",
  };
  const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
  const timeouts = { lockMs: 5_000, statementMs: 60_000, transactionMs: 300_000, idleInTransactionMs: 60_000, wallClockMs: 900_000 };

  const root = mkdtempSync(path.join(os.tmpdir(), "pb10-h2-recovery-pg-"));
  mkdirSync(path.join(root, "db", "migrations"), { recursive: true });
  after(() => rmSync(root, { recursive: true, force: true }));

  /** Writes a migration file into the fixture root and returns its manifest entry. */
  const migration = (
    id: string,
    filename: string,
    executionMode: MigrationManifestEntry["executionMode"],
    sql: string,
  ): MigrationManifestEntry => {
    const bytes = Buffer.from(sql, "utf8");
    writeFileSync(path.join(root, "db", "migrations", filename), bytes);
    return {
      id,
      filename,
      sha256: sha256(bytes),
      lifecyclePhase: executionMode === "batched" ? "backfill" : "expand",
      operationCategories: executionMode === "batched" ? ["data-correction"] : ["schema"],
      executionMode,
      requiredRuntimeEpoch: null,
      timeouts,
    };
  };

  const manifestOf = (entry: MigrationManifestEntry): MigrationManifest =>
    ({ schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] });

  let admin: Client;
  let install: ControlSchemaInstall;
  const pools: Pool[] = [];
  const newPool = (): Pool => {
    const pool = new Pool({ connectionString: install.executionUrl, max: 3, application_name: "pb10-h2-recovery" });
    pools.push(pool);
    return pool;
  };

  const resetDatabase = async (): Promise<void> => {
    await admin.query("drop schema if exists migration_control cascade");
    await admin.query("drop schema if exists public cascade");
    await admin.query("create schema public");
    install = await installControlSchema(admin, databaseUrl!);
    await admin.query("create table public.demo (id integer primary key, label text)");
    // Owned by the runner: a nontransactional CREATE INDEX CONCURRENTLY needs
    // ownership of the table, not merely privileges on it.
    await admin.query(`alter table public.demo owner to ${install.executionRole}`);
  };

  const count = async (relation: string): Promise<number> => {
    const result = await admin.query<{ total: string }>(`select count(*)::text as total from ${relation}`);
    return Number(result.rows[0].total);
  };

  const eventTypes = async (): Promise<string[]> => {
    const result = await admin.query<{ event_type: string }>(
      "select event_type from migration_control.migration_runs order by event_id",
    );
    return result.rows.map((row) => row.event_type);
  };

  /** statement_ordinal per heartbeat row, in order — the H2 progress markers. */
  const markers = async (): Promise<number[]> => {
    const result = await admin.query<{ statement_ordinal: number }>(
      `select statement_ordinal from migration_control.migration_runs
        where event_type = 'heartbeat' and statement_ordinal is not null
        order by event_id`,
    );
    return result.rows.map((row) => Number(row.statement_ordinal));
  };

  type Substitutions = {
    nontransactionalHandlers?: ReadonlyMap<string, NontransactionalHandler>;
    batchedHandlers?: ReadonlyMap<string, BatchedHandler>;
  };

  const execute = (
    pool: Pool,
    entry: MigrationManifestEntry,
    substitutions: Substitutions = {},
  ): Promise<unknown> => executeMigrationsForTest(pool, {
    manifest: manifestOf(entry),
    identity,
    repositoryRoot: root,
    ...substitutions,
  });

  /** A verifier whose answers are scripted in call order; the last one repeats. */
  const scriptedVerifier = (entry: MigrationManifestEntry, ...states: Array<NontransactionalState | "throw">) => {
    const remaining = [...states];
    const calls: Array<NontransactionalState | "throw"> = [];
    const handler: NontransactionalHandler = {
      inspect: async () => {
        const state = remaining.length > 1 ? remaining.shift()! : remaining[0];
        calls.push(state);
        if (state === "throw") throw new Error("verifier could not run");
        return state;
      },
    };
    return { calls, nontransactionalHandlers: new Map([[entry.id, handler]]) };
  };

  before(async () => {
    await assertDistinctDatabases(
      { a: databaseUrl, b: process.env.TEST_DATABASE_URL },
      { a: "MIGRATION_TEST_DATABASE_URL", b: "TEST_DATABASE_URL" },
    );
    admin = new Client({ connectionString: databaseUrl, application_name: "pb10-h2-recovery-admin" });
    await admin.connect();
    install = await installControlSchema(admin, databaseUrl!);
  });

  after(async () => {
    if (admin === undefined) return;
    await Promise.all(pools.map((pool) => pool.end()));
    await resetDatabase();
    await admin.end();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  // ── transactional: behaviour deliberately unchanged ──────────────────────

  test("pg H2 transactional: a real SQL failure still rolls back and still retries automatically once PostgreSQL confirms the abort", async () => {
    const pool = newPool();
    // One file, byte-identical across both attempts (a changed file is a
    // different migration and is refused for its own separate reason). The
    // first attempt fails on a conflicting row an operator then removes.
    const entry = migration("0100", "0100_h2_transactional.sql", "transactional", "insert into demo values (1, 'a');\n");
    await admin.query("insert into demo values (1, 'blocker')");
    await assert.rejects(execute(pool, entry), /sql_failed/);
    assert.equal(await count("public.demo"), 1, "the whole transaction rolled back; only the blocker row remains");
    assert.equal(await count("migration_control.schema_migrations"), 0);
    // Transactional mode writes no progress markers: its authoritative
    // evidence is the protected transaction binding, which C1/C2 own.
    assert.deepEqual(await markers(), [], "transactional mode is unchanged and records no H2 marker");

    // The bound transaction genuinely aborted, so replay is authoritative —
    // exactly the pre-H2 behaviour, through the same C1/C2 proof path.
    await admin.query("delete from demo");
    await execute(pool, entry);
    assert.equal(await count("public.demo"), 1);
    assert.equal(await count("migration_control.schema_migrations"), 1);
  });

  test("pg H2 transactional: an attempt whose transaction PostgreSQL cannot rule on is never retried", async () => {
    const pool = newPool();
    const entry = migration("0100", "0100_h2_unbound.sql", "transactional", "insert into demo values (2, 'b');\n");
    // A `started` row with no binding at all — the shape an attempt that died
    // between arming and BEGIN leaves behind. PostgreSQL has no verdict to
    // give, so Stage 2 refuses rather than guessing.
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
       values ($1, $2, 1, 'started', $3, $4, $5, $6::jsonb)`,
      [
        randomUUID(), entry.id, identity.runnerId, identity.sourceGitSha, identity.executorImageDigest,
        JSON.stringify({ execution_mode: "transactional", migration_filename: entry.filename, migration_ordinal: 1, checksum_sha256: entry.sha256 }),
      ],
    );
    await assert.rejects(execute(pool, entry), /transactional:MANUAL_RESOLUTION_REQUIRED:no_exclusive_transaction_binding/);
    assert.equal(await count("public.demo"), 0, "no migration SQL ran");
  });

  // ── legacy-verbatim ──────────────────────────────────────────────────────

  test("pg H2 legacy-verbatim: a failure before the payload could be issued retries automatically", async () => {
    const pool = newPool();
    const sql = "begin;\ninsert into demo values (3, 'legacy');\ncommit;\n";
    // A one-millisecond wall-clock budget is exhausted by the armed marker's
    // own control-connection round trip, so this attempt genuinely fails
    // *before* the payload is issued and genuinely never writes the
    // durable-work marker.
    const starved = { ...migration("0001", "0001_h2_legacy.sql", "legacy-verbatim", sql), timeouts: { ...timeouts, wallClockMs: 1 } };
    await assert.rejects(execute(pool, starved), /wall_clock_exceeded/);
    assert.deepEqual(await markers(), [1], "armed, but durable work was never marked");
    assert.equal(await count("public.demo"), 0);

    // Stage 2 proves from the ledger alone that nothing was issued.
    const retried = migration("0001", "0001_h2_legacy.sql", "legacy-verbatim", sql);
    await execute(pool, retried);
    assert.equal(await count("public.demo"), 1, "the payload ran exactly once, on the retry");
    assert.equal(await count("migration_control.schema_migrations"), 1);
  });

  test("pg H2 legacy-verbatim: once the payload has been issued, only a recovery verifier can speak for the attempt", async () => {
    const pool = newPool();
    // One byte-identical file throughout: the first attempt fails on a
    // conflicting row an operator then removes.
    const fixed = migration("0001", "0001_h2_legacy_failed.sql", "legacy-verbatim", "begin;\ninsert into demo values (4, 'legacy');\ncommit;\n");
    await admin.query("insert into demo values (4, 'blocker')");
    await assert.rejects(execute(pool, fixed), /sql_failed/);
    assert.deepEqual(await markers(), [1, 2], "the durable-work marker records that the payload really was issued");
    assert.equal(await count("public.demo"), 1, "the payload's own transaction rolled back; only the blocker row remains");
    await admin.query("delete from demo");

    // No reviewed recovery verifier: exactly as fail-closed as pre-H2.
    await assert.rejects(execute(pool, fixed), /legacy-verbatim:MANUAL_RESOLUTION_REQUIRED:recovery_verifier_unavailable/);

    // A verifier that cannot classify the state blocks too.
    await assert.rejects(
      execute(pool, fixed, { nontransactionalHandlers: scriptedVerifier(fixed, "unknown").nontransactionalHandlers }),
      /legacy-verbatim:MANUAL_RESOLUTION_REQUIRED:verifier_evidence_inconclusive/,
    );

    // So does one that reports a partial or invalid state.
    await assert.rejects(
      execute(pool, fixed, { nontransactionalHandlers: scriptedVerifier(fixed, "invalid").nontransactionalHandlers }),
      /legacy-verbatim:MANUAL_RESOLUTION_REQUIRED:verifier_reports_partial_or_invalid_state/,
    );

    // And so does one that fails outright — a handler exception is never proof
    // that no SQL completed.
    await assert.rejects(
      execute(pool, fixed, { nontransactionalHandlers: scriptedVerifier(fixed, "throw").nontransactionalHandlers }),
      /legacy-verbatim:MANUAL_RESOLUTION_REQUIRED:recovery_verifier_failed/,
    );
    assert.equal(await count("public.demo"), 0, "nothing was replayed by any of the blocked attempts");

    // A verifier proving no durable effect is the one thing that permits it.
    await execute(pool, fixed, { nontransactionalHandlers: scriptedVerifier(fixed, "absent").nontransactionalHandlers });
    assert.equal(await count("public.demo"), 1);
    assert.equal(await count("migration_control.schema_migrations"), 1);
  });

  test("pg H2 legacy-verbatim: a verifier proving the desired state adopts the migration instead of replaying it", async () => {
    const pool = newPool();
    const entry = migration("0001", "0001_h2_legacy_adopt.sql", "legacy-verbatim", "begin;\ninsert into demo values (5, 'legacy');\ncommit;\n");
    await admin.query("insert into demo values (5, 'blocker')");
    await assert.rejects(execute(pool, entry), /sql_failed/);

    // The desired end state now exists independently of the ledger, exactly as
    // it would if the payload had committed and the process died before its
    // applied row could be written.
    await execute(pool, entry, { nontransactionalHandlers: scriptedVerifier(entry, "valid").nontransactionalHandlers });

    // Replaying the payload would have raised a duplicate-key error; adoption
    // records the applied row without re-issuing a single statement.
    assert.equal(await count("public.demo"), 1);
    assert.equal(await count("migration_control.schema_migrations"), 1);
    const types = await eventTypes();
    assert.deepEqual(types.slice(-3), ["operation_completed", "applied_committed", "succeeded"]);
    assert.equal(types.filter((type) => type === "succeeded").length, 1);
  });

  // ── nontransactional ─────────────────────────────────────────────────────

  test("pg H2 nontransactional: a failure before the first statement retries; a verifier then decides everything else", async () => {
    const pool = newPool();
    const filename = "0101_h2_index.sql";
    const entry = migration("0101", filename, "nontransactional", "create index concurrently demo_label_h2_idx on demo (label);\n");

    // Pre-flight verifier reports an unclassifiable state: the attempt is
    // armed but no statement is ever issued.
    await assert.rejects(
      execute(pool, entry, { nontransactionalHandlers: scriptedVerifier(entry, "unknown").nontransactionalHandlers }),
      /verifier_state_invalid/,
    );
    assert.deepEqual(await markers(), [1], "armed, and no statement was issued");

    // Stage 2 proves that from the ledger, so the retry is permitted without
    // consulting any verifier about durability at all.
    // Stage 2 never consults the verifier here (the ledger already proves no
    // statement was issued); these two answers are the mode's own pre-flight
    // and post-execution inspections.
    const script = scriptedVerifier(entry, "absent", "valid");
    await execute(pool, entry, { nontransactionalHandlers: script.nontransactionalHandlers });
    const indexes = await admin.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public' and indexname = 'demo_label_h2_idx'",
    );
    assert.equal(indexes.rows.length, 1, "the index really was created");
    assert.equal(await count("migration_control.schema_migrations"), 1);
    assert.deepEqual(await markers(), [1, 1, 2], "the second attempt marked both armed and durable work");
  });

  test("pg H2 nontransactional: an issued statement with no conclusive verifier blocks, and a proven state adopts", async () => {
    const pool = newPool();
    // A statement that is genuinely issued; the verifier then refuses to
    // confirm completion, so the durable-work marker is left behind. One
    // byte-identical file across every attempt below.
    const fixed = migration("0101", "0101_h2_index_fail.sql", "nontransactional", "create index concurrently demo_label_h2b_idx on demo (label);\n");
    await assert.rejects(
      execute(pool, fixed, { nontransactionalHandlers: scriptedVerifier(fixed, "absent").nontransactionalHandlers }),
      /verification_failed/,
    );
    assert.deepEqual(await markers(), [1, 2], "the statement really was issued");
    // Inconclusive: blocked.
    await assert.rejects(
      execute(pool, fixed, { nontransactionalHandlers: scriptedVerifier(fixed, "unknown").nontransactionalHandlers }),
      /nontransactional:MANUAL_RESOLUTION_REQUIRED:verifier_evidence_inconclusive/,
    );
    // Partial/invalid: blocked.
    await assert.rejects(
      execute(pool, fixed, { nontransactionalHandlers: scriptedVerifier(fixed, "invalid").nontransactionalHandlers }),
      /nontransactional:MANUAL_RESOLUTION_REQUIRED:verifier_reports_partial_or_invalid_state/,
    );
    // Unavailable: blocked.
    await assert.rejects(execute(pool, fixed), /nontransactional:MANUAL_RESOLUTION_REQUIRED:recovery_verifier_unavailable/);
    assert.equal(await count("migration_control.schema_migrations"), 0);

    // Proven already applied: adopted, never re-executed.
    const report = await execute(pool, fixed, { nontransactionalHandlers: scriptedVerifier(fixed, "valid").nontransactionalHandlers }) as { executed: Array<{ adopted: boolean }> };
    assert.equal(report.executed[0].adopted, true);
    assert.equal(await count("migration_control.schema_migrations"), 1);
  });

  // ── batched ──────────────────────────────────────────────────────────────

  const batchHandler = (
    execute_: (context: BatchedContext) => Promise<void>,
    verifyComplete: (client: PoolClient) => Promise<boolean> = async () => true,
  ): BatchedHandler => ({ execute: execute_, verifyComplete });

  test("pg H2 batched: a failure before any batch opened a transaction retries automatically", async () => {
    const pool = newPool();
    const entry = migration("0102", "0102_h2_backfill.sql", "batched", "-- batched\n");
    await assert.rejects(
      execute(pool, entry, {
        batchedHandlers: new Map([[entry.id, batchHandler(async () => { throw new Error("handler refused before any batch"); })]]),
      }),
      /handler refused before any batch|sql_failed/,
    );
    assert.deepEqual(await markers(), [1], "armed, and no batch ever opened a transaction");
    assert.equal(await count("public.demo"), 0);

    await execute(pool, entry, {
      batchedHandlers: new Map([[entry.id, batchHandler(async (context) => {
        await context.runBatch(async (client) => { await client.query("insert into demo values (6, 'batch')"); });
      })]]),
    });
    assert.equal(await count("public.demo"), 1);
    assert.equal(await count("migration_control.schema_migrations"), 1);
    assert.deepEqual(await markers(), [1, 1, 2]);
  });

  test("pg H2 batched: once a batch has committed, replay requires an operator", async () => {
    const pool = newPool();
    const entry = migration("0102", "0102_h2_backfill_partial.sql", "batched", "-- batched\n");
    await assert.rejects(
      execute(pool, entry, {
        batchedHandlers: new Map([[entry.id, batchHandler(async (context) => {
          await context.runBatch(async (client) => { await client.query("insert into demo values (7, 'first')"); });
          await context.runBatch(async (client) => { await client.query("insert into demo values (7, 'duplicate')"); });
        })]]),
      }),
      /sql_failed/,
    );
    assert.equal(await count("public.demo"), 1, "the first batch really committed on its own transaction boundary");

    await assert.rejects(
      execute(pool, entry, {
        batchedHandlers: new Map([[entry.id, batchHandler(async () => undefined)]]),
      }),
      /batched:MANUAL_RESOLUTION_REQUIRED:at_least_one_batch_committed/,
    );
    assert.equal(await count("migration_control.schema_migrations"), 0);
  });

  test("pg H2 batched: a batch that opened a transaction but committed nothing still requires an operator", async () => {
    const pool = newPool();
    const entry = migration("0102", "0102_h2_backfill_none.sql", "batched", "-- batched\n");
    await assert.rejects(
      execute(pool, entry, {
        batchedHandlers: new Map([[entry.id, batchHandler(async (context) => {
          await context.runBatch(async (client) => { await client.query("select 1 / 0"); });
        })]]),
      }),
      /sql_failed/,
    );
    assert.deepEqual(await markers(), [1, 2], "a batch really did open a transaction");
    await assert.rejects(
      execute(pool, entry, {
        batchedHandlers: new Map([[entry.id, batchHandler(async () => undefined)]]),
      }),
      /batched:MANUAL_RESOLUTION_REQUIRED:batch_began_without_provable_commit_outcome/,
    );
  });

  // ── the Stage 1 / Stage 2 boundary ───────────────────────────────────────

  test("pg H2: malformed central history is never overridden by a verifier, however conclusive the verifier is", async () => {
    const pool = newPool();
    const entry = migration("0101", "0101_h2_malformed.sql", "nontransactional", "create index concurrently demo_label_h2c_idx on demo (label);\n");
    const runId = randomUUID();
    const metadata = JSON.stringify({
      execution_mode: "nontransactional",
      migration_filename: entry.filename,
      migration_ordinal: 1,
      checksum_sha256: entry.sha256,
    });
    // Two `started` rows for one attempt: outside the ledger's writer
    // contract, so Stage 1 refuses and Stage 2 never runs.
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
       values ($1, $2, 1, 'started', $3, $4, $5, $6::jsonb),
              ($1, $2, 2, 'started', $3, $4, $5, $6::jsonb)`,
      [runId, entry.id, identity.runnerId, identity.sourceGitSha, identity.executorImageDigest, metadata],
    );
    const script = scriptedVerifier(entry, "absent");
    await assert.rejects(
      execute(pool, entry, { nontransactionalHandlers: script.nontransactionalHandlers }),
      /duplicate_started_not_permitted_by_ledger_contract/,
    );
    assert.deepEqual(script.calls, [], "the verifier was never consulted against malformed history");
    assert.equal(await count("migration_control.schema_migrations"), 0);
  });

  test("pg H2: an unresolved commit_outcome_unknown is never overridden by a verifier", async () => {
    const pool = newPool();
    const entry = migration("0101", "0101_h2_ambiguous.sql", "nontransactional", "create index concurrently demo_label_h2d_idx on demo (label);\n");
    const runId = randomUUID();
    const metadata = JSON.stringify({
      execution_mode: "nontransactional",
      migration_filename: entry.filename,
      migration_ordinal: 1,
      checksum_sha256: entry.sha256,
    });
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, error_class, metadata)
       values ($1, $2, 1, 'started', $3, $4, $5, null, $6::jsonb),
              ($1, $2, 2, 'execution_failed', $3, $4, $5, 'commit_outcome_unknown', $6::jsonb)`,
      [runId, entry.id, identity.runnerId, identity.sourceGitSha, identity.executorImageDigest, metadata],
    );
    const script = scriptedVerifier(entry, "absent");
    await assert.rejects(
      execute(pool, entry, { nontransactionalHandlers: script.nontransactionalHandlers }),
      /reason=commit_outcome_unknown/,
    );
    assert.deepEqual(script.calls, [], "an ambiguous attempt is past the point a verifier can speak for it");
  });

  test("pg H2: an attempt written before progress recording existed never claims the pre-work retry", async () => {
    const pool = newPool();
    const entry = migration("0101", "0101_h2_historical.sql", "nontransactional", "create index concurrently demo_label_h2e_idx on demo (label);\n");
    // Exactly what a pre-H2 executor left behind: an armed row with no
    // progress markers at all. Reading that silence as "nothing was issued"
    // would offer an automatic replay of a possibly half-applied migration.
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
       values ($1, $2, 1, 'started', $3, $4, $5, $6::jsonb)`,
      [
        randomUUID(), entry.id, identity.runnerId, identity.sourceGitSha, identity.executorImageDigest,
        JSON.stringify({ execution_mode: "nontransactional", migration_filename: entry.filename, migration_ordinal: 1, checksum_sha256: entry.sha256 }),
      ],
    );
    await assert.rejects(execute(pool, entry), /nontransactional:MANUAL_RESOLUTION_REQUIRED:recovery_verifier_unavailable/);
    assert.equal(await count("migration_control.schema_migrations"), 0);
  });

  // ══════════════════════════════════════════════════════════════════════
  // PB-10 Step 3 Phase 2c final review, CRITICAL — progress-marker
  // provenance.
  //
  // The defect these cases exist for: the markers were ordinary `heartbeat`
  // rows carrying statement_ordinal, and the migration execution role held
  // column-level INSERT on that column. So the very role whose replay the
  // markers authorize could manufacture the evidence authorizing it — a
  // blocked attempt read as SAFE_TO_RETRY after one hand-written INSERT.
  //
  // Everything below runs on a connection authenticated *as the supported
  // non-superuser execution role*, because that is the only connection on
  // which an unforgeability claim means anything: asserting that a superuser
  // cannot forge a marker would prove nothing, since a superuser can.
  // ══════════════════════════════════════════════════════════════════════

  /** A connection as the migration execution role, closed with the suite. */
  const runnerClients: Client[] = [];
  const asRunner = async (): Promise<Client> => {
    const client = new Client({ connectionString: install.executionUrl, application_name: "pb10-h2-forgery" });
    await client.connect();
    runnerClients.push(client);
    return client;
  };
  after(async () => {
    await Promise.all(runnerClients.map((client) => client.end().catch(() => undefined)));
  });

  const markerMetadata = (entry: MigrationManifestEntry, mode: string): string => JSON.stringify({
    execution_mode: mode,
    migration_filename: entry.filename,
    migration_ordinal: 1,
    checksum_sha256: entry.sha256,
  });

  /**
   * Stages an armed attempt the way production does — a `started` row carrying
   * sha256(token) — and hands back the token, so a test can drive the
   * protected marker function exactly as the executor would.
   */
  const stageArmedAttempt = async (
    entry: MigrationManifestEntry,
    mode: string,
    runId = randomUUID(),
  ): Promise<{ runId: string; token: string }> => {
    const token = createHash("sha256").update(`${runId}|${entry.id}|token`).digest("hex");
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha,
          executor_image_digest, metadata, attempt_token_sha256)
       values ($1, $2, 1, 'started', $3, $4, $5, $6::jsonb, sha256(convert_to($7, 'UTF8')))`,
      [runId, entry.id, identity.runnerId, identity.sourceGitSha, identity.executorImageDigest,
        markerMetadata(entry, mode), token],
    );
    return { runId, token };
  };

  /** The forged INSERT itself: a perfectly marker-shaped ordinary ledger row. */
  const forgeMarker = (
    runner: Client,
    entry: MigrationManifestEntry,
    mode: string,
    runId: string,
    sequence: number,
    ordinal: number,
  ): Promise<unknown> => runner.query(
    `insert into migration_control.migration_runs
       (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha,
        executor_image_digest, metadata, statement_ordinal)
     values ($1, $2, $3, 'heartbeat', $4, $5, $6, $7::jsonb, $8)`,
    [runId, entry.id, sequence, identity.runnerId, identity.sourceGitSha,
      identity.executorImageDigest, markerMetadata(entry, mode), ordinal],
  );

  for (const [mode, filename, sql, blockedReason] of [
    ["nontransactional", "0101_h2_forge_nontx.sql", "create index concurrently demo_label_forge_a_idx on demo (label);\n",
      /nontransactional:MANUAL_RESOLUTION_REQUIRED:recovery_verifier_unavailable/],
    ["legacy-verbatim", "0001_h2_forge_legacy.sql", "begin;\ninsert into demo values (40, 'forge');\ncommit;\n",
      /legacy-verbatim:MANUAL_RESOLUTION_REQUIRED:recovery_verifier_unavailable/],
    ["batched", "0102_h2_forge_batched.sql", "-- batched\n",
      /batched:MANUAL_RESOLUTION_REQUIRED:batch_progress_unprovable_for_this_attempt/],
  ] as const) {
    test(`pg H2 marker provenance: a forged marker history cannot authorize replay in ${mode} mode`, async () => {
      const pool = newPool();
      const entry = migration(mode === "legacy-verbatim" ? "0001" : mode === "batched" ? "0102" : "0101", filename, mode, sql);
      // A pre-H2-shaped blocked attempt: armed, no markers, nothing to prove
      // it died before doing durable work. It must stay blocked.
      const { runId } = await stageArmedAttempt(entry, mode);
      const runner = await asRunner();

      // Marker 1 alone, marker 2 alone, and both together. All three are
      // refused by PostgreSQL itself: the execution role has no INSERT
      // privilege on statement_ordinal, so a statement that so much as names
      // the column is rejected before any row is considered.
      for (const ordinals of [[1], [2], [1, 2]]) {
        for (const [index, ordinal] of ordinals.entries()) {
          await assert.rejects(
            forgeMarker(runner, entry, mode, runId, 10 + index, ordinal),
            (error: { code?: string }) => error.code === "42501",
            `forging marker ${ordinal} must be refused with insufficient_privilege`,
          );
        }
      }
      assert.deepEqual(await markers(), [], "not one forged marker reached the ledger");

      // And the classification is unchanged: still blocked, still no applied row.
      await assert.rejects(
        execute(pool, entry, mode === "batched"
          ? { batchedHandlers: new Map([[entry.id, batchHandler(async () => undefined)]]) }
          : {}),
        blockedReason,
      );
      assert.equal(await count("migration_control.schema_migrations"), 0);
      assert.equal(await count("public.demo"), 0, "no payload ran");
    });
  }

  test("pg H2 marker provenance: markers retrospectively forged after a blocked classification change nothing", async () => {
    const pool = newPool();
    const entry = migration("0101", "0101_h2_forge_after.sql", "nontransactional",
      "create index concurrently demo_label_forge_b_idx on demo (label);\n");
    const { runId } = await stageArmedAttempt(entry, "nontransactional");
    await assert.rejects(execute(pool, entry), /recovery_verifier_unavailable/);

    const runner = await asRunner();
    await assert.rejects(forgeMarker(runner, entry, "nontransactional", runId, 20, 1), (e: { code?: string }) => e.code === "42501");
    await assert.rejects(forgeMarker(runner, entry, "nontransactional", runId, 21, 2), (e: { code?: string }) => e.code === "42501");
    await assert.rejects(execute(pool, entry), /recovery_verifier_unavailable/);
    assert.equal(await count("migration_control.schema_migrations"), 0);
  });

  test("pg H2 marker provenance: another attempt's markers never classify this one", async () => {
    const pool = newPool();
    const entry = migration("0101", "0101_h2_foreign_marker.sql", "nontransactional",
      "create index concurrently demo_label_forge_c_idx on demo (label);\n");
    // The victim: armed, unmarked, blocked.
    await stageArmedAttempt(entry, "nontransactional");
    // A different attempt of the same migration, marked all the way through
    // the *legitimate* protected path. Its markers are real; they simply do
    // not speak for the victim, because every identity column on a marker is
    // copied from its own attempt's `started` row.
    const other = await stageArmedAttempt(entry, "nontransactional");
    const runner = await asRunner();
    await runner.query("select migration_control.record_progress_marker($1, 2, 1)", [other.token]);
    await runner.query("select migration_control.record_progress_marker($1, 3, 2)", [other.token]);
    assert.deepEqual(await markers(), [1, 2], "the other attempt's markers really were recorded");

    await assert.rejects(execute(pool, entry), /recovery_verifier_unavailable/);
    assert.equal(await count("migration_control.schema_migrations"), 0);
  });

  test("pg H2 marker provenance: the protected writer refuses an unarmed, duplicated, or out-of-order marker", async () => {
    const entry = migration("0101", "0101_h2_marker_lifecycle.sql", "nontransactional",
      "create index concurrently demo_label_forge_d_idx on demo (label);\n");
    const { runId, token } = await stageArmedAttempt(entry, "nontransactional");
    const runner = await asRunner();

    // 1. No `started` attempt answers to this token, so no marker can name one.
    const orphan = createHash("sha256").update("orphan").digest("hex");
    await assert.rejects(
      runner.query("select migration_control.record_progress_marker($1, 2, 1)", [orphan]),
      /does not identify a started attempt/,
    );
    // 2. The durable-work marker cannot precede the armed marker.
    await assert.rejects(
      runner.query("select migration_control.record_progress_marker($1, 2, 2)", [token]),
      /cannot precede the armed marker/,
    );
    // 3. Only 1 and 2 are markers at all.
    await assert.rejects(
      runner.query("select migration_control.record_progress_marker($1, 2, 3)", [token]),
      /unknown migration progress marker/,
    );
    // 4. In order, both are accepted — and carry the attempt's own identity,
    //    never a caller-supplied one.
    await runner.query("select migration_control.record_progress_marker($1, 2, 1)", [token]);
    await runner.query("select migration_control.record_progress_marker($1, 3, 2)", [token]);
    const recorded = await admin.query<{ mismatches: string }>(
      `select count(*)::text as mismatches
         from migration_control.migration_runs m
         join migration_control.migration_runs s
           on s.run_id = m.run_id and s.migration_id = m.migration_id and s.event_type = 'started'
        where m.event_type = 'heartbeat' and m.statement_ordinal is not null
          and (m.runner_id is distinct from s.runner_id
               or m.source_git_sha is distinct from s.source_git_sha
               or m.executor_image_digest is distinct from s.executor_image_digest
               or m.metadata is distinct from s.metadata)`,
    );
    assert.equal(recorded.rows[0].mismatches, "0", "a marker cannot carry an identity contradicting its attempt");

    // 5. Neither ordinal can be recorded twice (mr_one_marker_per_attempt).
    for (const ordinal of [1, 2]) {
      await assert.rejects(
        runner.query("select migration_control.record_progress_marker($1, 4, $2)", [token, ordinal]),
        (error: { code?: string }) => error.code === "23505",
        `a duplicate marker ${ordinal} must be a unique violation`,
      );
    }
    assert.deepEqual(await markers(), [1, 2]);
    assert.ok(runId);
  });

  test("pg H2 marker provenance: the execution role cannot mutate, remove or replace protected marker state", async () => {
    const entry = migration("0101", "0101_h2_marker_immutable.sql", "nontransactional",
      "create index concurrently demo_label_forge_e_idx on demo (label);\n");
    const { token } = await stageArmedAttempt(entry, "nontransactional");
    const runner = await asRunner();
    await runner.query("select migration_control.record_progress_marker($1, 2, 1)", [token]);

    const refusals: Array<[string, string]> = [
      ["update migration_control.migration_runs set statement_ordinal = 2 where statement_ordinal = 1", "update"],
      ["delete from migration_control.migration_runs where statement_ordinal = 1", "delete"],
      ["truncate migration_control.migration_runs", "truncate"],
      // Replacing the protected writer, or the token resolver behind it, would
      // hand the execution role a marker factory. It owns neither.
      [`create or replace function migration_control.record_progress_marker(text, integer, integer)
          returns void language sql as 'select 1'`, "replace the marker writer"],
      ["drop function migration_control.record_progress_marker(text, integer, integer)", "drop the marker writer"],
      ["alter table migration_control.migration_runs owner to current_user", "take ownership of the ledger"],
      ["alter table migration_control.migration_runs disable trigger migration_runs_reject_mutation", "disable the mutation guard"],
      ["drop index migration_control.mr_one_marker_per_attempt", "drop the marker uniqueness index"],
    ];
    for (const [sql, what] of refusals) {
      await assert.rejects(runner.query(sql), `the execution role must not be able to ${what}`);
    }
    assert.deepEqual(await markers(), [1], "the marker survived every attempt to move it");
  });

  test("pg H2 marker provenance: a marker that cannot be persisted stops the run before any payload SQL", async () => {
    const pool = newPool();
    const entry = migration("0001", "0001_h2_marker_unpersistable.sql", "legacy-verbatim",
      "begin;\ninsert into demo values (41, 'must not run');\ncommit;\n");
    // The one way a marker write can fail without the connection failing: the
    // protected writer becomes uncallable. The run must abort rather than
    // proceed with unmarked progress — an unmarked payload is exactly the
    // ambiguity the markers exist to remove.
    await admin.query(
      `revoke execute on function migration_control.record_progress_marker(text, integer, integer)
         from ${install.executionRole}`,
    );
    try {
      await assert.rejects(execute(pool, entry));
      assert.equal(await count("public.demo"), 0, "no payload SQL ran without a durable marker");
      assert.deepEqual(await markers(), []);
      assert.equal(await count("migration_control.schema_migrations"), 0);
    } finally {
      await admin.query(
        `grant execute on function migration_control.record_progress_marker(text, integer, integer)
           to ${install.executionRole}`,
      );
    }
  });

  test("pg H2 marker provenance: legitimate protected markers still license the pre-payload retry", async () => {
    const pool = newPool();
    const sql = "begin;\ninsert into demo values (42, 'legit');\ncommit;\n";
    // Genuine marker 1 and no marker 2, written by the executor itself: the
    // one history that authorizes an automatic replay, unchanged by the
    // provenance hardening.
    const starved = { ...migration("0001", "0001_h2_marker_legit.sql", "legacy-verbatim", sql), timeouts: { ...timeouts, wallClockMs: 1 } };
    await assert.rejects(execute(pool, starved), /wall_clock_exceeded/);
    assert.deepEqual(await markers(), [1]);
    assert.equal(await count("public.demo"), 0);

    await execute(pool, migration("0001", "0001_h2_marker_legit.sql", "legacy-verbatim", sql));
    assert.equal(await count("public.demo"), 1);
    assert.equal(await count("migration_control.schema_migrations"), 1);
    assert.deepEqual(await markers(), [1, 1, 2]);
  });
}
