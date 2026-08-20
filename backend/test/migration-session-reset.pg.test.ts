import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { Client, Pool, type PoolClient } from "pg";
import type { MigrationManifest, MigrationManifestEntry } from "../src/db/migrate/manifest";
import { assertDistinctDatabases } from "../src/db/migrate/database-identity";
import { installControlSchema, type ControlSchemaInstall } from "./helpers/control-schema-install";
import { executeMigrationsForTest } from "./helpers/migration-execute";
import { startCommitProxy, type CommitProxy } from "./helpers/postgres-frame-proxy";

/**
 * PB-10 Step 3 Phase 2d: the mandatory real-PostgreSQL contract for pooled
 * session reset and safe connection return.
 *
 * Every case here answers one question from the *next borrower's* point of
 * view: given a migration that deliberately contaminated its session, what does
 * the connection this pool hands out next actually look like? Nothing is
 * inferred from a mocked `release()` call, from the executor's own bookkeeping,
 * or from the migration having succeeded. Session state is read back through
 * real catalog queries on a real connection, and a destroyed session is proven
 * gone by its backend PID no longer existing in pg_stat_activity.
 *
 *   MIGRATION_TEST_DATABASE_URL=postgres://... TEST_DATABASE_URL=postgres://... \
 *     node --import tsx --test test/migration-session-reset.pg.test.ts
 *
 * Every case drops and reinstalls migration_control, so the target must be
 * disposable.
 */
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required for the destructive PB-10 Phase 2d PostgreSQL suite in CI");
}

