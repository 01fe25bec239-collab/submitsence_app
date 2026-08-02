import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool, type PoolClient } from "pg";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import { assertDistinctDatabases } from "../src/db/migrate/database-identity";
import { installControlSchema, type ControlSchemaInstall } from "./helpers/control-schema-install";
import { executeMigrationsForTest } from "./helpers/migration-execute";
import { startCommitProxy, type CommitProxy } from "./helpers/postgres-frame-proxy";

/**
 * PB-10 Step 3 Phase 2c: real-PostgreSQL contract for ambiguous post-COMMIT
 * connection failure.
 *
 *   MIGRATION_TEST_DATABASE_URL=postgres://... TEST_DATABASE_URL=postgres://... \
 *     node --import tsx --test test/migration-execute-commit-ambiguity.pg.test.ts
 *
 * A COMMIT that the client sends but never confirms has two real outcomes on
 * the server (it committed, or it never landed) and this suite needs to
 * reliably land on either one — not by racing timers, but by intercepting
 * the actual wire bytes. Every connection this suite opens to the target
 * database is routed through a tiny local TCP proxy that forwards bytes
 * unchanged until armed, at which point it recognises the specific message
 * it is watching for and severs both legs of the connection instead of
 * relaying it:
 *
 *   - armDropBeforeServer(): swallows the client's own outgoing "commit"
 *     query before it ever reaches PostgreSQL, then kills the connection.
 *     PostgreSQL never received COMMIT, so the still-open transaction is
 *     aborted the instant it detects the client is gone — a real, genuine
 *     rollback. The client, however, only ever observes a connection
 *     failure while awaiting a response it sent — it cannot tell this apart
 *     from the row having actually committed. This is the "reconciliation
 *     finds nothing" branch.
 *   - armDropBeforeClient(): lets "commit" reach PostgreSQL and waits for
 *     PostgreSQL's own response (the real COMMIT command-complete tag) —
 *     proof the transaction has already, genuinely committed — then kills
 *     the connection before relaying that response onward. The client
 *     experiences the exact same connection failure as above, but this time
 *     reconciliation must find the row. This is the "reconciliation finds a
 *     committed row" branch.
 *
 * Both are real PostgreSQL behaviour, not a fake: the proxy only ever
 * decides whether to relay bytes it has already seen, never fabricates a
 * response or a commit outcome itself.
 */
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required for the destructive PB-10 Phase 2c PostgreSQL suite in CI");
}