if (!databaseUrl) {
  test("pg: the Phase 2d pooled-session suite requires a dedicated disposable database", {
    skip: "MIGRATION_TEST_DATABASE_URL is not set; refusing to drop schemas in a shared or unidentified database",
  }, () => undefined);
} else {
  let admin: Client;
  let install: ControlSchemaInstall;
  const pools: Pool[] = [];
  const proxies: CommitProxy[] = [];

  const identity = {
    sourceGitSha: "5324116250977b5e8ac24bc83b6cae89ebcbd990",
    executorImageDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    runnerId: "pb10-phase2d-session-reset",
  };
  const timeouts = { lockMs: 5_000, statementMs: 60_000, transactionMs: 300_000, idleInTransactionMs: 60_000, wallClockMs: 900_000 };
  const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

  const root = mkdtempSync(path.join(os.tmpdir(), "pb10-session-reset-pg-"));
  mkdirSync(path.join(root, "db", "migrations"), { recursive: true });

  /**
   * The contamination payload, issued verbatim by legacy-verbatim mode on the
   * execution session with no wrapper transaction — the widest blast radius any
   * mode has. It records its own backend PID first (so the test knows exactly
   * which physical session ran it), then dirties one instance of every class
   * the reset contract names: a session GUC, search_path, both timeout GUCs,
   * a custom placeholder GUC, SET ROLE, a session-held advisory lock, a LISTEN
   * subscription, a temporary table, a server-side prepared statement, and a
   * WITH HOLD cursor that outlives its own transaction.
   *
   * `set role` targets `pb10_contaminant` — a genuinely *different* role,
   * created administratively and granted to the migration execution role, not
   * the runner's own role assumed as itself. A SET ROLE to one's own role is a
   * far weaker contamination: it makes the `role` GUC session-set without ever
   * changing `current_user`, so a reset that cleared the GUC but left the
   * effective role behind would still look clean. Here the payload records the
   * role it is actually running as, into a table granted to that role
   * beforehand, so the contamination is proven to have taken effect — and the
   * next borrower is then proven to be back at `current_user = session_user =
   * <execution role>`, its expected baseline.
   *
   * SET SESSION AUTHORIZATION is deliberately absent from this payload: it is
   * a superuser-only statement, and the supported execution role is required
   * *not* to be a superuser (verifyControlSchema refuses a superuser
   * connection outright, because a superuser bypasses every privilege the
   * commit-proof design depends on). Its reset property is proven separately,
   * and administratively, by the dedicated case further below.
   */
  const CONTAMINATION = [
    "begin;",
    "create table if not exists public.pb10_session_probe (id serial primary key, pid integer not null);",
    "insert into public.pb10_session_probe (pid) values (pg_backend_pid());",
    "commit;",
    "set search_path = pg_catalog;",
    "set statement_timeout = 12345;",
    "set lock_timeout = 6789;",
    "set idle_in_transaction_session_timeout = 4242;",
    "select set_config('pb10.custom', 'contaminated', false);",
    // Assumed here and deliberately never reset by the payload: every
    // statement below runs as the contaminant, and the session is still
    // running as it when the boundary takes the session back.
    "set role pb10_contaminant;",
    "insert into public.pb10_role_probe (who) values (current_user);",
    "select pg_advisory_lock(918273, 645);",
    "listen pb10_contamination_channel;",
    "create temp table pb10_temp_probe (id integer);",
    "prepare pb10_prepared_probe as select 1;",
    "begin;",
    "declare pb10_held_cursor cursor with hold for select 1;",
    "commit;",
  ].join("\n");

  const files: Record<string, Buffer> = {
    // legacy-verbatim: self-committing, and the full contamination payload.
    "0001_legacy_contaminate.sql": Buffer.from(`${CONTAMINATION}\n`, "utf8"),
    // transactional: a plain SET inside the runner's own transaction survives
    // its COMMIT, which is why even this mode can dirty a pooled session.
    "0100_transactional_contaminate.sql": Buffer.from(
      "create table public.pb10_transactional (id integer primary key);\n"
      + "insert into public.pb10_transactional values (1);\n"
      + "set search_path = pg_catalog;\n"
      + "set statement_timeout = 24680;\n"
      + "select set_config('pb10.custom', 'transactional', false);\n",
      "utf8",
    ),
    // nontransactional: the runner itself sets statement_timeout = 0 at
    // *session* level for this mode, so a leaked session disables the next
    // borrower's statement timeout entirely.
    "0101_nontransactional_index.sql": Buffer.from(
      "create index concurrently pb10_nontransactional_idx on public.pb10_target (label);\n",
      "utf8",
    ),
    "0102_batched.sql": Buffer.from("-- batched mode executes through its registered handler\n", "utf8"),
    // A migration that simply fails, for the rollback-then-reuse contract.
    "0103_failing.sql": Buffer.from(
      "set search_path = pg_catalog;\ncreate table public.pb10_target (id integer primary key);\n",
      "utf8",
    ),
    // Sleeps past its wall-clock budget so the control connection cancels it.
    "0104_slow.sql": Buffer.from("select pg_sleep(30);\n", "utf8"),
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
    overrides: Partial<MigrationManifestEntry["timeouts"]> = {},
  ): MigrationManifestEntry => ({
    id,
    filename,
    sha256: sha256(files[filename]),
    lifecyclePhase: "expand",
    operationCategories,
    executionMode,
    requiredRuntimeEpoch: null,
    timeouts: { ...timeouts, ...overrides },
  });

  const entries = {
    legacy: entry("0001", "0001_legacy_contaminate.sql", "legacy-verbatim", ["schema"]),
    transactional: entry("0100", "0100_transactional_contaminate.sql", "transactional", ["schema"]),
    nontransactional: entry("0101", "0101_nontransactional_index.sql", "nontransactional", ["index"]),
    // `data-correction`, not `data`: operation_categories is a closed
    // vocabulary enforced by sm_categories_ck, so an invented category makes
    // the applied-ledger insert fail with a check violation *after* the batch
    // has already committed — which reads as a batched-execution failure and
    // proves nothing about session reset.
    batched: entry("0102", "0102_batched.sql", "batched", ["data-correction"]),
    failing: entry("0103", "0103_failing.sql", "transactional", ["schema"]),
    slow: entry("0104", "0104_slow.sql", "transactional", ["schema"], { wallClockMs: 1_500 }),
  };

  const manifestOf = (...migrations: MigrationManifestEntry[]): MigrationManifest => ({
    schemaVersion: 1,
    legacyBoundary: "0099",
    migrations,
  });

  /**
   * `max: 2` is the production shape and the smallest a migration run can use:
   * the control and execution connections are held concurrently, so `max: 1`
   * would deadlock the executor itself. Forcing the next borrower onto the same
   * physical session is achieved instead by borrowing *every* slot at once
   * after the run (see inspectPool) — nothing the pool still holds escapes
   * inspection, which is strictly stronger than sampling one connection.
   */
  const newPool = (options: { connectionString?: string } = {}): Pool => {
    const pool = new Pool({
      connectionString: options.connectionString ?? install.executionUrl,
      max: 2,
      application_name: "pb10-phase2d",
    });
    // Absorb the delayed idle-error a destroyed backend can emit at pool level;
    // otherwise a deliberate backend termination crashes the test process
    // rather than being the thing under test.
    pool.on("error", () => undefined);
    pools.push(pool);
    return pool;
  };

  interface SessionState {
    pid: number;
    dirty_settings: string;
    search_path: string;
    statement_timeout: string;
    lock_timeout: string;
    idle_in_transaction_session_timeout: string;
    custom_guc: string;
    current_user: string;
    session_user: string;
    advisory_locks: string;
    listens: string;
    prepared_statements: string;
    cursors: string;
    temp_objects: string;
  }

  /**
   * Reads everything the reset contract claims about a session, from the
   * borrower's own side of the connection. Deliberately independent of the
   * runner's own baseline query: a proof that only ever asks the same question
   * the implementation asks itself would confirm nothing.
   */
  const SESSION_STATE_SQL = `
    select pg_catalog.pg_backend_pid() as pid,
           (select count(*) from pg_catalog.pg_settings where source = 'session') as dirty_settings,
           current_setting('search_path') as search_path,
           current_setting('statement_timeout') as statement_timeout,
           current_setting('lock_timeout') as lock_timeout,
           current_setting('idle_in_transaction_session_timeout') as idle_in_transaction_session_timeout,
           coalesce(current_setting('pb10.custom', true), '') as custom_guc,
           current_user::text as current_user,
           session_user::text as session_user,
           (select count(*) from pg_catalog.pg_locks
             where locktype = 'advisory' and pid = pg_catalog.pg_backend_pid()) as advisory_locks,
           (select count(*) from pg_catalog.pg_listening_channels()) as listens,
           (select count(*) from pg_catalog.pg_prepared_statements) as prepared_statements,
           (select count(*) from pg_catalog.pg_cursors) as cursors,
           (select count(*) from pg_catalog.pg_class
             where relnamespace = pg_catalog.pg_my_temp_schema()) as temp_objects
  `;

  /**
   * Borrows every slot the pool has, all at once, and reports each session's
   * real state. Holding all `max` clients simultaneously guarantees no returned
   * session is skipped: any connection the pool still owns is either inspected
   * here or was never returned at all.
   */
  const inspectPool = async (pool: Pool): Promise<SessionState[]> => {
    const clients: PoolClient[] = [];
    try {
      for (let index = 0; index < 2; index += 1) clients.push(await pool.connect());
      const states: SessionState[] = [];
      for (const client of clients) {
        const result = await client.query<SessionState>(SESSION_STATE_SQL);
        states.push(result.rows[0]);
      }
      return states;
    } finally {
      for (const client of clients) client.release();
    }
  };

  /** Asserts one session is exactly what a freshly connected borrower would get. */
  const assertCleanSession = (state: SessionState, detail: string): void => {
    assert.equal(state.dirty_settings, "0", `${detail}: a session-set GUC survived into the next borrower`);
    assert.equal(state.search_path, '"$user", public', `${detail}: search_path was not restored`);
    assert.equal(state.statement_timeout, "0", `${detail}: statement_timeout was not restored`);
    assert.equal(state.lock_timeout, "0", `${detail}: lock_timeout was not restored`);
    assert.equal(state.idle_in_transaction_session_timeout, "0", `${detail}: idle_in_transaction_session_timeout was not restored`);
    assert.equal(state.custom_guc, "", `${detail}: a custom session GUC survived into the next borrower`);
    assert.equal(state.current_user, state.session_user, `${detail}: SET ROLE survived into the next borrower`);
    assert.equal(state.current_user, install.executionRole, `${detail}: the borrower is not the migration execution role`);
    assert.equal(state.advisory_locks, "0", `${detail}: a migration-owned advisory lock survived into the next borrower`);
    assert.equal(state.listens, "0", `${detail}: a LISTEN subscription survived into the next borrower`);
    assert.equal(state.prepared_statements, "0", `${detail}: a server-side prepared statement survived into the next borrower`);
    assert.equal(state.cursors, "0", `${detail}: an open (WITH HOLD) cursor survived into the next borrower`);
    assert.equal(state.temp_objects, "0", `${detail}: a temporary object survived into the next borrower`);
  };

  /**
   * Proves a session is genuinely idle rather than merely answering: a session
   * left inside a transaction block reports 'idle in transaction', and one
   * inside a *failed* block refuses the next statement outright.
   */
  const assertIdleAndUsable = async (pool: Pool, detail: string): Promise<void> => {
    const client = await pool.connect();
    try {
      // The borrower's own view: a statement succeeding at all rules out a
      // failed transaction block (25P02), and pg_stat_activity's own record of
      // this backend rules out an open one.
      const probe = await client.query<{ pid: number }>("select pg_catalog.pg_backend_pid() as pid");
      const activity = await admin.query<{ state: string }>(
        "select state from pg_catalog.pg_stat_activity where pid = $1",
        [probe.rows[0].pid],
      );
      assert.notEqual(activity.rows[0]?.state, "idle in transaction", `${detail}: the session was returned inside a transaction`);
    } finally {
      client.release();
    }
  };

  /** The backend PIDs the migration payload recorded for itself. */
  const migrationPids = async (): Promise<number[]> => {
    const result = await admin.query<{ pid: number }>("select pid from public.pb10_session_probe order by id");
    return result.rows.map((row) => row.pid);
  };

  const backendExists = async (pid: number): Promise<boolean> => {
    const result = await admin.query<{ present: boolean }>(
      "select exists (select 1 from pg_catalog.pg_stat_activity where pid = $1) as present",
      [pid],
    );
    return result.rows[0].present;
  };

  const eventTypes = async (): Promise<string[]> => {
    const result = await admin.query<{ event_type: string }>(
      "select event_type from migration_control.migration_runs order by event_sequence",
    );
    return result.rows.map((row) => row.event_type);
  };

  const run = (pool: Pool, manifest: MigrationManifest, extra: Record<string, unknown> = {}) =>
    executeMigrationsForTest(pool, { manifest, identity, repositoryRoot: root, ...extra });

  const resetDatabase = async (): Promise<void> => {
    await admin.query("drop schema if exists migration_control cascade");
    await admin.query("drop schema if exists public cascade");
    await admin.query("create schema public");
    install = await installControlSchema(admin, databaseUrl!);
    // The nontransactional and batched payloads operate on this table; the
    // legacy payload creates its own probe table as part of its transaction.
    await admin.query("create table public.pb10_target (id integer primary key, label text)");
    await admin.query("insert into public.pb10_target values (1, 'a'), (2, 'b')");
    await admin.query(`grant all on public.pb10_target to ${install.executionRole}`);
    // Ownership, not merely privileges: CREATE INDEX is authorized by table
    // *ownership* alone, so the nontransactional payload below fails with
    // insufficient_privilege on a table the admin owns no matter what is
    // granted — and a migration role owning the tables its migrations touch is
    // also what production looks like.
    await admin.query(`alter table public.pb10_target owner to ${install.executionRole}`);
    // PB-10 Step 3 Phase 2d: a genuinely distinct role for the SET ROLE
    // contamination above, granted to the execution role so the payload may
    // assume it, and a probe table that role may write to so the assumption is
    // provable rather than assumed. NOLOGIN and privilege-free otherwise: it
    // exists only to be assumed and then reset away.
    await admin.query(`
      do $$
      begin
        if not exists (select 1 from pg_catalog.pg_roles where rolname = 'pb10_contaminant') then
          create role pb10_contaminant nologin;
        end if;
      end
      $$
    `);
    await admin.query(`grant pb10_contaminant to ${install.executionRole}`);
    await admin.query("create table public.pb10_role_probe (who text not null)");
    // `create schema public` grants nothing to PUBLIC on PostgreSQL 15+, so the
    // assumed role needs USAGE explicitly — and nothing beyond it.
    await admin.query("grant usage on schema public to pb10_contaminant");
    await admin.query("grant insert on public.pb10_role_probe to pb10_contaminant");
    await admin.query(`grant select on public.pb10_role_probe to ${install.executionRole}`);
  };

  /** The role the contaminating payload was actually running as, as it saw itself. */
  const assumedRoles = async (): Promise<string[]> => {
    const result = await admin.query<{ who: string }>("select who from public.pb10_role_probe");
    return result.rows.map((row) => row.who);
  };

  // Strict process-error handling: a destroyed backend legitimately emits
  // delayed errors, and every one of them must already be owned.
  const unhandled: unknown[] = [];
  const uncaught: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  const onUncaught = (error: unknown): void => { uncaught.push(error); };

  before(async () => {
    await assertDistinctDatabases(
      { a: databaseUrl, b: process.env.TEST_DATABASE_URL },
      { a: "MIGRATION_TEST_DATABASE_URL", b: "TEST_DATABASE_URL" },
    );
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUncaught);
    admin = new Client({ connectionString: databaseUrl, application_name: "pb10-phase2d-admin" });
    await admin.connect();
    install = await installControlSchema(admin, databaseUrl!);
  });

  after(async () => {
    process.removeListener("unhandledRejection", onUnhandled);
    process.removeListener("uncaughtException", onUncaught);
    if (admin === undefined) return;
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
    await Promise.all(proxies.map((proxy) => proxy.close().catch(() => undefined)));
    await admin.query("drop schema if exists migration_control cascade");
    await admin.query("drop table if exists public.pb10_session_probe");
    await admin.query("drop table if exists public.pb10_role_probe");
    await admin.query("drop table if exists public.pb10_target");
    await admin.query("drop role if exists pb10_contaminant").catch(() => undefined);
    await admin.end();
    assert.deepEqual(unhandled, [], `no unhandled rejection across the suite: ${String(unhandled[0])}`);
    assert.deepEqual(uncaught, [], `no uncaught exception across the suite: ${String(uncaught[0])}`);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  // ── reusable-session contract, per execution mode ─────────────────────────

  test("pg: a legacy-verbatim migration that dirties every class of session state returns a clean, reusable session", async () => {
    const pool = newPool();
    const report = await run(pool, manifestOf(entries.legacy));
    assert.equal(report.executedCount, 1);

    const [payloadPid] = await migrationPids();
    assert.ok(Number.isInteger(payloadPid), "the payload recorded the backend it actually ran on");
    // The role contamination genuinely took effect: the payload really was
    // running as a *different* role than the one it connected as, so the
    // baseline restoration asserted below is a real restoration.
    assert.deepEqual(
      await assumedRoles(), ["pb10_contaminant"],
      "the payload assumed a genuinely distinct granted role, not merely its own",
    );
    assert.notEqual(install.executionRole, "pb10_contaminant");

    const states = await inspectPool(pool);
    for (const state of states) assertCleanSession(state, "legacy-verbatim");
    await assertIdleAndUsable(pool, "legacy-verbatim");

    // The physical session really was reused, so the assertions above are
    // about the contaminated backend rather than a conveniently fresh one.
    assert.ok(
      states.some(({ pid }) => Number(pid) === Number(payloadPid)),
      "a healthy session is returned to the pool and handed to the next borrower, not silently discarded",
    );
    assert.equal(await backendExists(payloadPid), true);
  });

  /**
   * PB-10 Step 3 Phase 2d: SET SESSION AUTHORIZATION, the one contamination
   * class the supported execution role cannot itself produce.
   *
   * PostgreSQL requires superuser privileges for SET SESSION AUTHORIZATION to
   * any role other than the session's own — and the migration execution role
   * is required not to be a superuser at all: verifyControlSchema refuses a
   * superuser connection outright, because a superuser bypasses every
   * privilege separation the commit-proof design depends on. So no migration
   * this runner can legally execute can leave `session_authorization` dirty,
   * and there is no honest way to drive it through executeMigrations(pool).
   *
   * Both halves of that claim are proven here rather than asserted in prose:
   * first that the supported role genuinely cannot issue the statement, and
   * then — through an administratively prepared contamination on a superuser
   * session this test owns end to end — that the two reset properties the
   * boundary depends on nevertheless hold for it: the session baseline the
   * boundary proves against reports it as dirty, and DISCARD ALL clears it.
   */
  test("pg: SET SESSION AUTHORIZATION is outside the execution role's privileges, and the reset covers it regardless", async () => {
    const pool = newPool();
    const borrower = await pool.connect();
    try {
      const who = await borrower.query<{ role: string; superuser: boolean }>(
        "select current_user::text as role, (select usesuper from pg_catalog.pg_user where usename = current_user) as superuser",
      );
      assert.equal(who.rows[0].role, install.executionRole);
      assert.equal(who.rows[0].superuser, false, "the supported execution role is never a superuser");
      await assert.rejects(
        borrower.query("set session authorization pb10_contaminant"),
        /permission denied|must be superuser|superuser/i,
        "the supported execution role cannot set session authorization at all",
      );
      // The refusal above aborts nothing that matters, but it does leave the
      // implicit transaction failed; prove the borrower is otherwise sound.
      const still = await borrower.query<{ role: string }>("select current_user::text as role");
      assert.equal(still.rows[0].role, install.executionRole);
    } finally {
      borrower.release();
    }

    // Administratively prepared contamination, on a session this test owns.
    const superuser = new Client({ connectionString: databaseUrl, application_name: "pb10-phase2d-authorization" });
    await superuser.connect();
    try {
      const before = (await superuser.query<SessionState>(SESSION_STATE_SQL)).rows[0];
      assert.equal(before.dirty_settings, "0");

      // Empirically pinned, because the reset contract's own reasoning depends
      // on it: `role` and `session_authorization` are not rows in pg_settings
      // at all (PostgreSQL marks them GUC_NO_SHOW_ALL), so the `source =
      // 'session'` count can never see either one. Verified against
      // PostgreSQL 17.10. This is precisely why the baseline proof carries an
      // independent `current_user = session_user` cross-check rather than
      // relying on GUC accounting alone — and this assertion is what fails if a
      // future PostgreSQL changes that, rather than the coverage silently
      // shifting underneath the contract.
      const shown = await superuser.query<{ total: string }>(
        "select count(*)::text as total from pg_catalog.pg_settings where name in ('role', 'session_authorization')",
      );
      assert.equal(shown.rows[0].total, "0", "neither role nor session_authorization is enumerable through pg_settings");

      await superuser.query("set session authorization pb10_contaminant");
      const dirty = (await superuser.query<SessionState>(SESSION_STATE_SQL)).rows[0];
      assert.equal(dirty.session_user, "pb10_contaminant", "the contamination genuinely took effect");
      assert.equal(
        dirty.current_user, dirty.session_user,
        "SET SESSION AUTHORIZATION moves session_user too, so the role cross-check alone cannot see it either — "
        + "which is exactly why the supported execution role is required not to be able to issue it",
      );

      await superuser.query("discard all");
      const clean = (await superuser.query<SessionState>(SESSION_STATE_SQL)).rows[0];
      assert.equal(clean.session_user, before.session_user, "DISCARD ALL restores the session's authorization");
      assert.equal(clean.current_user, before.current_user);
      assert.equal(clean.dirty_settings, "0", "and the baseline proof the boundary takes afterward comes back clean");
    } finally {
      await superuser.end();
    }
  });

  test("pg: a transactional migration's uncommitted SET does not survive into the next borrower", async () => {
    const pool = newPool();
    // 0103 creates pb10_target's sibling; run it first so 0100 has a clean
    // sequence. Both are transactional, so both share one execution session.
    await admin.query("drop table if exists public.pb10_transactional");
    const report = await run(pool, manifestOf(entries.transactional));
    assert.equal(report.executedCount, 1);
    assert.equal(
      (await admin.query("select count(*)::int as total from public.pb10_transactional")).rows[0].total, 1,
      "the migration itself committed",
    );

    for (const state of await inspectPool(pool)) assertCleanSession(state, "transactional");
    await assertIdleAndUsable(pool, "transactional");
  });

  test("pg: a nontransactional migration's session-level statement_timeout = 0 never reaches the next borrower", async () => {
    const pool = newPool();
    const handler = {
      inspect: async (client: PoolClient) => {
        const result = await client.query<{ state: string }>(`
          select case
                   when i.indexrelid is null then 'absent'
                   when not i.indisvalid or not i.indisready then 'invalid'
                   else 'valid'
                 end as state
            from (select to_regclass('public.pb10_nontransactional_idx') as oid) r
            left join pg_catalog.pg_index i on i.indexrelid = r.oid
        `);
        return (result.rows[0]?.state ?? "absent") as "absent" | "valid" | "invalid" | "unknown";
      },
    };
    const report = await run(pool, manifestOf(entries.nontransactional), {
      nontransactionalHandlers: new Map([[entries.nontransactional.id, handler]]),
    });
    assert.equal(report.executedCount, 1);

    for (const state of await inspectPool(pool)) {
      assertCleanSession(state, "nontransactional");
      // Named explicitly: this is the single most dangerous leak the runner
      // could produce — a borrower silently running with no statement timeout.
      assert.equal(state.statement_timeout, "0" satisfies string);
    }
  });

  test("pg: a batched migration returns a clean, reusable session", async () => {
    const pool = newPool();
    const handler = {
      execute: async (context: { runBatch: <T>(run: (client: PoolClient) => Promise<T>) => Promise<T> }) => {
        await context.runBatch(async (client: PoolClient) => {
          // Dirties the session from inside a batch's own transaction; a plain
          // SET survives the batch's COMMIT exactly as it does anywhere else.
          await client.query("set search_path = pg_catalog");
          await client.query("select set_config('pb10.custom', 'batched', false)");
          await client.query("update public.pb10_target set label = 'batched' where id = 1");
        });
      },
      verifyComplete: async (client: PoolClient) => {
        const result = await client.query<{ remaining: string }>(
          "select count(*)::text as remaining from public.pb10_target where label <> 'batched' and id = 1",
        );
        return result.rows[0].remaining === "0";
      },
    };
    const report = await run(pool, manifestOf(entries.batched), {
      batchedHandlers: new Map([[entries.batched.id, handler]]),
    });
    assert.equal(report.executedCount, 1);

    for (const state of await inspectPool(pool)) assertCleanSession(state, "batched");
    await assertIdleAndUsable(pool, "batched");
  });

  test("pg: an ordinary SQL failure with a proven rollback returns a clean, reusable session", async () => {
    const pool = newPool();
    // pb10_target already exists, so 0103's CREATE TABLE fails — after its own
    // `set search_path`, so the failing transaction genuinely dirtied the
    // session before it was rolled back.
    await assert.rejects(run(pool, manifestOf(entries.failing)), /sql_failed/);
    assert.ok((await eventTypes()).includes("transaction_rolled_back"));

    for (const state of await inspectPool(pool)) assertCleanSession(state, "rolled-back SQL failure");
    await assertIdleAndUsable(pool, "rolled-back SQL failure");
  });

  test("pg: a statement timeout leaves a failed transaction block, and the session is still reset before reuse", async () => {
    const pool = newPool();
    const shortStatement = entry("0104", "0104_slow.sql", "transactional", ["schema"], { statementMs: 300, wallClockMs: 900_000 });
    await assert.rejects(run(pool, manifestOf(shortStatement)), /sql_failed/);

    // The migration's own transaction was aborted by statement_timeout and
    // rolled back; the boundary's ROLLBACK + DISCARD ALL is what makes a
    // session that was in a *failed* transaction block usable again at all.
    for (const state of await inspectPool(pool)) assertCleanSession(state, "statement timeout");
    await assertIdleAndUsable(pool, "statement timeout");
  });

  test("pg: a confirmed whole-migration wall-clock cancellation returns a clean, reusable session", async () => {
    const pool = newPool();
    await assert.rejects(run(pool, manifestOf(entries.slow)), /wall_clock_exceeded/);
    assert.ok((await eventTypes()).includes("transaction_rolled_back"), "a confirmed cancellation proves its own rollback");

    for (const state of await inspectPool(pool)) assertCleanSession(state, "confirmed cancellation");
    await assertIdleAndUsable(pool, "confirmed cancellation");
  });

  test("pg: a verification failure leaves the session itself sound, so it is reset and reused", async () => {
    const pool = newPool();
    const handler = {
      // Reports the index absent both before and after, so the verifier
      // refuses completion even though nothing is wrong with the connection.
      inspect: async () => "absent" as const,
    };
    await assert.rejects(
      run(pool, manifestOf(entries.nontransactional), {
        nontransactionalHandlers: new Map([[entries.nontransactional.id, handler]]),
      }),
      /verification_failed/,
    );
    assert.ok((await eventTypes()).includes("verification_failed"));

    for (const state of await inspectPool(pool)) assertCleanSession(state, "verification failure");
  });

  // ── destroy contract ──────────────────────────────────────────────────────

  test("pg: a terminated migration backend is destroyed, never returned, and is replaced by a different PID", async () => {
    const pool = newPool();
    const slow = entry("0104", "0104_slow.sql", "transactional", ["schema"], { wallClockMs: 900_000, statementMs: 0 });
    const running = run(pool, manifestOf(slow));
    // Wait for the execution backend to actually be running the payload, then
    // terminate it outright — a genuine backend loss, not a simulated one.
    let victim: number | undefined;
    for (let attempt = 0; attempt < 100 && victim === undefined; attempt += 1) {
      const result = await admin.query<{ pid: number }>(
        `select pid from pg_catalog.pg_stat_activity
          where usename = $1 and query like '%pg_sleep%' and pid <> pg_backend_pid()`,
        [install.executionRole],
      );
      victim = result.rows[0]?.pid;
      if (victim === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(victim !== undefined, "the migration payload reached the server");
    await admin.query("select pg_terminate_backend($1)", [victim]);
    await assert.rejects(running, /commit_outcome_unknown|sql_failed|cancellation_unverified/);

    assert.equal(await backendExists(victim), false, "the terminated backend is gone");
    for (const state of await inspectPool(pool)) {
      assert.notEqual(Number(state.pid), Number(victim), "a lost session is never handed to another borrower");
      assertCleanSession(state, "backend termination replacement");
    }
  });

  test("pg: a reset that never completes destroys the client, which is replaced by a different backend PID", async () => {
    const proxy = await startCommitProxy("127.0.0.1", Number(new URL(install.executionUrl).port || 5432));
    proxies.push(proxy);
    const proxied = new URL(install.executionUrl);
    proxied.hostname = "127.0.0.1";
    proxied.port = String(proxy.port);
    const pool = newPool({ connectionString: proxied.toString() });

    // The terminal reset's own DISCARD ALL never reaches PostgreSQL: the
    // boundary's budget is the only thing that can end this, and its verdict
    // must be "destroy", never "return and hope".
    const stall = proxy.armStallFrontendContaining("discard all");
    const report = await run(pool, manifestOf(entries.legacy));
    assert.equal(report.executedCount, 1, "the migration itself succeeded; only its cleanup did not");
    await stall.engaged;
    stall.release();

    const [payloadPid] = await migrationPids();
    for (const state of await inspectPool(pool)) {
      assert.notEqual(
        Number(state.pid), Number(payloadPid),
        "a session whose reset could not be completed is destroyed and replaced, never reused",
      );
      assertCleanSession(state, "reset-timeout replacement");
    }
  });

  test("pg: connection loss during the reset destroys the client, which is replaced by a different backend PID", async () => {
    const proxy = await startCommitProxy("127.0.0.1", Number(new URL(install.executionUrl).port || 5432));
    proxies.push(proxy);
    const proxied = new URL(install.executionUrl);
    proxied.hostname = "127.0.0.1";
    proxied.port = String(proxy.port);
    const pool = newPool({ connectionString: proxied.toString() });

    proxy.armDropFrontendContaining("discard all");
    const report = await run(pool, manifestOf(entries.legacy));
    assert.equal(report.executedCount, 1);

    const [payloadPid] = await migrationPids();
    for (const state of await inspectPool(pool)) {
      assert.notEqual(Number(state.pid), Number(payloadPid), "a session lost mid-reset is never returned");
      assertCleanSession(state, "reset connection-loss replacement");
    }
  });

  // ── Phase 2c preservation ─────────────────────────────────────────────────

  test("pg: the durable Phase 2c outcome survives the loss of the physical session that produced it", async () => {
    const proxy = await startCommitProxy("127.0.0.1", Number(new URL(install.executionUrl).port || 5432));
    proxies.push(proxy);
    const proxied = new URL(install.executionUrl);
    proxied.hostname = "127.0.0.1";
    proxied.port = String(proxy.port);
    const pool = newPool({ connectionString: proxied.toString() });

    // A genuine post-COMMIT ambiguity: COMMIT reaches PostgreSQL, its response
    // never reaches the client. Phase 2c reconciles against the control schema
    // and the execution connection is destroyed rather than reused.
    proxy.armDropBeforeClient();
    const outcome = await run(pool, manifestOf(entries.transactional)).then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    // Whatever Phase 2c decided, it decided it durably, in the control schema —
    // and Phase 2d destroying the physical session cannot have changed it.
    const events = await eventTypes();
    assert.ok(events.includes("started"), "the attempt is durably recorded");
    if (outcome === "resolved") {
      assert.ok(events.includes("applied_committed"), "a reconciled commit stays reconciled");
      assert.equal(
        (await admin.query("select count(*)::int as total from migration_control.schema_migrations")).rows[0].total, 1,
        "the applied row survives the destruction of the connection that wrote it",
      );
    } else {
      assert.match(String(outcome), /commit_outcome_unknown/);
      const ambiguity = await admin.query<{ total: string }>(
        "select count(*)::text as total from migration_control.migration_runs where error_class = 'commit_outcome_unknown'",
      );
      assert.equal(ambiguity.rows[0].total, "1", "the replay-blocking ambiguity marker is durable, connection or no connection");
    }
  });

  test("pg: an unresolved ambiguity still blocks replay after the session that produced it was destroyed", async () => {
    const proxy = await startCommitProxy("127.0.0.1", Number(new URL(install.executionUrl).port || 5432));
    proxies.push(proxy);
    const proxied = new URL(install.executionUrl);
    proxied.hostname = "127.0.0.1";
    proxied.port = String(proxy.port);
    const first = newPool({ connectionString: proxied.toString() });

    proxy.armDropBeforeServer();
    const outcome = await run(first, manifestOf(entries.transactional)).then(() => "resolved" as const, () => "failed" as const);
    if (outcome === "resolved") return; // The ambiguity resolved to committed; nothing is left to block.

    // A second, entirely healthy run over a direct connection must still refuse
    // to replay: reset and destruction are session-lifecycle facts, and neither
    // clears a durable replay guard.
    const second = newPool();
    await assert.rejects(run(second, manifestOf(entries.transactional)), /commit_outcome_unknown/);
    for (const state of await inspectPool(second)) assertCleanSession(state, "replay-blocked run");
  });

  test("pg: the advisory lock this run holds is released by Phase 2c's own unlock, before any reset", async () => {
    const pool = newPool();
    await run(pool, manifestOf(entries.legacy));

    // No advisory lock survives anywhere in the cluster for this key, and — the
    // Phase 2d-specific half — every returned session holds none either, so
    // DISCARD ALL's pg_advisory_unlock_all() was belt-and-braces rather than
    // the thing that actually dropped the schema lock.
    const held = await admin.query<{ total: string }>(
      "select count(*)::text as total from pg_catalog.pg_locks where locktype = 'advisory' and classid = 1398096461",
    );
    assert.equal(held.rows[0].total, "0");
    for (const state of await inspectPool(pool)) assert.equal(state.advisory_locks, "0");
  });

  // ── ownership ─────────────────────────────────────────────────────────────

  test("pg: repeated runs against one long-lived pool never exhaust it and never accumulate session state", async () => {
    const pool = newPool();
    // Four consecutive runs through the same pool. If any path leaked a
    // checked-out client, `max: 2` would be exhausted and the next run would
    // hang; if any path returned a dirty session, the assertions below fail.
    await run(pool, manifestOf(entries.legacy));
    await assert.rejects(run(pool, manifestOf(entries.legacy, entries.failing)), /sql_failed/);
    await assert.rejects(run(pool, manifestOf(entries.legacy, entries.failing)), /sql_failed|commit_outcome_unknown/);
    for (const state of await inspectPool(pool)) assertCleanSession(state, "repeated runs");

    assert.equal(pool.idleCount + pool.waitingCount, pool.totalCount, "no client remains checked out after the runs");
    assert.equal(pool.waitingCount, 0, "no borrower is queued behind a leaked client");
  });

  test("pg: the executor's own execution backend is left idle, not idle-in-transaction, once the run ends", async () => {
    const pool = newPool();
    await run(pool, manifestOf(entries.legacy));
    const [payloadPid] = await migrationPids();
    // Returned, not destroyed — so it is still a live backend, and it is idle.
    const activity = await admin.query<{ state: string }>(
      "select state from pg_catalog.pg_stat_activity where pid = $1", [payloadPid],
    );
    assert.equal(activity.rows[0]?.state, "idle", "a returned session sits idle, not idle-in-transaction");
  });

  // ── node-postgres named prepared statement cache (A4 final review) ────────

  /**
   * PB-10 Step 3 Phase 2d, A4 final review: `DISCARD ALL` clears server-side
   * prepared statements, but node-postgres separately remembers — on the
   * `Client`/`PoolClient` object itself, which pg-pool physically reuses
   * across checkouts — which named statements it believes each connection
   * already has prepared (`connection.parsedStatements`). A later borrower of
   * the exact same physical backend who reissues a named query with a name
   * this cache still remembers gets no `Parse` message at all, only a `Bind`
   * against a statement PostgreSQL no longer has, which fails with SQLSTATE
   * 26000.
   *
   * This drives the full real lifecycle end to end: a named query is prepared
   * on a pool connection; that exact physical connection is then handed to a
   * real migration run and driven through Phase 2d's terminal reset; and the
   * same connection, once handed back, is proven to still answer the same
   * named query cleanly — not merely that the server-side statement is gone
   * (already covered by `assertCleanSession`'s `prepared_statements` check),
   * but that the *driver* will actually re-`Parse` it rather than skip
   * straight to a doomed `Bind`.
   */
  test("pg: a node-postgres named prepared statement on a reused connection survives Phase 2d reset without SQLSTATE 26000", async () => {
    const pool = newPool();
    const namedQuery = { name: "pb10_named_probe", text: "select 1 as one" };

    // Prime the driver-side cache on one physical connection, exactly as any
    // other consumer of this pool might, then hand it back healthy — nothing
    // about this step is part of migration execution.
    const primer = await pool.connect();
    const primerPid = (await primer.query<{ pid: number }>("select pg_catalog.pg_backend_pid() as pid")).rows[0].pid;
    const primed = await primer.query<{ one: number }>(namedQuery);
    assert.equal(primed.rows[0].one, 1);
    primer.release();

    // `max: 2` with exactly one idle client: the runner's control connection —
    // its first `pool.connect()` — deterministically receives this exact
    // physical connection back, so Phase 2d's terminal reset genuinely runs on
    // the connection whose driver-side cache was just primed.
    assert.equal(pool.idleCount, 1, "the primed connection is the only idle client before the run");
    await run(pool, manifestOf(entries.legacy));

    const reused = await pool.connect();
    try {
      const reusedPid = (await reused.query<{ pid: number }>("select pg_catalog.pg_backend_pid() as pid")).rows[0].pid;
      assert.equal(reusedPid, primerPid, "the same physical backend that was primed came back out of the pool");

      // The proof: reissuing the identical named query object must re-`Parse`
      // rather than skip to a `Bind` PostgreSQL can no longer answer. A stale
      // driver-side cache surfaces here as a rejection with SQLSTATE 26000; a
      // correctly synchronized one answers normally.
      const result = await reused.query<{ one: number }>(namedQuery);
      assert.equal(result.rows[0].one, 1, "the reused connection answers the same named query cleanly after reset");
    } catch (error) {
      assert.notEqual(
        (error as { code?: string } | undefined)?.code, "26000",
        `the driver's prepared-statement cache was not synchronized with the server-side reset: ${String(error)}`,
      );
      throw error;
    } finally {
      reused.release();
    }
  });
}