if (!databaseUrl) {
  test("pg: ambiguous-COMMIT suite requires a dedicated disposable database", {
    skip: "MIGRATION_TEST_DATABASE_URL is not set; refusing to connect to a shared or unidentified database",
  }, () => undefined);
} else {
  // startCommitProxy (protocol-precise, buffered PostgreSQL frame parsing —
  // Phase 2c blocker 7) lives in ./helpers/postgres-frame-proxy so its
  // FrameSplitter can also be exercised by pure, no-database parser unit
  // tests in migration-execute-commit-ambiguity-proxy.test.ts.
  const targetUrl = new URL(databaseUrl);
  const targetHost = targetUrl.hostname;
  const targetPort = Number(targetUrl.port) || 5432;

  const identity = {
    sourceGitSha: "5324116250977b5e8ac24bc83b6cae89ebcbd990",
    executorImageDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    runnerId: "pb10-phase2c-ambiguous-outcome",
  };
  const timeouts = { lockMs: 5_000, statementMs: 60_000, transactionMs: 300_000, idleInTransactionMs: 60_000, wallClockMs: 900_000 };

  const repositoryRoot = path.resolve(__dirname, "../..");
  /**
   * PB-10 Step 3 Phase 2c: the control schema is installed through psql, not
   * as one SQL blob over an ordinary connection. It now takes a required
   * `-v migration_execution_role` variable and includes the two files shared
   * with the upgrade path, and those are psql meta-commands the server never
   * sees. `install` carries the credentials for the non-superuser role every
   * pool below connects as — a superuser connection is refused by
   * verifyControlSchema, because a superuser bypasses every privilege the
   * commit-proof design relies on.
   */
  let install: ControlSchemaInstall;

  let admin: Client;
  const pools: Pool[] = [];
  const proxies: CommitProxy[] = [];

  const newProxiedPool = async (max = 2, applicationName = "pb10-phase2c-ambiguous-outcome"): Promise<{ pool: Pool; proxy: CommitProxy }> => {
    const proxy = await startCommitProxy(targetHost, targetPort);
    proxies.push(proxy);
    // Built from the *execution role's* credential, not the administrative
    // one: verifyControlSchema refuses a superuser connection outright, because
    // a superuser bypasses every privilege the commit-proof design relies on.
    const proxiedUrl = new URL(install.executionUrl);
    proxiedUrl.hostname = "127.0.0.1";
    proxiedUrl.port = String(proxy.port);
    const pool = new Pool({ connectionString: proxiedUrl.toString(), max, application_name: applicationName });
    pools.push(pool);
    return { pool, proxy };
  };

  const count = async (relation: string): Promise<number> => {
    const result = await admin.query<{ total: string }>(`select count(*)::text as total from ${relation}`);
    return Number(result.rows[0].total);
  };

  const resetDatabase = async (): Promise<void> => {
    await admin.query("drop schema if exists migration_control cascade");
    await admin.query("drop schema if exists public cascade");
    await admin.query("create schema public");
    install = await installControlSchema(admin, databaseUrl!);
    await admin.query("create table public.demo (id integer primary key, label text)");
    // PB-10 Step 3 Phase 2c final review, item 7 scenario 1: a genuinely
    // deferred FK — checked only at COMMIT, not at the INSERT itself — so a
    // migration can insert a violating row that only fails once COMMIT is
    // actually sent, producing a real server-originated 23503 ErrorResponse
    // at exactly the COMMIT boundary this suite otherwise only ever makes
    // ambiguous via the proxy.
    await admin.query("create table public.demo_parent (id integer primary key)");
    await admin.query(`
      create table public.demo_child (
        id integer primary key,
        parent_id integer not null references public.demo_parent(id) deferrable initially deferred
      )
    `);
  };

  before(async () => {
    await assertDistinctDatabases(
      { a: databaseUrl, b: process.env.TEST_DATABASE_URL },
      { a: "MIGRATION_TEST_DATABASE_URL", b: "TEST_DATABASE_URL" },
    );
    admin = new Client({ connectionString: databaseUrl, application_name: "pb10-phase2c-admin" });
    await admin.connect();
    // The runner credential must exist before any pool is constructed: every
    // pool below connects as the non-superuser execution role, and some cases
    // build their pool before calling the per-case reset helper.
    install = await installControlSchema(admin, databaseUrl!);
  });

  after(async () => {
    if (admin === undefined) return;
    await Promise.all(pools.map((pool) => pool.end()));
    await Promise.all(proxies.map((proxy) => proxy.close()));
    await resetDatabase();
    await admin.end();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  before(() => {
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);
  });
  after(() => {
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUnhandled);
    assert.deepEqual(uncaught, [], `no uncaught exception across the suite: ${String(uncaught[0])}`);
    assert.deepEqual(unhandled, [], `no unhandled rejection across the suite: ${String(unhandled[0])}`);
  });

  /** True while `promise` has not settled; used to prove a call is still pending. */
  const isPending = async (promise: Promise<unknown>): Promise<boolean> => {
    const marker = Symbol("pending");
    return await Promise.race([promise.then(() => undefined, () => undefined), Promise.resolve(marker)]) === marker;
  };

  const advisoryLockHeld = async (): Promise<boolean> => {
    const held = await admin.query<{ present: boolean }>(
      `select exists (
         select 1 from pg_locks
          where locktype = 'advisory' and classid = $1::oid and objid = $2::oid and objsubid = 2 and granted
       ) as present`,
      [1398096461, 1],
    );
    return held.rows[0].present;
  };

  /**
   * How long the ownership regression below holds mandatory persistence open
   * before asserting. The gate itself is an explicit signal, not a sleep, so
   * persistence is already unbounded — longer than any grace period that
   * could be reintroduced. Setting PB10_OWNERSHIP_HOLD_MS above a candidate
   * grace (e.g. 35000) additionally proves the property against real wall
   * clock; the default keeps the suite fast.
   */
  const ownershipHoldMs = Number(process.env.PB10_OWNERSHIP_HOLD_MS ?? 750);

  // ── transactional mode, via the real executeMigrations(pool) entry point ──

  const transactionalEntry = (id: string, filename: string, sql: string): MigrationManifestEntry => ({
    id,
    filename,
    sha256: createHash("sha256").update(sql).digest("hex"),
    lifecyclePhase: "expand",
    operationCategories: ["schema"],
    executionMode: "transactional",
    requiredRuntimeEpoch: null,
    timeouts,
  });

  /** Writes a single-migration fixture root; the caller is responsible for rm(recursive) in a finally. */
  const fixtureRootFor = async (entry: MigrationManifestEntry, sql: string): Promise<string> => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pb10-2c-"));
    await mkdir(path.join(fixtureRoot, "db", "migrations"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "db", "migrations", entry.filename), sql);
    return fixtureRoot;
  };

  // PB-10 Step 3 Phase 2c final review, item 7 scenario 1: a genuine,
  // server-originated, deferred 23503 ErrorResponse raised at COMMIT itself
  // (not at the INSERT) — the one case PostgreSQL guarantees no commit
  // occurred, proving the authoritative (not ambiguous) rollback path, and
  // simultaneously exercising the DatabaseError-provenance contract with a
  // real driver-constructed error, not a fabricated one.
  test("pg: a genuine deferred 23503 rejection at COMMIT rolls back authoritatively — never treated as ambiguous", async () => {
    const { pool } = await newProxiedPool();
    const sql = "insert into demo_child (id, parent_id) values (1, 999);\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    try {
      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot }),
        (error: unknown) => error instanceof Error && /sql_failed/.test(error.message),
      );
      assert.equal(await count("public.demo_child"), 0, "the deferred-FK violation is rolled back — the row never survives COMMIT");
      assert.equal(await count("migration_control.schema_migrations"), 0);
      const events = await admin.query<{ event_type: string; error_class: string | null; sqlstate: string | null }>(
        "select event_type, error_class, sqlstate from migration_control.migration_runs order by event_sequence",
      );
      assert.deepEqual(events.rows.map((row) => row.event_type), ["started", "heartbeat", "transaction_rolled_back", "execution_failed"]);
      assert.equal(events.rows[2].error_class, "sql_failed", "a genuine server ErrorResponse is never classified as commit_outcome_unknown");
      assert.equal(events.rows[2].sqlstate, "23503");
      assert.equal(events.rows[3].error_class, "sql_failed");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  // PB-10 Step 3 Phase 2c final review, item 7 scenario 2: a confirmed
  // (57014) wall-clock cancellation followed by a genuine, non-authoritative
  // failure of the ROLLBACK itself — the transaction's final state
  // genuinely cannot be determined, so this must durably arm
  // commit_outcome_unknown, not the narrower cancellation_unverified class.
  test("pg: a confirmed cancellation whose own ROLLBACK genuinely fails is recorded as commit_outcome_unknown, not silently as a clean rollback", async () => {
    const { pool, proxy } = await newProxiedPool();
    const sql = "select pg_sleep(5);\n";
    const shortDeadlineEntry: MigrationManifestEntry = {
      id: "0100",
      filename: "0100_demo.sql",
      sha256: createHash("sha256").update(sql).digest("hex"),
      lifecyclePhase: "expand",
      operationCategories: ["schema"],
      executionMode: "transactional",
      requiredRuntimeEpoch: null,
      timeouts: { ...timeouts, wallClockMs: 500 },
    };
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [shortDeadlineEntry] };
    const fixtureRoot = await fixtureRootFor(shortDeadlineEntry, sql);
    try {
      // Armed before the run starts: the migration's own pg_sleep(5) is what
      // gives the wall-clock supervisor time to confirm cancellation (57014)
      // well before the sleep would otherwise finish; the ROLLBACK that
      // follows confirmed cancellation is the one this proxy silently drops.
      proxy.armDropRollback();
      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot }),
        /commit_outcome_unknown/,
      );
      assert.equal(await count("migration_control.schema_migrations"), 0);
      const events = await admin.query<{ event_type: string; error_class: string | null }>(
        "select event_type, error_class from migration_control.migration_runs order by event_sequence",
      );
      assert.equal(events.rows[events.rows.length - 1].event_type, "execution_failed");
      assert.equal(events.rows[events.rows.length - 1].error_class, "commit_outcome_unknown", "a confirmed cancellation whose own ROLLBACK cannot be confirmed is exactly as ambiguous as an unconfirmed COMMIT — never merely cancellation_unverified, which would leave this migration eligible for blind replay");
      assert.ok(!events.rows.some(({ event_type }) => event_type === "transaction_rolled_back"), "rollback was never actually confirmed, so it must never be claimed");

      // A fresh attempt afterwards must be durably blocked before BEGIN.
      const freshFixtureRoot = await fixtureRootFor(shortDeadlineEntry, sql);
      try {
        await assert.rejects(
          executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: freshFixtureRoot }),
          /commit_outcome_unknown/,
        );
      } finally {
        await rm(freshFixtureRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("pg: transactional COMMIT succeeds normally through the proxy (baseline, unarmed)", async () => {
    const { pool } = await newProxiedPool();
    const sql = "insert into demo values (1, 'a');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    try {
      const report = await executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot });
      assert.equal(report.executedCount, 1);
      assert.equal(await count("public.demo"), 1);
      assert.equal(await count("migration_control.schema_migrations"), 1);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      assert.equal(pool.totalCount, pool.idleCount, "no connection leaked as still checked out");
    }
  });

  test("pg: transactional COMMIT never reaches PostgreSQL: genuinely rolled back, but ambiguous to the client — commit_outcome_unknown, no row, not retryable", async () => {
    const { pool, proxy } = await newProxiedPool();
    const sql = "insert into demo values (1, 'a');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    try {
      proxy.armDropBeforeServer();
      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot }),
        /commit_outcome_unknown/,
      );
      assert.equal(await count("public.demo"), 0, "PostgreSQL never received COMMIT: the insert is genuinely rolled back");
      assert.equal(await count("migration_control.schema_migrations"), 0, "no applied row is ever written for an unresolved ambiguity");
      const events = await admin.query<{ event_type: string; error_class: string | null }>(
        "select event_type, error_class from migration_control.migration_runs order by event_sequence",
      );
      assert.deepEqual(events.rows.map((row) => row.event_type), ["started", "heartbeat", "execution_failed"]);
      assert.equal(events.rows[2].error_class, "commit_outcome_unknown");

      // Never retryable: a second run against the same (now unarmed) proxy
      // must refuse to even send BEGIN.
      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot }),
        /commit_outcome_unknown/,
      );
      assert.equal(await count("public.demo"), 0, "the blocked retry never runs the migration SQL a second time");
      assert.equal(
        await count("migration_control.migration_runs"),
        3,
        "the guard throws before a fresh started event is ever recorded on retry",
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      assert.equal(pool.totalCount, pool.idleCount, "no connection leaked as still checked out");
    }
  });

  test("pg: transactional COMMIT succeeds on the server but the response never reaches the client: reconciliation proves it and the migration succeeds", async () => {
    const { pool, proxy } = await newProxiedPool();
    const sql = "insert into demo values (1, 'a');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    try {
      proxy.armDropBeforeClient();
      const report = await executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot });
      assert.equal(report.executedCount, 1, "reconciliation proved the migration committed");
      assert.equal(await count("public.demo"), 1, "the migration's own effect really did commit");
      assert.equal(await count("migration_control.schema_migrations"), 1, "the applied-ledger row committed atomically with it");
      const events = await admin.query<{ event_type: string }>(
        "select event_type from migration_control.migration_runs order by event_sequence",
      );
      assert.deepEqual(events.rows.map((row) => row.event_type), ["started", "heartbeat", "applied_committed", "succeeded"]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      assert.equal(pool.totalCount, pool.idleCount, "no connection leaked as still checked out");
    }
  });

  // HIGH 2: pg-pool's Pool constructor attaches an explicitly-supplied
  // `password` to `pool.options` as a *non-enumerable* property (so
  // JSON.stringify(pool)/console.log(pool) never leaks it) whenever the pool
  // was built from explicit host/user/password fields rather than a
  // connection string. `{ ...pool.options }` — a plain object spread — only
  // copies enumerable own properties, so it silently drops password in
  // exactly that configuration; a connection-string pool is unaffected,
  // since pg-pool stores that as a normal enumerable property. This is
  // exactly the gap a connection-string-only test suite (every other test
  // in this file) can never exercise, so it needs its own dedicated,
  // explicit-credential pool.
  //
  // Verifying it end-to-end requires a role PostgreSQL will actually reject
  // without the right password — trust-authenticated connections accept
  // anything, so a dropped password would silently "work" under trust auth
  // and this test would prove nothing either way. Standing up a
  // password-enforcing pg_hba.conf rule is not something this test can
  // safely or portably do to an arbitrary CI PostgreSQL service, so this is
  // gated behind PB10_PASSWORD_AUTH_TEST_DATABASE_URL — a connection string
  // for a role/host pg_hba.conf requires scram-sha-256 (or md5) password
  // authentication for. See db/control's own test infra pattern: skip with
  // a clear reason rather than fail when that isn't configured.
  const passwordAuthUrl = process.env.PB10_PASSWORD_AUTH_TEST_DATABASE_URL;
  if (!passwordAuthUrl) {
    test("pg: independentControlAcquirer preserves an explicit password against a password-enforcing role", {
      skip: "PB10_PASSWORD_AUTH_TEST_DATABASE_URL is not set; this scenario requires a role whose pg_hba.conf rule enforces scram-sha-256/md5 password authentication, which trust auth (the default for the rest of this suite) cannot exercise",
    }, () => undefined);
  } else {
    // PB-10 Step 3 Phase 2c final review: independentControlAcquirer is now
    // module-private inside execute.ts (no longer separately importable —
    // see this suite's own boundary test in migration-execute.test.ts), so
    // this proves the exact same credential-preservation fix indirectly but
    // just as conclusively: force a real ambiguous COMMIT (via the same
    // proxy technique used throughout this file) on a pool built from
    // *explicit* host/user/password fields, and prove the durable
    // commit_outcome_unknown marker actually lands — which is only possible
    // if independentControlAcquirer's internally-cloned connection
    // authenticated successfully against the password-enforcing role. A
    // dropped password (the original bug — {...pool.options} silently loses
    // pg-pool's non-enumerable explicit password field) would make the
    // fallback connection fail to authenticate, and the marker would never
    // be persisted at all.
    test("pg: a real ambiguous COMMIT is durably persisted through the independent fallback connection when the pool uses explicit host/user/password credentials", async () => {
      // The credential under test is the *execution role's*, carrying the
      // password from PB10_PASSWORD_AUTH_TEST_DATABASE_URL: that variable
      // names a host/role pair pg_hba.conf enforces password authentication
      // for, while the role itself must still be the non-superuser migration
      // runner, because verifyControlSchema refuses a superuser connection.
      // PB10_PASSWORD_AUTH_TEST_DATABASE_URL's role is only to signal that
      // this host enforces password authentication; the credential actually
      // used must be the non-superuser migration runner's own, because
      // verifyControlSchema refuses a superuser connection.
      const parsed = new URL(install.executionUrl);
      parsed.password = install.password;
      const proxy = await startCommitProxy(targetHost, targetPort);
      proxies.push(proxy);
      const pool = new Pool({
        host: "127.0.0.1",
        port: proxy.port,
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.replace(/^\//, ""),
        max: 2,
        application_name: "pb10-phase2c-explicit-credentials",
      });
      pools.push(pool);

      // Confirms the harness itself is actually exercising password
      // enforcement, not accidentally trust auth after all — if this can
      // connect with the password field deleted, the rest of the test
      // proves nothing.
      const strippedOptions = { ...pool.options };
      delete (strippedOptions as { password?: string }).password;
      const unauthenticated = new Client(strippedOptions);
      try {
        await assert.rejects(unauthenticated.connect(), /password|authentication/i, "the harness role must genuinely require a password — otherwise this test cannot distinguish a preserved password from a dropped one");
      } finally {
        await unauthenticated.end().catch(() => undefined);
      }

      // Forces the *primary* control-connection append attempt to fail —
      // precisely, not by timing — so appendAmbiguityDurably's fallback
      // (independentControlAcquirer, built from this same pool's explicit
      // credentials) is the only path that can possibly persist the marker.
      // Every other query on control passes through unchanged; only the one
      // INSERT whose own bound parameters name commit_outcome_unknown is
      // ever rejected, identified by inspecting the actual parameter values
      // (never by racing when it happens to run).
      const originalConnect = pool.connect.bind(pool);
      let controlClient: import("pg").PoolClient | undefined;
      // @ts-expect-error narrow test-only override of pool.connect's overloaded signature
      pool.connect = async (...args: unknown[]) => {
        const client = await (originalConnect as (...a: unknown[]) => Promise<import("pg").PoolClient>)(...args);
        if (!controlClient) {
          controlClient = client;
          const originalQuery = client.query.bind(client);
          // @ts-expect-error narrow test-only override of PoolClient.query's overloaded signature
          client.query = (...queryArgs: unknown[]) => {
            const values = queryArgs[1] as unknown[] | undefined;
            if (Array.isArray(values) && values.includes("commit_outcome_unknown")) {
              return Promise.reject(new Error("test-forced failure of the primary control-connection ambiguity append"));
            }
            return (originalQuery as (...a: unknown[]) => unknown)(...queryArgs);
          };
        }
        return client;
      };

      const sql = "insert into demo values (1, 'a');\n";
      const entry = transactionalEntry("0100", "0100_demo.sql", sql);
      const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
      const fixtureRoot = await fixtureRootFor(entry, sql);
      try {
        proxy.armDropBeforeServer();
        await assert.rejects(
          executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot }),
          /commit_outcome_unknown/,
        );
        const persisted = await admin.query<{ total: string }>(
          "select count(*)::text as total from migration_control.migration_runs where event_type = 'execution_failed' and error_class = 'commit_outcome_unknown'",
        );
        assert.equal(persisted.rows[0].total, "1", "the durable marker landed through the independent fallback connection — only possible if it authenticated successfully with the preserved explicit password, since the primary control-connection attempt was forced to fail");
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    });
  }

  // Phase 2c blocker 6, real installed pg 8.22.0 / pg-pool 3.14.0: pg-pool's
  // own idleListener (_release/makeIdleListener) re-attaches a client
  // 'error' listener unconditionally — even on a *destructive* release — so
  // a genuinely delayed second error on the destroyed execution client fires
  // pg-pool's own listener too, which excises the client and then always
  // calls `pool.emit('error', ...)`. Without a pool-level 'error' listener
  // (which this suite's pool, like production's, never installs), Node
  // treats that as an uncaught exception. This proves execute.ts's own
  // internal guard (installed once per pool object, never by the caller)
  // absorbs it instead — no uncaughtException, no leaked waiter, no
  // reusable dead client — using the real installed driver end to end, not
  // a mock of pg-pool's internals.
  test("pg: a genuinely delayed second error on a destructively-released execution client, well after the run has already settled, never becomes an uncaught exception", async () => {
    const { pool, proxy } = await newProxiedPool();
    const sql = "insert into demo values (1, 'a');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    let capturedExecution: PoolClient | undefined;
    const originalConnect = pool.connect.bind(pool);
    let connectCount = 0;
    // @ts-expect-error narrow test-only override of pool.connect's overloaded signature
    pool.connect = async (...args: unknown[]) => {
      connectCount += 1;
      const client = await (originalConnect as (...a: unknown[]) => Promise<PoolClient>)(...args);
      if (connectCount === 2) capturedExecution = client;
      return client;
    };
    try {
      proxy.armDropBeforeServer();
      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot }),
        /commit_outcome_unknown/,
      );
      assert.ok(capturedExecution, "the execution client was captured");

      // The run has fully settled (its promise already rejected) before this
      // fires — a genuinely delayed error, not one raced against the run's
      // own in-flight handling.
      await delay(100);
      capturedExecution!.emit("error", new Error("delayed second socket error, well after settlement"));
      await delay(150);

      assert.equal(pool.waitingCount, 0, "no leaked pool waiter");
      assert.equal(pool.totalCount, pool.idleCount, "no client left checked out or otherwise unaccounted for");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  // PB-10 Step 3 Phase 2c final review, item 7 scenarios 10/11: a real armed
  // commit_outcome_unknown, produced by the real production path (the proxy
  // dropping COMMIT before it ever reaches PostgreSQL, exactly as scenario
  // 2 in migration-execute-commit-ambiguity.pg.test.ts above), then an
  // operator's manual resolution — exact identity succeeds, every mutated
  // field fails — validated against the real mr_metadata_ck constraint and
  // the real isValidResolution logic together, not either in isolation.
  // PB-10 Step 3 Phase 2c final review, item 7 scenario 5 (enhanced): the
  // full production entry point, executeMigrations(pool) itself (via
  // executeMigrationsForTest, its approved test adapter), under the exact
  // production constraint (pool max: 2 — control + execution occupy both
  // slots for the whole run) with a genuine ambiguity forcing the durable
  // independent-connection fallback, *and* an ordinary third caller already
  // queued behind the two exhausted slots the entire time. Proves the whole
  // real path — not just independentControlAcquirer in isolation — never
  // deadlocks under contention.
  test("pg: the full production path persists a durable ambiguity marker and resolves a queued ordinary waiter, under pool max=2 contention throughout", async () => {
    const { pool, proxy } = await newProxiedPool(2);
    const sql = "insert into demo values (1, 'a');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    try {
      proxy.armDropBeforeServer();
      // Deterministic synchronization, not a timed delay: pool.connect is
      // wrapped to notice the moment the run's *own* second connection
      // (execution, after control) actually resolves, so the ordinary third
      // caller is issued only once both of the run's slots are genuinely
      // held — proving it is truly queued *behind* a fully-occupied pool,
      // never racing to grab a slot the run itself was still trying to
      // acquire (which would prove nothing, or deadlock outright).
      const originalConnect = pool.connect.bind(pool);
      let connectCount = 0;
      let bothAcquired!: () => void;
      const bothAcquiredPromise = new Promise<void>((resolve) => { bothAcquired = resolve; });
      // @ts-expect-error narrow test-only override of pool.connect's overloaded signature
      pool.connect = async (...args: unknown[]) => {
        connectCount += 1;
        const client = await (originalConnect as (...a: unknown[]) => Promise<PoolClient>)(...args);
        if (connectCount === 2) bothAcquired();
        return client;
      };

      const runPromise = executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot });
      void runPromise.catch(() => undefined);
      await bothAcquiredPromise;
      assert.equal(pool.totalCount, 2, "both of the run's own slots are held before the ordinary waiter ever asks");
      assert.equal(pool.idleCount, 0);
      const queuedWaiter = pool.connect();
      await assert.rejects(runPromise, /commit_outcome_unknown/);
      const persisted = await admin.query<{ total: string }>(
        "select count(*)::text as total from migration_control.migration_runs where event_type = 'execution_failed' and error_class = 'commit_outcome_unknown'",
      );
      assert.equal(persisted.rows[0].total, "1", "the ambiguity is durably persisted despite both pool slots being occupied for the whole run");
      const queued = await queuedWaiter;
      try {
        const result = await queued.query("select 1 as one");
        assert.equal(result.rows[0].one, 1, "the ordinary queued waiter is eventually served once the run's own slots are released — never starved by the independent fallback connection");
      } finally {
        queued.release();
      }
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.totalCount, pool.idleCount);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  /**
   * Forces the *primary* control-connection append of the durable ambiguity
   * marker to fail, precisely — by inspecting the actual bound parameter
   * values, never by racing when it happens to run — so
   * appendAmbiguityDurably's independent fallback is the only path that can
   * possibly persist it. `onIntercept` runs immediately before that append is
   * refused, which is how a test can make the failure a *genuine* transport
   * loss on the pinned control connection rather than a synthetic rejection.
   */
  const failPrimaryAmbiguityAppend = (pool: Pool, onIntercept?: (control: PoolClient) => void): (() => PoolClient | undefined) => {
    const originalConnect = pool.connect.bind(pool);
    let control: PoolClient | undefined;
    // @ts-expect-error narrow test-only override of pool.connect's overloaded signature
    pool.connect = async (...args: unknown[]) => {
      const client = await (originalConnect as (...a: unknown[]) => Promise<PoolClient>)(...args);
      if (!control) {
        control = client;
        const originalQuery = client.query.bind(client);
        // @ts-expect-error narrow test-only override of PoolClient.query's overloaded signature
        client.query = (...queryArgs: unknown[]) => {
          const values = queryArgs[1] as unknown[] | undefined;
          if (Array.isArray(values) && values.includes("commit_outcome_unknown")) {
            onIntercept?.(client);
            return Promise.reject(new Error("the primary control-connection ambiguity append could not be carried"));
          }
          return (originalQuery as (...a: unknown[]) => unknown)(...queryArgs);
        };
      }
      return client;
    };
    return () => control;
  };

  // PB-10 Step 3 Phase 2c final review, item 7 scenario 12 — the second
  // reproduced release blocker. withSchemaAdvisoryLock races the migration
  // action against its pinned control connection's own 'error' event so it
  // never waits forever on a dead connection. But losing that connection is
  // exactly when the run is performing its *mandatory* durable work: arming
  // the commit_outcome_unknown replay guard through an independent
  // connection the failure does not touch. Returning from that race while
  // the append is still in flight let executeMigrations() reject before the
  // guard was durable — a window in which a fresh run would replay a
  // migration whose outcome is genuinely unknown. The marker is therefore
  // asserted with no delay whatsoever after the rejection: "it showed up
  // shortly afterwards" is precisely the defect.
  test("pg: a genuine control-connection loss during ambiguity-marker persistence never lets executeMigrations() reject before the marker is durable", async () => {
    const { pool, proxy } = await newProxiedPool(3);
    const sql = "insert into demo values (1, 'a');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    try {
      proxy.armDropBeforeServer();
      const controlClient = failPrimaryAmbiguityAppend(pool, (control) => {
        // A real transport-level loss of the pinned control connection — the
        // socket itself is destroyed, so pg raises the client's own 'error'
        // event, which is the exact signal withSchemaAdvisoryLock races
        // against. Not an emit() of a fabricated event.
        const stream = (control as unknown as { connection?: { stream?: { destroy(error?: Error): void } } }).connection?.stream;
        assert.ok(stream, "the control connection's socket is reachable for a genuine transport-loss injection");
        stream.destroy(new Error("control connection lost while the ambiguity marker was being persisted"));
      });

      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot }),
        /commit_outcome_unknown|control_connection_lost/,
      );
      // Read back immediately — no delay, no retry, no polling.
      const persisted = await admin.query<{ total: string }>(
        "select count(*)::text as total from migration_control.migration_runs where event_type = 'execution_failed' and error_class = 'commit_outcome_unknown'",
      );
      assert.equal(
        persisted.rows[0].total,
        "1",
        "the replay guard was already durable at the instant the public call rejected — the caller can never observe a rejection while the marker is still in flight",
      );
      assert.equal(await count("migration_control.schema_migrations"), 0);

      // Remediation 5: the pinned control connection was destructively
      // released. A genuinely delayed second 'error' on it — one root socket
      // failure can surface as both a query rejection and a raw socket event
      // — must be observable as a sanitized diagnostic, never silently
      // swallowed by an anonymous no-op and never an uncaught exception.
      const control = controlClient();
      assert.ok(control, "the control connection was captured");
      const warnings: Error[] = [];
      const onWarning = (warning: Error): void => { warnings.push(warning); };
      process.on("warning", onWarning);
      try {
        await delay(100);
        control!.emit("error", new Error(`delayed second socket error for ${databaseUrl} with password hunter2`));
        await delay(150);
      } finally {
        process.removeListener("warning", onWarning);
      }
      const reported = warnings.filter((warning) => (warning as Error & { code?: string }).code === "PB10_MIGRATION_POOL_ERROR");
      assert.equal(
        reported.length,
        1,
        "one root connection failure reports exactly once, even though both the runner's own listener and pg-pool's re-attached idle listener observe it",
      );
      assert.doesNotMatch(reported[0].message, /hunter2|password|postgres:\/\//, "the diagnostic carries only a whitelisted error code — never the raw message, connection string, or credentials");
      assert.deepEqual(uncaught, [], "and it never becomes an uncaught exception");

      // And it really is armed: a fresh attempt is blocked before BEGIN.
      const freshFixtureRoot = await fixtureRootFor(entry, sql);
      try {
        await assert.rejects(
          executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: freshFixtureRoot }),
          /commit_outcome_unknown/,
        );
      } finally {
        await rm(freshFixtureRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  // PB-10 Step 3 Phase 2c final review, item 7 scenarios 4 and 5: the
  // connection-string credential path (every production pool built from
  // DATABASE_URL) proving the independent fallback under the exact
  // production constraint — pool max: 2, both slots held by control and
  // execution for the entire run — with the primary append forced to fail so
  // the fallback is genuinely the only path that can persist the marker. The
  // waiter test above proves no deadlock; this proves the fallback actually
  // carries the write under the same contention.
  test("pg: under pool max=2 contention the independent connection-string fallback is what durably persists the marker, with the primary append forced to fail", async () => {
    const { pool, proxy } = await newProxiedPool(2);
    const sql = "insert into demo values (1, 'a');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    try {
      proxy.armDropBeforeServer();
      failPrimaryAmbiguityAppend(pool);
      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot }),
        /commit_outcome_unknown/,
      );
      const persisted = await admin.query<{ total: string }>(
        "select count(*)::text as total from migration_control.migration_runs where event_type = 'execution_failed' and error_class = 'commit_outcome_unknown'",
      );
      assert.equal(persisted.rows[0].total, "1", "the marker landed through the independent connection-string fallback while both of the pool's own slots were occupied");
      assert.equal(await count("migration_control.schema_migrations"), 0);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  // PB-10 Step 3 Phase 2c final review, blocker 1 (CRITICAL): durable
  // ambiguity-marker ownership must not expire.
  //
  // Once a COMMIT outcome is uncertain, everything this run owns — the
  // advisory lock, the pinned control connection, and the caller's own
  // knowledge of the outcome — is what keeps a second execution from
  // replaying a migration whose real outcome is unknown. Ownership may end
  // only once the replay-blocking marker is confirmed persisted. A timed
  // grace could expire and hand ownership back with the marker still in
  // flight; there is no timer left to expire.
  //
  // The gate here is a real, controlled one: the fallback connection's actual
  // marker INSERT is held at the wire by the proxy, so PostgreSQL genuinely
  // has not seen it, for exactly as long as this test chooses — not a sleep,
  // and unbounded by construction. The control connection's own 'error' event
  // is raised on the client (the precise signal withSchemaAdvisoryLock reacts
  // to) without killing its backend, so the advisory lock stays genuinely
  // held server-side and ownership is observable at the database rather than
  // being trivially ended by PostgreSQL reclaiming a dead backend's lock. The
  // genuine socket-death variant is covered separately above.
  test("pg: ownership is never released while mandatory ambiguity persistence is still in flight — the call stays pending, the lock stays held, and no second execution can reach BEGIN", async () => {
    // Their own application_name, so the session-leak assertion at the end
    // counts exactly this test's connections and nothing else in the suite.
    const ownershipApplication = "pb10-phase2c-ownership";
    const { pool, proxy } = await newProxiedPool(3, ownershipApplication);
    const sql = "insert into demo values (1, 'a');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    const second = await newProxiedPool(3, ownershipApplication);
    const secondFixtureRoot = await fixtureRootFor(entry, sql);
    let gate: { engaged: Promise<void>; release: () => void } | undefined;
    try {
      proxy.armDropBeforeServer();
      // The primary control-connection append is refused precisely (by bound
      // parameter values, never by timing). At that exact moment the control
      // connection is declared lost and the fallback's own INSERT — the next
      // statement on the wire carrying these bytes — is gated.
      failPrimaryAmbiguityAppend(pool, (control) => {
        gate = proxy.armStallFrontendContaining("commit_outcome_unknown");
        control.emit("error", new Error("control connection lost while the ambiguity marker was being persisted"));
      });

      const run = executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot });
      void run.catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (gate) { clearInterval(poll); resolve(); }
        }, 10);
        run.then(() => { clearInterval(poll); reject(new Error("the run settled before the ambiguity gate was ever armed")); },
          () => { clearInterval(poll); reject(new Error("the run settled before the ambiguity gate was ever armed")); });
      });
      await gate!.engaged;

      // ── mandatory persistence is now genuinely in flight, indefinitely ──
      const heldUntil = Date.now() + ownershipHoldMs;
      while (Date.now() < heldUntil) await delay(50);

      assert.ok(await isPending(run), "the original executeMigrations call must still be pending while the marker is still being persisted");
      assert.ok(await advisoryLockHeld(), "advisory ownership must still be held while the marker is still being persisted");
      const markerWhileGated = await admin.query<{ total: string }>(
        "select count(*)::text as total from migration_control.migration_runs where error_class = 'commit_outcome_unknown'",
      );
      assert.equal(markerWhileGated.rows[0].total, "0", "the marker genuinely has not been persisted yet — this is the window the invariant protects");

      // A second execution, started right now, must not reach BEGIN.
      const replay = executeMigrationsForTest(second.pool, { manifest, identity, repositoryRoot: secondFixtureRoot });
      void replay.catch(() => undefined);
      await delay(300);
      assert.ok(await isPending(replay), "the second execution is blocked behind the advisory lock the first run still owns");
      const eventsWhileGated = await admin.query<{ event_type: string }>(
        "select event_type from migration_control.migration_runs order by event_sequence",
      );
      assert.deepEqual(eventsWhileGated.rows.map((row) => row.event_type), ["started", "heartbeat"], "the second execution wrote nothing beyond the first run's own durable start and transaction binding: it never reached BEGIN, and the first run has claimed no outcome");
      assert.equal(await count("public.demo"), 0, "no migration SQL has been replayed");
      assert.equal(await count("migration_control.schema_migrations"), 0);

      // ── release the gate: persistence completes, and only then ownership ends ──
      gate!.release();
      await assert.rejects(run, /commit_outcome_unknown/);
      // Read back immediately: no delay, no polling.
      const persisted = await admin.query<{ total: string }>(
        "select count(*)::text as total from migration_control.migration_runs where event_type = 'execution_failed' and error_class = 'commit_outcome_unknown'",
      );
      assert.equal(persisted.rows[0].total, "1", "the durable marker existed before the original call rejected — never written after ownership ended");

      // The second execution now takes the lock and is refused by the marker,
      // before BEGIN, without writing an event of its own.
      await assert.rejects(replay, /commit_outcome_unknown/);
      const finalEvents = await admin.query<{ event_type: string }>(
        "select event_type from migration_control.migration_runs order by event_sequence",
      );
      assert.deepEqual(finalEvents.rows.map((row) => row.event_type), ["started", "heartbeat", "execution_failed"], "no success and no rollback was ever claimed, and the blocked replay added nothing");
      assert.equal(await count("public.demo"), 0, "the migration SQL was never replayed");
      assert.equal(await count("migration_control.schema_migrations"), 0);

      // Exactly-once cleanup: no client, waiter, or ad hoc fallback socket
      // outlives either run.
      await delay(250);
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.totalCount, pool.idleCount, "no connection left checked out by the first run");
      assert.equal(second.pool.waitingCount, 0);
      assert.equal(second.pool.totalCount, second.pool.idleCount, "no connection left checked out by the second run");
      const sessions = await admin.query<{ total: string }>(
        "select count(*)::text as total from pg_stat_activity where application_name = $1",
        [ownershipApplication],
      );
      assert.equal(
        Number(sessions.rows[0].total),
        pool.totalCount + second.pool.totalCount,
        "the independently acquired fallback connection was closed exactly once and left no session behind",
      );
      assert.deepEqual(unhandled, [], "no promise was left unowned across the gated window");
      assert.deepEqual(uncaught, []);
    } finally {
      gate?.release();
      await rm(fixtureRoot, { recursive: true, force: true });
      await rm(secondFixtureRoot, { recursive: true, force: true });
    }
  });

  /** Polls `condition` until true; throws rather than hanging if it never becomes true. */
  const waitUntil = async (condition: () => Promise<boolean> | boolean, what: string, budgetMs = 10_000): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (await condition()) return;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
      await delay(25);
    }
  };

  /**
   * Genuinely terminates the PostgreSQL backend that currently holds the
   * schema advisory lock — `pg_terminate_backend`, not a JavaScript
   * `emit("error")`. PostgreSQL releases a session-scoped advisory lock the
   * instant the session dies, which is the whole point: no amount of
   * in-process awaiting can preserve database-visible ownership afterwards.
   */
  const terminateAdvisoryLockHolder = async (): Promise<number[]> => {
    const result = await admin.query<{ pid: number }>(
      `select a.pid
         from pg_locks l
         join pg_stat_activity a on a.pid = l.pid
        where l.locktype = 'advisory' and l.classid = $1::oid and l.objid = $2::oid and l.objsubid = 2 and l.granted`,
      [1398096461, 1],
    );
    const pids = result.rows.map((row) => row.pid);
    for (const pid of pids) await admin.query("select pg_terminate_backend($1)", [pid]);
    return pids;
  };

  // PB-10 Step 3 Phase 2c final review, CRITICAL C1. The ownership regression
  // above keeps the lock-holding backend alive on purpose (it emits the
  // client's 'error' event without killing the session), so it proves the
  // in-process half of the invariant only. This one removes that crutch: the
  // backend holding the advisory lock is genuinely terminated, PostgreSQL
  // itself drops the lock, and a *second, independent* execution is started
  // while the first run's mandatory marker persistence is still demonstrably
  // in flight at the wire. With no lock left to fence it, the only thing that
  // can stop the replay is a durable, database-visible fact — the first run's
  // own `started` row, committed before it ever sent BEGIN.
  test("pg: a genuinely terminated control backend releases the advisory lock, and a second execution started while the marker is still in flight still cannot reach BEGIN", async () => {
    const application = "pb10-phase2c-c1-owner";
    const { pool, proxy } = await newProxiedPool(3, application);
    const sql = "insert into demo values (1, 'a');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    const second = await newProxiedPool(3, "pb10-phase2c-c1-replay");
    const secondFixtureRoot = await fixtureRootFor(entry, sql);
    let gate: { engaged: Promise<void>; release: () => void } | undefined;
    let terminated: number[] = [];
    try {
      proxy.armDropBeforeServer();
      failPrimaryAmbiguityAppend(pool, () => {
        // Gate the fallback's own INSERT at the wire first, so mandatory
        // persistence is genuinely in flight for as long as this test
        // chooses, then kill the lock-holding backend for real.
        gate = proxy.armStallFrontendContaining("commit_outcome_unknown");
        void terminateAdvisoryLockHolder().then((pids) => { terminated = pids; });
      });

      const run = executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot });
      void run.catch(() => undefined);
      await waitUntil(() => gate !== undefined, "the ambiguity gate to be armed");
      await gate!.engaged;

      // ── 1. PostgreSQL really did release the original session's lock ──
      await waitUntil(async () => !(await advisoryLockHeld()), "PostgreSQL to release the terminated session's advisory lock");
      assert.equal(terminated.length, 1, "exactly the one backend holding the advisory lock was terminated");
      assert.equal(await advisoryLockHeld(), false, "the session-scoped advisory lock is gone with its session — no lock-based fence remains");

      // ── 2. mandatory persistence is still demonstrably in flight ──
      assert.ok(await isPending(run), "the first execution has not settled: its marker persistence is still gated at the wire");
      const markerWhileGated = await admin.query<{ total: string }>(
        "select count(*)::text as total from migration_control.migration_runs where error_class = 'commit_outcome_unknown'",
      );
      assert.equal(markerWhileGated.rows[0].total, "0", "the durable marker genuinely does not exist yet — this is the exact replay window C1 describes");

      // ── 3. a second execution, started now, must not reach BEGIN ──
      const replay = executeMigrationsForTest(second.pool, { manifest, identity, repositoryRoot: secondFixtureRoot });
      await assert.rejects(replay, /commit_outcome_unknown/, "the second execution is fenced by the durable started row, not by a lock it could freely take");
      assert.equal(await count("public.demo"), 0, "no migration SQL was replayed: BEGIN was never reached");
      assert.equal(await count("migration_control.schema_migrations"), 0);
      const eventsWhileGated = await admin.query<{ event_type: string }>(
        "select event_type from migration_control.migration_runs order by event_id",
      );
      assert.deepEqual(
        eventsWhileGated.rows.map((row) => row.event_type),
        ["started", "heartbeat"],
        "the blocked replay wrote nothing at all: only the first run's own durable start and transaction binding exist, and it has still claimed no outcome",
      );

      // ── 4. let persistence complete; only then does the first call settle ──
      gate!.release();
      await assert.rejects(run, /commit_outcome_unknown|control_connection_lost/);
      const persisted = await admin.query<{ total: string }>(
        "select count(*)::text as total from migration_control.migration_runs where event_type = 'execution_failed' and error_class = 'commit_outcome_unknown'",
      );
      assert.equal(persisted.rows[0].total, "1", "the exact terminal state became durable");

      // ── 5. replay stays blocked, now on the exactly-correlated marker ──
      const thirdFixtureRoot = await fixtureRootFor(entry, sql);
      try {
        await assert.rejects(
          executeMigrationsForTest(second.pool, { manifest, identity, repositoryRoot: thirdFixtureRoot }),
          /commit_outcome_unknown/,
        );
      } finally {
        await rm(thirdFixtureRoot, { recursive: true, force: true });
      }

      // ── 6. no false applied / succeeded / rolled-back event, ever ──
      const finalEvents = await admin.query<{ event_type: string }>(
        "select event_type from migration_control.migration_runs order by event_id",
      );
      assert.deepEqual(finalEvents.rows.map((row) => row.event_type), ["started", "heartbeat", "execution_failed"]);
      assert.equal(await count("public.demo"), 0);
      assert.equal(await count("migration_control.schema_migrations"), 0);
      assert.deepEqual(unhandled, []);
      assert.deepEqual(uncaught, []);
    } finally {
      gate?.release();
      await rm(fixtureRoot, { recursive: true, force: true });
      await rm(secondFixtureRoot, { recursive: true, force: true });
    }
  });

  test("pg: manual resolution — exact structured identity clears the guard; every mutated field still fails", async () => {
    const { pool, proxy } = await newProxiedPool();
    const sql = "insert into demo values (1, 'a');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    try {
      // Arm a real commit_outcome_unknown through the real production path
      // — the proxy drops the client's own "commit" before it ever reaches
      // PostgreSQL, exactly as the "COMMIT never reaches PostgreSQL" baseline
      // test above.
      proxy.armDropBeforeServer();
      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot }),
        /commit_outcome_unknown/,
      );
      // PB-10 Step 3 Phase 2c final review, PART 1/5: the attempt's immutable
      // identity is established by its *started* row — that is the event id,
      // run id, runner id and checksum a resolution must name, not the
      // failure row's.
      const armedRow = await admin.query<{ event_id: string; run_id: string; runner_id: string; checksum_sha256: string }>(
        `select started.event_id::text, started.run_id::text, started.runner_id,
                started.metadata ->> 'checksum_sha256' as checksum_sha256
           from migration_control.migration_runs started
           join migration_control.migration_runs failure
             on failure.run_id = started.run_id and failure.migration_id = started.migration_id
          where started.event_type = 'started'
            and failure.event_type = 'execution_failed'
            and failure.error_class = 'commit_outcome_unknown'`,
      );
      assert.equal(armedRow.rows.length, 1);
      // pg returns bigint columns as strings by default; mr_metadata_ck
      // requires resolved_event_id to be a genuine JSON number, so this must
      // be a real number here, not the string the driver hands back.
      const armed = { ...armedRow.rows[0], event_id: Number(armedRow.rows[0].event_id) };

      const validRow = {
        run_id: randomUUID(),
        source_git_sha: identity.sourceGitSha,
        executor_image_digest: identity.executorImageDigest,
        runner_id: "pb10-operator-on-call",
        metadata: {
          execution_mode: "transactional",
          migration_filename: entry.filename,
          migration_ordinal: 1,
          reclaim_reason: "operator_approved",
          checksum_sha256: entry.sha256,
          resolved_event_id: armed.event_id,
          resolved_run_id: armed.run_id,
          resolved_runner_id: armed.runner_id,
          resolved_checksum_sha256: armed.checksum_sha256,
        },
      };

      const mutations: Array<[string, Record<string, unknown>]> = [
        ["wrong resolved_checksum_sha256", { ...validRow, metadata: { ...validRow.metadata, resolved_checksum_sha256: "1".repeat(64) } }],
        ["wrong resolved_event_id", { ...validRow, metadata: { ...validRow.metadata, resolved_event_id: armed.event_id + 999 } }],
        ["wrong resolved_run_id", { ...validRow, metadata: { ...validRow.metadata, resolved_run_id: randomUUID() } }],
        // PART 5: the resolution's own runner_id names its author and can never
        // substitute for the target attempt's persisted runner identity.
        ["wrong resolved_runner_id", { ...validRow, metadata: { ...validRow.metadata, resolved_runner_id: "pb10-some-other-runner" } }],
        ["resolved_runner_id copied from the resolution's own author", { ...validRow, metadata: { ...validRow.metadata, resolved_runner_id: validRow.runner_id } }],
        ["missing resolved_runner_id", { ...validRow, metadata: withoutKey(validRow.metadata, "resolved_runner_id") }],
        ["malformed resolved_runner_id", { ...validRow, metadata: { ...validRow.metadata, resolved_runner_id: "not a runner id!" } }],
        ["wrong migration_filename", { ...validRow, metadata: { ...validRow.metadata, migration_filename: "9999_other.sql" } }],
        ["wrong migration_ordinal", { ...validRow, metadata: { ...validRow.metadata, migration_ordinal: 2 } }],
        ["wrong execution_mode", { ...validRow, metadata: { ...validRow.metadata, execution_mode: "batched" } }],
        ["wrong source_git_sha", { ...validRow, source_git_sha: "1".repeat(40) }],
        ["wrong executor_image_digest", { ...validRow, executor_image_digest: `sha256:${"1".repeat(64)}` }],
        ["malformed resolved_run_id", { ...validRow, metadata: { ...validRow.metadata, resolved_run_id: "not-a-uuid" } }],
        ["placeholder runner_id", { ...validRow, runner_id: "" }],
        // Scenario 11, against real PostgreSQL rather than a fake pool: every
        // *missing* required resolution field, every *malformed* one, and an
        // *additional* unexpected key. Each must fail — either refused at
        // INSERT by mr_metadata_ck (defense in depth) or accepted and then
        // rejected by isValidResolution — and the guard must survive all of
        // them.
        ["missing resolved_event_id", { ...validRow, metadata: withoutKey(validRow.metadata, "resolved_event_id") }],
        ["missing resolved_run_id", { ...validRow, metadata: withoutKey(validRow.metadata, "resolved_run_id") }],
        ["missing resolved_checksum_sha256", { ...validRow, metadata: withoutKey(validRow.metadata, "resolved_checksum_sha256") }],
        ["missing reclaim_reason", { ...validRow, metadata: withoutKey(validRow.metadata, "reclaim_reason") }],
        ["missing migration_filename", { ...validRow, metadata: withoutKey(validRow.metadata, "migration_filename") }],
        ["missing migration_ordinal", { ...validRow, metadata: withoutKey(validRow.metadata, "migration_ordinal") }],
        ["missing execution_mode", { ...validRow, metadata: withoutKey(validRow.metadata, "execution_mode") }],
        ["additional unexpected metadata key", { ...validRow, metadata: { ...validRow.metadata, operator_note: "approved in incident 42" } }],
        ["malformed resolved_event_id (string, not a JSON number)", { ...validRow, metadata: { ...validRow.metadata, resolved_event_id: String(armed.event_id) } }],
        ["malformed resolved_checksum_sha256 (not 64 hex)", { ...validRow, metadata: { ...validRow.metadata, resolved_checksum_sha256: "not-a-checksum" } }],
        ["malformed migration_ordinal (string, not a JSON number)", { ...validRow, metadata: { ...validRow.metadata, migration_ordinal: "1" } }],
        ["malformed reclaim_reason (unknown value)", { ...validRow, metadata: { ...validRow.metadata, reclaim_reason: "because_i_said_so" } }],
      ];

      for (const [label, row] of mutations) {
        // A structurally malformed mutation (a malformed UUID, an empty
        // placeholder runner_id) can be rejected by mr_metadata_ck/mr_runner_ck
        // themselves at INSERT time — defense in depth doing its job. Either
        // outcome equally proves the guard was never cleared: the row never
        // even landed, or it landed and isValidResolution still rejected it.
        let inserted = true;
        try {
          await insertStaleReclaimed(row);
        } catch (error) {
          inserted = false;
          assert.match(String(error), /mr_metadata_ck|mr_runner_ck|mr_source_sha_ck|mr_image_digest_ck/, `unexpected insert failure for ${label}: ${String(error)}`);
        }
        if (!inserted) continue;
        const rejectedFixtureRoot = await fixtureRootFor(entry, sql);
        try {
          await assert.rejects(
            executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: rejectedFixtureRoot }),
            /commit_outcome_unknown/,
            `resolution with ${label} must not clear the guard`,
          );
        } finally {
          await rm(rejectedFixtureRoot, { recursive: true, force: true });
        }
      }

      // Finally, the exact, unmutated resolution clears it.
      await insertStaleReclaimed(validRow);
      const acceptedFixtureRoot = await fixtureRootFor(entry, sql);
      try {
  const report = await executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: acceptedFixtureRoot });
        assert.equal(report.executedCount, 1, "the exact resolution clears the guard and the migration runs to completion");
        assert.equal(await count("public.demo"), 1);
      } finally {
        await rm(acceptedFixtureRoot, { recursive: true, force: true });
      }

      function withoutKey(metadata: Record<string, unknown>, key: string): Record<string, unknown> {
        const copy = { ...metadata };
        delete copy[key];
        return copy;
      }

      async function insertStaleReclaimed(row: { run_id: string; source_git_sha: string; executor_image_digest: string; runner_id: string; metadata: Record<string, unknown> }): Promise<void> {
        await admin.query(
          `insert into migration_control.migration_runs
             (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
           values ($1, $2,
             (select coalesce(max(event_sequence), 0) + 1 from migration_control.migration_runs where run_id = $1),
             'stale_reclaimed', $3, $4, $5, $6::jsonb)`,
          [row.run_id, entry.id, row.runner_id, row.source_git_sha, row.executor_image_digest, JSON.stringify(row.metadata)],
        );
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  // ── PB-10 Step 3 Phase 2c final review, CRITICAL C1 / HIGH 3 ──────────────
  // Both prove the history evaluation through the real executeMigrations(pool)
  // entry point against real PostgreSQL, not through a unit-level helper.

  /** Writes one historical migration_runs row exactly as a prior process would have. */
  const insertHistoricalEvent = async (row: {
    run_id: string;
    migration_id: string;
    event_sequence: number;
    event_type: string;
    runner_id: string | null;
    error_class?: string | null;
    metadata: Record<string, unknown>;
  }): Promise<number> => {
    const inserted = await admin.query<{ event_id: string }>(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, error_class, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       returning event_id::text`,
      [
        row.run_id,
        row.migration_id,
        row.event_sequence,
        row.event_type,
        row.runner_id,
        identity.sourceGitSha,
        identity.executorImageDigest,
        row.error_class ?? null,
        JSON.stringify(row.metadata),
      ],
    );
    return Number(inserted.rows[0].event_id);
  };

  test("pg: C1 — a newer run's complete success never clears an older unresolved attempt, and only that attempt's own exact resolution does", async () => {
    const { pool } = await newProxiedPool();
    const sql = "insert into demo values (11, 'c1');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const runA = randomUUID();
    const runB = randomUUID();
    const common = { execution_mode: "transactional", migration_filename: entry.filename, migration_ordinal: 1 };
    // Run A: started, then nothing — the process died mid-flight.
    const armedEventId = await insertHistoricalEvent({
      run_id: runA, migration_id: entry.id, event_sequence: 1, event_type: "started",
      runner_id: "pb10-crashed-runner", metadata: { ...common, checksum_sha256: entry.sha256 },
    });
    // Run B: a later run whose rows *say* it succeeded — a perfectly correlated
    // applied_committed + succeeded pair, with no committed applied-ledger row
    // behind it. CRITICAL 1: that pair is a label, not proof, so it clears
    // neither run B nor (a fortiori) run A.
    await insertHistoricalEvent({
      run_id: runB, migration_id: entry.id, event_sequence: 1, event_type: "started",
      runner_id: "pb10-later-runner", metadata: { ...common, checksum_sha256: entry.sha256 },
    });
    await insertHistoricalEvent({
      run_id: runB, migration_id: entry.id, event_sequence: 2, event_type: "applied_committed",
      runner_id: "pb10-later-runner", metadata: { ...common, checksum_sha256: entry.sha256 },
    });
    await insertHistoricalEvent({
      run_id: runB, migration_id: entry.id, event_sequence: 3, event_type: "succeeded",
      runner_id: "pb10-later-runner", metadata: { ...common, checksum_sha256: entry.sha256, duration_ms: 12 },
    });

    const blockedRoot = await fixtureRootFor(entry, sql);
    try {
      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: blockedRoot }),
        /commit_outcome_unknown/,
        "run A stays represented and replay-blocking even though run B succeeded afterwards",
      );
      assert.equal(await count("public.demo"), 0, "no migration SQL ran while an older attempt was unresolved");
    } finally {
      await rm(blockedRoot, { recursive: true, force: true });
    }

    // A resolution naming run B clears run B — and run A alone still blocks.
    const resolutionRunId = randomUUID();
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
       values ($1, $2, 1, 'stale_reclaimed', $3, $4, $5, $6::jsonb)`,
      [resolutionRunId, entry.id, "pb10-operator-on-call", identity.sourceGitSha, identity.executorImageDigest, JSON.stringify({
        ...common,
        reclaim_reason: "operator_approved",
        checksum_sha256: entry.sha256,
        resolved_event_id: armedEventId + 1,
        resolved_run_id: runB,
        resolved_runner_id: "pb10-later-runner",
        resolved_checksum_sha256: entry.sha256,
      })],
    );
    const stillBlockedRoot = await fixtureRootFor(entry, sql);
    try {
      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: stillBlockedRoot }),
        /commit_outcome_unknown/,
        "a resolution addressed to run B leaves run A exactly as blocked as it was",
      );
    } finally {
      await rm(stillBlockedRoot, { recursive: true, force: true });
    }

    // The exact resolution for run A, and only then, lets the migration run.
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
       values ($1, $2, 2, 'stale_reclaimed', $3, $4, $5, $6::jsonb)`,
      [resolutionRunId, entry.id, "pb10-operator-on-call", identity.sourceGitSha, identity.executorImageDigest, JSON.stringify({
        ...common,
        reclaim_reason: "heartbeat_expired",
        checksum_sha256: entry.sha256,
        resolved_event_id: armedEventId,
        resolved_run_id: runA,
        resolved_runner_id: "pb10-crashed-runner",
        resolved_checksum_sha256: entry.sha256,
      })],
    );
    const clearedRoot = await fixtureRootFor(entry, sql);
    try {
      const report = await executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: clearedRoot });
      assert.equal(report.executedCount, 1, "every unresolved attempt is now accounted for");
      assert.equal(await count("public.demo"), 1);
    } finally {
      await rm(clearedRoot, { recursive: true, force: true });
    }
  });

  test("pg: H3 — the documented default configuration (no MIGRATION_RUNNER_ID) still produces a durably recoverable attempt", async () => {
    const { pool, proxy } = await newProxiedPool();
    const sql = "insert into demo values (12, 'h3');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const defaultConfig = { ...identity, runnerId: null };
    const fixtureRoot = await fixtureRootFor(entry, sql);
    try {
      // A genuine ambiguous COMMIT under the documented default configuration.
      proxy.armDropBeforeServer();
      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity: defaultConfig, repositoryRoot: fixtureRoot }),
        /commit_outcome_unknown/,
      );

      // Everything manual recovery needs is durable in the ledger, and the
      // process that generated it no longer exists.
      const ambiguity = await admin.query<{ total: string }>(
        `select count(*)::text as total from migration_control.migration_runs
          where event_type = 'execution_failed' and error_class = 'commit_outcome_unknown'`,
      );
      assert.equal(ambiguity.rows[0].total, "1", "the ambiguity is durably recorded");
      const armedRow = await admin.query<{ event_id: string; run_id: string; runner_id: string | null; checksum_sha256: string | null }>(
        `select event_id::text, run_id::text, runner_id, metadata ->> 'checksum_sha256' as checksum_sha256
           from migration_control.migration_runs
          where event_type = 'started'`,
      );
      assert.equal(armedRow.rows.length, 1, "the attempt's identity-establishing started row is durable");
      const armed = armedRow.rows[0];
      assert.notEqual(armed.runner_id, null, "runner identity is never null under the documented default configuration");
      assert.match(String(armed.runner_id), /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/);
      assert.notEqual(armed.runner_id, armed.run_id, "the generated runner id is never the run id");
      assert.equal(armed.checksum_sha256, entry.sha256, "and the checksum recovery correlates against is persisted");

      const resolve = async (metadata: Record<string, unknown>, sequence: number): Promise<void> => {
        await admin.query(
          `insert into migration_control.migration_runs
             (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
           values ($1, $2, $3, 'stale_reclaimed', $4, $5, $6, $7::jsonb)`,
          [randomUUID(), entry.id, sequence, "pb10-operator-on-call", identity.sourceGitSha, identity.executorImageDigest, JSON.stringify(metadata)],
        );
      };
      const exact = {
        execution_mode: "transactional",
        migration_filename: entry.filename,
        migration_ordinal: 1,
        reclaim_reason: "operator_approved",
        checksum_sha256: entry.sha256,
        resolved_event_id: Number(armed.event_id),
        resolved_run_id: armed.run_id,
        resolved_runner_id: armed.runner_id,
        resolved_checksum_sha256: entry.sha256,
      };

      // A resolution naming the wrong target runner identity is refused, even
      // though every other field is exact and the author is authorized.
      await resolve({ ...exact, resolved_runner_id: "pb10-runner-00000000000000000000000000000000" }, 1);
      const wrongRunnerRoot = await fixtureRootFor(entry, sql);
      try {
        await assert.rejects(
          executeMigrationsForTest(pool, { manifest, identity: defaultConfig, repositoryRoot: wrongRunnerRoot }),
          /commit_outcome_unknown/,
        );
      } finally {
        await rm(wrongRunnerRoot, { recursive: true, force: true });
      }

      // A resolution naming the wrong run id is refused.
      await resolve({ ...exact, resolved_run_id: randomUUID() }, 1);
      const refusedRoot = await fixtureRootFor(entry, sql);
      try {
        await assert.rejects(
          executeMigrationsForTest(pool, { manifest, identity: defaultConfig, repositoryRoot: refusedRoot }),
          /commit_outcome_unknown/,
        );
      } finally {
        await rm(refusedRoot, { recursive: true, force: true });
      }

      // The exact resolution, built only from values read back out of the
      // ledger, recovers the migration.
      await resolve(exact, 1);
      const recoveredRoot = await fixtureRootFor(entry, sql);
      try {
        const report = await executeMigrationsForTest(pool, { manifest, identity: defaultConfig, repositoryRoot: recoveredRoot });
        assert.equal(report.executedCount, 1, "exact manual recovery succeeds under the documented default configuration");
        assert.equal(await count("public.demo"), 1);
      } finally {
        await rm(recoveredRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });


  // ── PB-10 Step 3 Phase 2c final review, PART 8 (31-35) ───────────────────
  // Every adversarial history the reviewer reproduced, driven through the real
  // executeMigrations(pool) entry point against real PostgreSQL. Deterministic
  // throughout: each history is written with explicit INSERTs and each verdict
  // is asserted directly — no sleeps, no timing races.

  const adversarialSetup = async (
    entry: MigrationManifestEntry,
    write: (context: { runA: string; runB: string; common: Record<string, unknown> }) => Promise<void>,
  ): Promise<{ runA: string; runB: string }> => {
    const runA = randomUUID();
    const runB = randomUUID();
    const common = { execution_mode: "transactional", migration_filename: entry.filename, migration_ordinal: 1 };
    await write({ runA, runB, common });
    return { runA, runB };
  };

  /** Asserts executeMigrations(pool) refuses, and names the expected category. */
  const expectRefused = async (
    pool: Pool,
    manifest: MigrationManifest,
    entry: MigrationManifestEntry,
    sql: string,
    expectation: { category?: string; reason?: string; why: string },
  ): Promise<void> => {
    const fixtureRoot = await fixtureRootFor(entry, sql);
    try {
      await assert.rejects(
        executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: fixtureRoot }),
        (error: unknown) => {
          assert.ok(error instanceof Error, expectation.why);
          assert.match(error.message, /commit_outcome_unknown/, expectation.why);
          if (expectation.category) {
            assert.match(error.message, new RegExp(`category=${expectation.category}`), `${expectation.why}: ${error.message}`);
          }
          if (expectation.reason) {
            assert.match(error.message, new RegExp(`reason=${expectation.reason}`), `${expectation.why}: ${error.message}`);
          }
          return true;
        },
        expectation.why,
      );
      assert.equal(await count("public.demo"), 0, `${expectation.why}: no migration SQL ran`);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  };

  test("pg (31): a conflicting duplicate started row cannot be cleared through executeMigrations(pool)", async () => {
    const { pool } = await newProxiedPool();
    const sql = "insert into demo values (31, 'p31');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const started = { migration_id: entry.id, event_type: "started", runner_id: "pb10-runner-one" };
    const { runA } = await adversarialSetup(entry, async ({ runA: run, common }) => {
      await insertHistoricalEvent({ ...started, run_id: run, event_sequence: 1, metadata: { ...common, checksum_sha256: entry.sha256 } });
      // Same run id, contradicting immutable metadata (runner identity and
      // checksum), then a perfectly formed proof-carrying success.
      await insertHistoricalEvent({
        ...started, run_id: run, event_sequence: 2, runner_id: "pb10-runner-two",
        metadata: { ...common, checksum_sha256: entry.sha256 },
      });
      await insertHistoricalEvent({ migration_id: entry.id, run_id: run, event_sequence: 3, event_type: "applied_committed", runner_id: "pb10-runner-one", metadata: common });
      await insertHistoricalEvent({ migration_id: entry.id, run_id: run, event_sequence: 4, event_type: "succeeded", runner_id: "pb10-runner-one", metadata: common });
    });
    await expectRefused(pool, manifest, entry, sql, {
      category: "malformed_or_conflicting",
      reason: "conflicting_duplicate_started",
      why: "a contradictory duplicate started row is conflicting history and no terminal event clears it",
    });
    // Nor can an operator resolution clear a malformed attempt.
    const armed = await admin.query<{ event_id: string }>(
      "select event_id::text from migration_control.migration_runs where run_id = $1 and event_sequence = 1", [runA],
    );
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
       values ($1, $2, 1, 'stale_reclaimed', 'pb10-operator-on-call', $3, $4, $5::jsonb)`,
      [randomUUID(), entry.id, identity.sourceGitSha, identity.executorImageDigest, JSON.stringify({
        execution_mode: "transactional",
        migration_filename: entry.filename,
        migration_ordinal: 1,
        reclaim_reason: "operator_approved",
        checksum_sha256: entry.sha256,
        resolved_event_id: Number(armed.rows[0].event_id),
        resolved_run_id: runA,
        resolved_runner_id: "pb10-runner-one",
        resolved_checksum_sha256: entry.sha256,
      })],
    );
    await expectRefused(pool, manifest, entry, sql, {
      category: "malformed_or_conflicting",
      why: "a resolution never clears a malformed attempt",
    });
  });

  test("pg (32): a sequence-gap history cannot be cleared through executeMigrations(pool)", async () => {
    const { pool } = await newProxiedPool();
    const sql = "insert into demo values (32, 'p32');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    await adversarialSetup(entry, async ({ runA, common }) => {
      await insertHistoricalEvent({ migration_id: entry.id, run_id: runA, event_sequence: 1, event_type: "started", runner_id: "pb10-runner-one", metadata: { ...common, checksum_sha256: entry.sha256 } });
      // event_sequence 2 is absent: the missing row could carry the evidence
      // that changes the verdict, so 1 -> 3 is never a valid ordering.
      await insertHistoricalEvent({ migration_id: entry.id, run_id: runA, event_sequence: 3, event_type: "applied_committed", runner_id: "pb10-runner-one", metadata: common });
      await insertHistoricalEvent({ migration_id: entry.id, run_id: runA, event_sequence: 4, event_type: "succeeded", runner_id: "pb10-runner-one", metadata: common });
    });
    await expectRefused(pool, manifest, entry, sql, {
      category: "malformed_or_conflicting",
      reason: "event_sequence_gap",
      why: "a gap inside the run's own event stream fails closed",
    });
  });

  test("pg (33): a bare allowed error_class with no rollback evidence cannot be cleared through executeMigrations(pool)", async () => {
    const { pool } = await newProxiedPool();
    const sql = "insert into demo values (33, 'p33');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    await adversarialSetup(entry, async ({ runA, common }) => {
      await insertHistoricalEvent({ migration_id: entry.id, run_id: runA, event_sequence: 1, event_type: "started", runner_id: "pb10-runner-one", metadata: { ...common, checksum_sha256: entry.sha256 } });
      // Directly inserted "sql_failed" with no transaction_rolled_back row:
      // the label is not the proof.
      await insertHistoricalEvent({
        migration_id: entry.id, run_id: runA, event_sequence: 2, event_type: "execution_failed",
        runner_id: "pb10-runner-one", error_class: "sql_failed", metadata: { ...common, checksum_sha256: entry.sha256 },
      });
    });
    await expectRefused(pool, manifest, entry, sql, {
      category: "complete_modern",
      // H2: the same refusal, now reported by the mode-specific evaluator that
      // produced it rather than as one undifferentiated central reason.
      reason: "transactional:MANUAL_RESOLUTION_REQUIRED:no_exclusive_transaction_binding",
      why: "an arbitrary sql_failed insert is never proof of rollback",
    });

    // CRITICAL 1: the same history *with* a perfectly matching
    // transaction_rolled_back predecessor — identical run, runner, build
    // identity, checksum, error class and SQLSTATE, correctly ordered — is
    // still refused, because every one of those rows is something a hand
    // INSERT can write. Nothing here is tied to a transaction PostgreSQL ever
    // ruled on. This is the exact history the previous evaluator cleared.
    await resetDatabase();
    await adversarialSetup(entry, async ({ runA: run, common }) => {
      await insertHistoricalEvent({ migration_id: entry.id, run_id: run, event_sequence: 1, event_type: "started", runner_id: "pb10-runner-one", metadata: { ...common, checksum_sha256: entry.sha256 } });
      await admin.query(
        `insert into migration_control.migration_runs
           (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, sqlstate, error_class, metadata)
         values ($1, $2, 2, 'transaction_rolled_back', 'pb10-runner-one', $3, $4, '23505', 'sql_failed', $5::jsonb),
                ($1, $2, 3, 'execution_failed',        'pb10-runner-one', $3, $4, '23505', 'sql_failed', $5::jsonb)`,
        [run, entry.id, identity.sourceGitSha, identity.executorImageDigest, JSON.stringify({ ...common, checksum_sha256: entry.sha256 })],
      );
    });
    await expectRefused(pool, manifest, entry, sql, {
      category: "complete_modern",
      // H2: the same refusal, now reported by the mode-specific evaluator that
      // produced it rather than as one undifferentiated central reason.
      reason: "transactional:MANUAL_RESOLUTION_REQUIRED:no_exclusive_transaction_binding",
      why: "a fabricated rollback pair carries no transaction PostgreSQL can rule on",
    });

    // A hand-written transaction binding does not help either: an xid8 the
    // forger chose (here, one from a transaction they aborted themselves) is
    // refused unless it is *this* attempt's single binding and PostgreSQL
    // reports it aborted — and a second binding alongside a genuine one fails
    // closed for both.
    await resetDatabase();
    const foreignXid = await (async (): Promise<string> => {
      const scratch = await admin.query<{ xid: string }>("select pg_current_xact_id()::text as xid");
      return scratch.rows[0].xid;
    })();
    await adversarialSetup(entry, async ({ runA: run, common }) => {
      await insertHistoricalEvent({ migration_id: entry.id, run_id: run, event_sequence: 1, event_type: "started", runner_id: "pb10-runner-one", metadata: { ...common, checksum_sha256: entry.sha256 } });
      await admin.query(
        `insert into migration_control.migration_runs
           (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, sqlstate, error_class, metadata, xact_id)
         values ($1, $2, 2, 'heartbeat',               'pb10-runner-one', $3, $4, null,    null,         $5::jsonb, $6::xid8),
                ($1, $2, 3, 'transaction_rolled_back', 'pb10-runner-one', $3, $4, '23505', 'sql_failed', $5::jsonb, null),
                ($1, $2, 4, 'execution_failed',        'pb10-runner-one', $3, $4, '23505', 'sql_failed', $5::jsonb, null)`,
        [run, entry.id, identity.sourceGitSha, identity.executorImageDigest, JSON.stringify({ ...common, checksum_sha256: entry.sha256 }), foreignXid],
      );
    });
    await expectRefused(pool, manifest, entry, sql, {
      category: "complete_modern",
      // H2: the same refusal, now reported by the mode-specific evaluator that
      // produced it rather than as one undifferentiated central reason.
      reason: "transactional:MANUAL_RESOLUTION_REQUIRED:bound_transaction_committed_without_commit_proof",
      why: "an xid8 that committed is not a rollback proof, however exactly it is correlated",
    });
  });

  test("pg (33b): a genuine transactional failure binds its own transaction and retries safely", async () => {
    // CRITICAL 1, the positive half: no history is inserted by hand at all.
    // The executor runs a migration that genuinely fails, PostgreSQL genuinely
    // aborts the bound transaction, and the *next* run through
    // executeMigrations(pool) proceeds because pg_xact_status() — not the
    // ledger's labels — says so.
    const { pool } = await newProxiedPool();
    await resetDatabase();
    // The *same bytes* must be replayed — changing the file between attempts is
    // checksum drift, which blocks for its own separate reason. So the failure
    // comes from external state the operator then fixes.
    await admin.query("insert into public.demo values (77, 'pre-existing')");
    const migrationSql = "insert into demo values (77, 'p33b');\n";
    const failing = transactionalEntry("0100", "0100_demo.sql", migrationSql);
    const failingRoot = await fixtureRootFor(failing, migrationSql);
    try {
      await assert.rejects(
        executeMigrationsForTest(pool, {
          manifest: { schemaVersion: 1, legacyBoundary: "0099", migrations: [failing] },
          identity,
          repositoryRoot: failingRoot,
        }),
        /sql_failed/,
      );
      await admin.query("delete from public.demo where id = 77");
    } finally {
      await rm(failingRoot, { recursive: true, force: true });
    }

    const bound = await admin.query<{ xact_id: string | null; status: string | null }>(
      `select xact_id::text as xact_id, pg_catalog.pg_xact_status(xact_id) as status
         from migration_control.migration_runs where xact_id is not null`,
    );
    assert.equal(bound.rows.length, 1, "exactly one durable transaction binding");
    assert.equal(bound.rows[0].status, "aborted", "PostgreSQL itself reports the bound transaction aborted");

    const fixed = transactionalEntry("0100", "0100_demo.sql", migrationSql);
    const fixedRoot = await fixtureRootFor(fixed, migrationSql);
    try {
      const report = await executeMigrationsForTest(pool, {
        manifest: { schemaVersion: 1, legacyBoundary: "0099", migrations: [fixed] },
        identity,
        repositoryRoot: fixedRoot,
      });
      assert.equal(report.executedCount, 1, "an authoritatively aborted transaction is safe to replay");
      assert.equal(await count("public.demo"), 1);
    } finally {
      await rm(fixedRoot, { recursive: true, force: true });
    }
  });

  test("pg (34): a wrong target runner identity cannot resolve an attempt", async () => {
    const { pool } = await newProxiedPool();
    const sql = "insert into demo values (34, 'p34');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const common = { execution_mode: "transactional", migration_filename: entry.filename, migration_ordinal: 1 };
    const runA = randomUUID();
    const armedEventId = await insertHistoricalEvent({
      migration_id: entry.id, run_id: runA, event_sequence: 1, event_type: "started",
      runner_id: "pb10-original-runner", metadata: { ...common, checksum_sha256: entry.sha256 },
    });
    const resolve = async (metadata: Record<string, unknown>, author = "pb10-operator-on-call"): Promise<void> => {
      await admin.query(
        `insert into migration_control.migration_runs
           (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
         values ($1, $2, 1, 'stale_reclaimed', $3, $4, $5, $6::jsonb)`,
        [randomUUID(), entry.id, author, identity.sourceGitSha, identity.executorImageDigest, JSON.stringify(metadata)],
      );
    };
    const exact = {
      ...common,
      reclaim_reason: "heartbeat_expired",
      checksum_sha256: entry.sha256,
      resolved_event_id: armedEventId,
      resolved_run_id: runA,
      resolved_runner_id: "pb10-original-runner",
      resolved_checksum_sha256: entry.sha256,
    };

    // Wrong target runner; and the author's own identity is not a substitute.
    await resolve({ ...exact, resolved_runner_id: "pb10-different-runner" });
    await expectRefused(pool, manifest, entry, sql, { why: "a wrong target runner identity resolves nothing" });
    await resolve({ ...exact, resolved_runner_id: "pb10-operator-on-call" });
    await expectRefused(pool, manifest, entry, sql, { why: "the resolution author is never the target" });
    // The correct target, authored by a *different* operator, is accepted:
    // author identity never participates in correlation.
    await resolve(exact, "pb10-operator-second-shift");
    const recoveredRoot = await fixtureRootFor(entry, sql);
    try {
      const report = await executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: recoveredRoot });
      assert.equal(report.executedCount, 1, "the exact target identity recovers the attempt");
      assert.equal(await count("public.demo"), 1);
    } finally {
      await rm(recoveredRoot, { recursive: true, force: true });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // PB-10 Step 3 Phase 2c final review, CRITICAL 1 + CRITICAL 2: real
  // PostgreSQL, real hand-written INSERTs, executeMigrations(pool) only.
  // ══════════════════════════════════════════════════════════════════════

  const modeEntry = (mode: MigrationManifestEntry["executionMode"], id: string, filename: string, sql: string): MigrationManifestEntry => ({
    ...transactionalEntry(id, filename, sql),
    id,
    filename,
    executionMode: mode,
  });

  const insertBinding = async (run_id: string, migration_id: string, event_sequence: number, xactId: string, metadata: Record<string, unknown>): Promise<void> => {
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata, xact_id)
       values ($1, $2, $3, 'heartbeat', 'pb10-runner-one', $4, $5, $6::jsonb, $7::xid8)`,
      [run_id, migration_id, event_sequence, identity.sourceGitSha, identity.executorImageDigest, JSON.stringify(metadata), xactId],
    );
  };

  /** An xid8 of a transaction this test genuinely aborted, so pg_xact_status reports 'aborted'. */
  const genuinelyAbortedXid = async (): Promise<string> => {
    const scratch = new Client({ connectionString: databaseUrl });
    await scratch.connect();
    try {
      await scratch.query("begin");
      const { rows } = await scratch.query<{ xid: string }>("select pg_current_xact_id()::text as xid");
      await scratch.query("rollback");
      return rows[0].xid;
    } finally {
      await scratch.end();
    }
  };

  test("pg: an outcome proof is bound to one attempt: wrong run, wrong identity, and reuse all fail", async () => {
    const { pool } = await newProxiedPool();
    const sql = "insert into demo values (40, 'bound');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const common = { execution_mode: "transactional", migration_filename: entry.filename, migration_ordinal: 1 };
    const metadata = { ...common, checksum_sha256: entry.sha256 };
    const aborted = await genuinelyAbortedXid();

    const armAttempt = async (run_id: string, bindingRun: string, xactId: string): Promise<void> => {
      await insertHistoricalEvent({ migration_id: entry.id, run_id, event_sequence: 1, event_type: "started", runner_id: "pb10-runner-one", metadata });
      await insertBinding(bindingRun, entry.id, bindingRun === run_id ? 2 : 1, xactId, metadata);
      await admin.query(
        `insert into migration_control.migration_runs
           (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, sqlstate, error_class, metadata)
         values ($1, $2, $3, 'transaction_rolled_back', 'pb10-runner-one', $4, $5, '23505', 'sql_failed', $6::jsonb),
                ($1, $2, $7, 'execution_failed',        'pb10-runner-one', $4, $5, '23505', 'sql_failed', $6::jsonb)`,
        [
          run_id, entry.id, bindingRun === run_id ? 3 : 2,
          identity.sourceGitSha, identity.executorImageDigest, JSON.stringify(metadata),
          bindingRun === run_id ? 4 : 3,
        ],
      );
    };

    // The binding lives under another run id: it is not this attempt's proof.
    await resetDatabase();
    await armAttempt(randomUUID(), randomUUID(), aborted);
    await expectRefused(pool, manifest, entry, sql, {
      // H2: the same refusal, now reported by the mode-specific evaluator that
      // produced it rather than as one undifferentiated central reason.
      reason: "heartbeat_without_started_predecessor",
      why: "a genuinely aborted transaction bound to another run proves nothing here",
    });

    // The binding contradicts the attempt's own identity (a different runner).
    await resetDatabase();
    const contradicting = randomUUID();
    await insertHistoricalEvent({ migration_id: entry.id, run_id: contradicting, event_sequence: 1, event_type: "started", runner_id: "pb10-runner-one", metadata });
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata, xact_id)
       values ($1, $2, 2, 'heartbeat', 'pb10-someone-else', $3, $4, $5::jsonb, $6::xid8)`,
      [contradicting, entry.id, identity.sourceGitSha, identity.executorImageDigest, JSON.stringify(metadata), aborted],
    );
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, sqlstate, error_class, metadata)
       values ($1, $2, 3, 'transaction_rolled_back', 'pb10-runner-one', $3, $4, '23505', 'sql_failed', $5::jsonb),
              ($1, $2, 4, 'execution_failed',        'pb10-runner-one', $3, $4, '23505', 'sql_failed', $5::jsonb)`,
      [contradicting, entry.id, identity.sourceGitSha, identity.executorImageDigest, JSON.stringify(metadata)],
    );
    await expectRefused(pool, manifest, entry, sql, {
      why: "a binding that contradicts the attempt's identity is not its binding",
    });

    // One real outcome, copied onto two attempts. PB-10 Step 3 Phase 2c
    // final review, CRITICAL 2: this fabrication is no longer merely rejected
    // by the evaluator — mr_one_attempt_per_xact makes the second binding
    // impossible to insert at all, even for the administrative connection
    // staging it here. The stronger guarantee is asserted directly, and the
    // first attempt is then confirmed to still be blocked on its own merits.
    await resetDatabase();
    const runOne = randomUUID();
    const runTwo = randomUUID();
    await armAttempt(runOne, runOne, aborted);
    await assert.rejects(
      armAttempt(runTwo, runTwo, aborted),
      (error: { code?: string }) => error.code === "23505",
      "one transaction id cannot be bound to a second attempt",
    );
    await expectRefused(pool, manifest, entry, sql, {
      // H2: the same refusal, now reported by the mode-specific evaluator that
      // produced it rather than as one undifferentiated central reason.
      reason: "transactional:MANUAL_RESOLUTION_REQUIRED:no_exclusive_transaction_binding",
      why: "the surviving attempt has no proof of its own once the duplicate is impossible",
    });
  });

  test("pg: legacy-verbatim and nontransactional cannot bypass the canonical identity", async () => {
    const { pool } = await newProxiedPool();

    // Legacy-verbatim: the same fence, the same identity rules, and no outcome
    // proof available to it at all.
    await resetDatabase();
    const legacySql = "begin;\ninsert into demo values (41, 'legacy');\ncommit;\n";
    const legacy = modeEntry("legacy-verbatim", "0001", "0001_legacy_bypass.sql", legacySql);
    const legacyCommon = { execution_mode: "legacy-verbatim", migration_filename: legacy.filename, migration_ordinal: 1 };
    const legacyRun = randomUUID();
    await insertHistoricalEvent({ migration_id: legacy.id, run_id: legacyRun, event_sequence: 1, event_type: "started", runner_id: "pb10-runner-one", metadata: { ...legacyCommon, checksum_sha256: legacy.sha256 } });
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, sqlstate, error_class, metadata)
       values ($1, $2, 2, 'transaction_rolled_back', 'pb10-runner-one', $3, $4, '23505', 'sql_failed', $5::jsonb),
              ($1, $2, 3, 'execution_failed',        'pb10-runner-one', $3, $4, '23505', 'sql_failed', $5::jsonb)`,
      [legacyRun, legacy.id, identity.sourceGitSha, identity.executorImageDigest, JSON.stringify({ ...legacyCommon, checksum_sha256: legacy.sha256 })],
    );
    await expectRefused(pool, { schemaVersion: 1, legacyBoundary: "0099", migrations: [legacy] }, legacy, legacySql, {
      category: "complete_modern",
      // H2: the same refusal, now reported by the mode-specific evaluator that
      // produced it rather than as one undifferentiated central reason.
      reason: "legacy-verbatim:MANUAL_RESOLUTION_REQUIRED:recovery_verifier_unavailable",
      why: "legacy-verbatim uses the canonical evaluator and has no rollback proof of its own",
    });

    // Nontransactional: an armed row with no checksum is not a modern attempt,
    // and the fence runs before the unsupported-handler refusal.
    await resetDatabase();
    const concurrentSql = "create index concurrently demo_label_bypass_idx on demo (label);\n";
    const nontransactional = modeEntry("nontransactional", "0101", "0101_nontransactional_bypass.sql", concurrentSql);
    await insertHistoricalEvent({
      migration_id: nontransactional.id, run_id: randomUUID(), event_sequence: 1, event_type: "started",
      runner_id: "pb10-runner-one",
      metadata: { execution_mode: "nontransactional", migration_filename: nontransactional.filename, migration_ordinal: 1 },
    });
    await expectRefused(
      pool,
      { schemaVersion: 1, legacyBoundary: "0099", migrations: [nontransactional] },
      nontransactional,
      concurrentSql,
      {
        category: "legacy_unprovable",
        why: "a nontransactional armed row without a checksum can never be a complete modern attempt",
      },
    );
  });

  test("pg: a wrong batch identity can neither clear nor resolve a batched attempt", async () => {
    const { pool } = await newProxiedPool();
    await resetDatabase();
    const batchedSql = "update demo set label = 'batched' where id > 0;\n";
    const batched = modeEntry("batched", "0102", "0102_batched_identity.sql", batchedSql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [batched] };
    const common = { execution_mode: "batched", migration_filename: batched.filename, migration_ordinal: 1, checksum_sha256: batched.sha256 };
    const run = randomUUID();

    // A batch identity on the armed row itself is malformed: batches begin
    // after it, so no started row can name one.
    await insertHistoricalEvent({
      migration_id: batched.id, run_id: run, event_sequence: 1, event_type: "started",
      runner_id: "pb10-runner-one", metadata: { ...common, batch_number: 1 },
    });
    await expectRefused(pool, manifest, batched, batchedSql, {
      category: "malformed_or_conflicting",
      why: "a started row may not claim a batch identity",
    });

    // A per-batch rollback pair never accounts for the whole migration: the
    // batches that already committed are not undone by it.
    await resetDatabase();
    const second = randomUUID();
    await insertHistoricalEvent({ migration_id: batched.id, run_id: second, event_sequence: 1, event_type: "started", runner_id: "pb10-runner-one", metadata: common });
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, sqlstate, error_class, metadata)
       values ($1, $2, 2, 'transaction_rolled_back', 'pb10-runner-one', $3, $4, '23505', 'sql_failed', $5::jsonb),
              ($1, $2, 3, 'execution_failed',        'pb10-runner-one', $3, $4, '23505', 'sql_failed', $5::jsonb)`,
      [second, batched.id, identity.sourceGitSha, identity.executorImageDigest, JSON.stringify({ ...common, batch_number: 4 })],
    );
    await expectRefused(pool, manifest, batched, batchedSql, {
      // H2: the same refusal, now reported by the mode-specific evaluator that
      // produced it rather than as one undifferentiated central reason.
      reason: "batched:MANUAL_RESOLUTION_REQUIRED:batch_progress_unprovable_for_this_attempt",
      why: "one batch's rollback is not the migration's outcome",
    });

    // And a resolution carrying a batch identity is refused outright: a
    // resolution names the attempt, never a batch.
    await admin.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
       values ($1, $2, 1, 'stale_reclaimed', 'pb10-operator-on-call', $3, $4, $5::jsonb)`,
      [randomUUID(), batched.id, identity.sourceGitSha, identity.executorImageDigest, JSON.stringify({
        ...common,
        batch_number: 4,
        reclaim_reason: "operator_approved",
        resolved_event_id: 1,
        resolved_run_id: second,
        resolved_runner_id: "pb10-runner-one",
        resolved_checksum_sha256: batched.sha256,
      })],
    );
    await expectRefused(pool, manifest, batched, batchedSql, {
      why: "a resolution naming a batch identity resolves nothing",
    });
  });

  test("pg (35): the current file's checksum cannot resolve a legacy missing-checksum attempt", async () => {
    const { pool } = await newProxiedPool();
    const sql = "insert into demo values (35, 'p35');\n";
    const entry = transactionalEntry("0100", "0100_demo.sql", sql);
    const manifest: MigrationManifest = { schemaVersion: 1, legacyBoundary: "0099", migrations: [entry] };
    const common = { execution_mode: "transactional", migration_filename: entry.filename, migration_ordinal: 1 };
    const runA = randomUUID();
    // A historical attempt written before checksum metadata existed: nothing
    // in the database records which bytes it executed.
    const armedEventId = await insertHistoricalEvent({
      migration_id: entry.id, run_id: runA, event_sequence: 1, event_type: "started",
      runner_id: "pb10-legacy-runner", metadata: common,
    });
    const resolve = async (metadata: Record<string, unknown>): Promise<void> => {
      await admin.query(
        `insert into migration_control.migration_runs
           (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha, executor_image_digest, metadata)
         values ($1, $2, 1, 'stale_reclaimed', 'pb10-operator-on-call', $3, $4, $5::jsonb)`,
        [randomUUID(), entry.id, identity.sourceGitSha, identity.executorImageDigest, JSON.stringify(metadata)],
      );
    };
    const shape = {
      ...common,
      reclaim_reason: "operator_approved",
      resolved_event_id: armedEventId,
      resolved_run_id: runA,
      resolved_runner_id: "pb10-legacy-runner",
    };

    await expectRefused(pool, manifest, entry, sql, {
      category: "legacy_unprovable",
      why: "an attempt whose executed bytes cannot be proven blocks replay",
    });
    // The current migration file's own checksum is not evidence of history.
    await resolve({ ...shape, checksum_sha256: entry.sha256, resolved_checksum_sha256: entry.sha256 });
    await expectRefused(pool, manifest, entry, sql, {
      category: "legacy_unprovable",
      why: "the current file's checksum never proves what a historical run executed",
    });

    // HIGH 1: a later event carrying checksum_sha256 is exactly what an
    // untrusted writer can insert, so it never becomes proof of historical
    // bytes — not even when it correlates perfectly to the attempt and names
    // the same run, runner and build identity.
    await insertHistoricalEvent({
      migration_id: entry.id, run_id: runA, event_sequence: 2, event_type: "execution_failed",
      runner_id: "pb10-legacy-runner", error_class: "commit_outcome_unknown",
      metadata: { ...common, checksum_sha256: entry.sha256 },
    });
    await resolve({ ...shape, checksum_sha256: entry.sha256, resolved_checksum_sha256: entry.sha256 });
    await expectRefused(pool, manifest, entry, sql, {
      category: "legacy_unprovable",
      why: "a manually inserted later checksum cannot become historical proof",
    });
    assert.equal(await count("public.demo"), 0, "no migration SQL ever ran on the strength of an inserted checksum");

    // The only provenance-qualified source is the immutable applied-ledger row
    // for this exact run — and a migration that has one is applied, not
    // pending, so it never reaches this evaluator at all. A pre-checksum armed
    // attempt is therefore permanently fail closed; db/README.md documents the
    // operator procedure.
    const artifacts = await admin.query<{ total: string }>(
      "select count(*)::text as total from migration_control.schema_migrations where migration_id = $1",
      [entry.id],
    );
    assert.equal(artifacts.rows[0].total, "0", "no applied-ledger row exists, so no qualified provenance exists");
  });
}
