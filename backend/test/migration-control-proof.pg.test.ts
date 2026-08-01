import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import { Client, Pool } from "pg";
import { assertDistinctDatabases } from "../src/db/migrate/database-identity";
import { installControlSchema, type ControlSchemaInstall } from "./helpers/control-schema-install";

/**
 * PB-10 Step 3 Phase 2c final review, CRITICAL 1 + CRITICAL 2 — the durable
 * PostgreSQL regressions.
 *
 *   MIGRATION_TEST_DATABASE_URL=postgres://... TEST_DATABASE_URL=postgres://... \
 *     node --import tsx --test test/migration-control-proof.pg.test.ts
 *
 * Everything here runs as the real, non-superuser migration execution role
 * against a real installation of db/control/control-schema.sql. That is the
 * whole point: the previous review checked these properties by hand in a psql
 * superuser session, which cannot prove any of them — a superuser bypasses
 * every privilege the design rests on, so "the runner cannot do X" is only
 * meaningful when asserted on a connection that actually holds the runner's
 * credentials.
 *
 * Two claims are under test, and they are claims about PostgreSQL, not about
 * TypeScript:
 *
 *   C1 — an accepted commit proof cannot be manufactured. The execution role
 *        has no INSERT on schema_migrations, cannot alter or replace the
 *        function that does, cannot reach the proof key, and cannot call the
 *        function outside the exact transaction its binding names.
 *   C2 — a transaction binding names a transaction that really executed
 *        claim_transaction for that exact attempt. The xid is read by the
 *        database from inside the caller's own transaction and is never an
 *        argument; the receipt is keyed by a secret the caller cannot read;
 *        and PostgreSQL's own unique indexes make duplicate, replacement and
 *        cross-attempt bindings impossible rather than merely detectable.
 */
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required for the PB-10 Phase 2c commit-proof PostgreSQL suite in CI");
}

if (!databaseUrl) {
  test("pg: commit-proof suite requires a dedicated disposable database", {
    skip: "MIGRATION_TEST_DATABASE_URL is not set; refusing to connect to a shared or unidentified database",
  }, () => undefined);
} else {
  const identity = {
    runnerId: "pb10-phase2c-proof",
    sourceGitSha: "5324116250977b5e8ac24bc83b6cae89ebcbd990",
    executorImageDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  };
  const CHECKSUM = "c".repeat(64);

  let admin: Client;
  let install: ControlSchemaInstall;
  let runner: Pool;

  /** A fresh 256-bit attempt token and the digest the ledger stores for it. */
  const newToken = (): { token: string; digest: Buffer } => {
    const token = randomBytes(32).toString("hex");
    return { token, digest: createHash("sha256").update(token, "utf8").digest() };
  };

  /**
   * Arms an attempt exactly as RunLog does: an ordinary `started` INSERT,
   * issued by the execution role through its own column-level privilege,
   * carrying only sha256(token). No test ever writes proof directly — that is
   * the thing being proven impossible.
   */
  const armAttempt = async (
    options: {
      runId?: string;
      migrationId?: string;
      sequence?: number;
      executionMode?: string;
      filename?: string;
      ordinal?: number;
      runnerId?: string | null;
    } = {},
  ): Promise<{ token: string; runId: string; migrationId: string }> => {
    const { token, digest } = newToken();
    const runId = options.runId ?? randomUUID();
    const migrationId = options.migrationId ?? "0100";
    const executionMode = options.executionMode ?? "transactional";
    const filename = options.filename ?? `${migrationId}_proof_demo.sql`;
    const ordinal = options.ordinal ?? 1;
    await runner.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id,
          source_git_sha, executor_image_digest, metadata, attempt_token_sha256)
       values ($1, $2, $3, 'started', $4, $5, $6, $7::jsonb, $8)`,
      [
        runId, migrationId, options.sequence ?? 1,
        options.runnerId === undefined ? identity.runnerId : options.runnerId,
        identity.sourceGitSha, identity.executorImageDigest,
        JSON.stringify({
          execution_mode: executionMode,
          migration_filename: filename,
          migration_ordinal: ordinal,
          checksum_sha256: CHECKSUM,
        }),
        digest,
      ],
    );
    return { token, runId, migrationId };
  };

  /** Runs `body` inside one real transaction on a dedicated runner connection. */
  const inTransaction = async <T>(body: (client: import("pg").PoolClient) => Promise<T>): Promise<T> => {
    const client = await runner.connect();
    try {
      await client.query("begin");
      const value = await body(client);
      await client.query("commit");
      return value;
    } catch (error) {
      try { await client.query("rollback"); } catch { /* connection already unusable */ }
      throw error;
    } finally {
      client.release();
    }
  };

  /** Asserts the runner is refused, and returns the SQLSTATE it was refused with. */
  const refused = async (sql: string, values: unknown[] = []): Promise<string> => {
    try {
      await runner.query(sql, values);
    } catch (error) {
      const code = (error as { code?: string }).code;
      assert.ok(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code), `expected a SQLSTATE, got ${String(error)}`);
      return code;
    }
    throw new assert.AssertionError({ message: `the execution role was NOT refused: ${sql}` });
  };

  before(async () => {
    await assertDistinctDatabases(
      { a: databaseUrl, b: process.env.TEST_DATABASE_URL },
      { a: "MIGRATION_TEST_DATABASE_URL", b: "TEST_DATABASE_URL" },
    );
    admin = new Client({ connectionString: databaseUrl, application_name: "pb10-proof-admin" });
    await admin.connect();
  });

  after(async () => {
    if (runner !== undefined) await runner.end();
    if (admin !== undefined) {
      await admin.query("drop schema if exists migration_control cascade");
      await admin.end();
    }
  });

  beforeEach(async () => {
    if (runner !== undefined) await runner.end();
    install = await installControlSchema(admin, databaseUrl!);
    runner = new Pool({ connectionString: install.executionUrl, max: 4, application_name: "pb10-proof-runner" });
  });

  // ══════════════════════════════════════════════════════════════════════
  // C1 — commit proof cannot be manufactured
  // ══════════════════════════════════════════════════════════════════════

  test("C1: the migration execution role is not a superuser and does not own the proof objects", async () => {
    const { rows } = await runner.query<{
      is_superuser: boolean; owns_schema: boolean; member_of_owner: boolean;
    }>(`
      select (select rolsuper from pg_catalog.pg_roles where rolname = current_user) as is_superuser,
             pg_catalog.pg_has_role(current_user, n.nspowner, 'USAGE') as owns_schema,
             coalesce(pg_catalog.pg_has_role(current_user,
               pg_catalog.to_regrole('migration_control_owner'), 'USAGE'), false) as member_of_owner
        from pg_catalog.pg_namespace n where n.nspname = 'migration_control'
    `);
    assert.deepEqual(rows[0], { is_superuser: false, owns_schema: false, member_of_owner: false });

    const owners = await runner.query<{ owner: string }>(`
      select distinct pg_catalog.pg_get_userbyid(relowner) as owner
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'migration_control' and c.relkind in ('r','p','S')
    `);
    assert.deepEqual(owners.rows.map(({ owner }) => owner), ["migration_control_owner"]);
  });

  /**
   * PB-10 Step 3 Phase 2c final review, CRITICAL: an H2 progress marker
   * authorizes SAFE_TO_RETRY, so it needs exactly the provenance commit proof
   * and transaction bindings have. Column-level INSERT is where that begins:
   * if the execution role could name statement_ordinal at all, it could
   * manufacture the evidence that authorizes replaying its own blocked
   * attempt.
   */
  test("CRITICAL: the execution role cannot write a progress marker directly", async () => {
    const { rows } = await runner.query<{ marker: boolean; binding: boolean; metadata: boolean }>(`
      select pg_catalog.has_column_privilege('migration_control.migration_runs', 'statement_ordinal', 'INSERT') as marker,
             pg_catalog.has_column_privilege('migration_control.migration_runs', 'xact_id', 'INSERT') as binding,
             pg_catalog.has_column_privilege('migration_control.migration_runs', 'metadata', 'INSERT') as metadata
    `);
    // metadata is the control: ordinary event columns are writable, and it is
    // specifically the two proof-bearing ones that are not.
    assert.deepEqual(rows[0], { marker: false, binding: false, metadata: true });

    const { runId, migrationId } = await armAttempt({ executionMode: "legacy-verbatim" });
    for (const ordinal of [1, 2]) {
      const code = await refused(
        `insert into migration_control.migration_runs
           (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha,
            executor_image_digest, metadata, statement_ordinal)
         values ($1, $2, $3, 'heartbeat', $4, $5, $6, '{}'::jsonb, $7)`,
        [runId, migrationId, 10 + ordinal, identity.runnerId, identity.sourceGitSha,
          identity.executorImageDigest, ordinal],
      );
      assert.equal(code, "42501", `forging marker ${ordinal} must be a privilege error, not a constraint error`);
    }
    const markers = await admin.query<{ total: string }>(
      `select count(*)::text as total from migration_control.migration_runs
        where event_type = 'heartbeat' and statement_ordinal is not null`);
    assert.equal(Number(markers.rows[0].total), 0);
  });

  /**
   * PB-10 Step 3 Phase 2c final review, HIGH — the negative control for the one
   * database-level privilege the migration role requires (see
   * REQUIRED_DATABASE_PRIVILEGE). Omitting it must fail loudly at the exact
   * statement that needs it, never silently skip or half-apply: the committed
   * CI provisioning path is what supplies it, and this case is what proves the
   * suite would notice if that provisioning were removed again.
   */
  test("HIGH: omitting the documented database CREATE privilege fails the migration role clearly", async () => {
    await runner.end();
    const withoutPrivilege = await installControlSchema(admin, databaseUrl!, { grantDatabaseCreate: false });
    runner = new Pool({ connectionString: withoutPrivilege.executionUrl, max: 4, application_name: "pb10-proof-runner" });
    await admin.query("drop schema if exists app cascade");

    const has = await runner.query<{ allowed: boolean }>(
      "select pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE') as allowed");
    assert.equal(has.rows[0].allowed, false, "the negative control must actually remove the privilege");
    // The exact statement db/migrations/0001_extensions_helpers.sql issues.
    const code = await refused("create schema if not exists app");
    assert.equal(code, "42501", "the omission surfaces as an explicit privilege error");

    // Restored for the following cases; beforeEach reinstalls anyway, but a
    // failure here must not leave the database without the prerequisite.
    await installControlSchema(admin, databaseUrl!);
  });

  // Part 4 item 1
  test("C1: the execution role cannot directly insert accepted commit proof", async () => {
    const code = await refused(
      `insert into migration_control.schema_migrations
         (migration_id, ordinal, filename, manifest_checksum_sha256, applied_checksum_sha256,
          lifecycle_phase, operation_categories, execution_mode, applied_at, run_id, baselined,
          source_git_sha, executor_image_digest, commit_proof)
       values ('0100', 1, '0100_proof_demo.sql', $1, $1, 'expand', array['schema'],
               'transactional', now(), $2, false, $3, $4, 'transaction_atomic')`,
      [CHECKSUM, randomUUID(), identity.sourceGitSha, identity.executorImageDigest],
    );
    assert.equal(code, "42501", "a direct applied-row INSERT must be a privilege error, not a constraint error");
    assert.equal(await appliedCount(), 0);
  });

  // Part 4 item 2
  test("C1: the execution role cannot update, delete or truncate proof rows", async () => {
    const { token } = await armAttempt({ executionMode: "legacy-verbatim" });
    await runner.query("select migration_control.record_applied_migration($1, $2, $3, $4::text[])",
      [token, CHECKSUM, "expand", ["schema"]]);
    assert.equal(await appliedCount(), 1, "the protected function is the one way a row appears");

    // Privilege is refused before any trigger can even fire.
    assert.equal(await refused("update migration_control.schema_migrations set baselined = true"), "42501");
    assert.equal(await refused("delete from migration_control.schema_migrations"), "42501");
    assert.equal(await refused("truncate migration_control.schema_migrations"), "42501");
    assert.equal(await refused("update migration_control.migration_runs set event_type = 'succeeded'"), "42501");
    assert.equal(await refused("delete from migration_control.migration_runs"), "42501");
    assert.equal(await refused("truncate migration_control.migration_runs"), "42501");
    assert.equal(await appliedCount(), 1);
  });

  // Part 4 items 3, 4, 5
  test("C1: the execution role cannot replace, alter or drop the protected objects, or attach a trigger to them", async () => {
    assert.equal(await refused(`
      create or replace function migration_control.record_applied_migration(
        attempt_token text, manifest_checksum_sha256 character(64),
        lifecycle_phase text, operation_categories text[])
      returns text language sql as $$ select 'transaction_atomic'::text $$`), "42501");
    assert.equal(await refused("drop function migration_control.record_applied_migration(text, character(64), text, text[])"), "42501");
    assert.equal(await refused("alter function migration_control.claim_transaction(text) security invoker"), "42501");
    assert.equal(await refused("alter schema migration_control rename to migration_control_x"), "42501");
    assert.equal(await refused("alter table migration_control.schema_migrations add column forged text"), "42501");
    assert.equal(await refused("alter table migration_control.schema_migrations drop constraint sm_commit_proof_mode_ck"), "42501");
    assert.equal(await refused("drop trigger schema_migrations_reject_mutation on migration_control.schema_migrations"), "42501");
    assert.equal(await refused("alter table migration_control.migration_runs disable trigger migration_runs_reject_mutation"), "42501");

    // A trigger that would manufacture proof on every ordinary event INSERT.
    assert.equal(await refused(`
      create function public.pb10_forge() returns trigger language plpgsql as $$
      begin
        insert into migration_control.schema_migrations
          (migration_id, ordinal, filename, manifest_checksum_sha256, applied_checksum_sha256,
           lifecycle_phase, operation_categories, execution_mode, applied_at, run_id, baselined,
           source_git_sha, executor_image_digest, commit_proof)
        values ('0100', 1, '0100_proof_demo.sql', repeat('c',64), repeat('c',64), 'expand',
                array['schema'], 'transactional', now(), gen_random_uuid(), false,
                '5324116250977b5e8ac24bc83b6cae89ebcbd990', 'sha256:' || repeat('0',64), 'transaction_atomic');
        return new;
      end $$;
      create trigger pb10_forge_trigger after insert on migration_control.migration_runs
      for each row execute function public.pb10_forge();`), "42501");
    assert.equal(await appliedCount(), 0);
  });

  // Part 4 item 6
  test("C1: the execution role cannot read the proof key or any secret material", async () => {
    assert.equal(await refused("select key from migration_control.proof_key"), "42501");
    assert.equal(await refused("select * from migration_control.proof_key"), "42501");
    // Nor via the function source, which would reveal the derivation but not
    // the key — checked anyway so a future refactor cannot leak one.
    const source = await runner.query<{ src: string }>(
      "select prosrc as src from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace"
      + " where n.nspname = 'migration_control' and p.proname = 'claim_transaction'");
    assert.ok(!/[0-9a-f]{64}/.test(source.rows[0]?.src ?? ""), "no key material may be embedded in the function body");
  });

  // Part 4 item 7 / Part 5 items 1, 2
  test("C2: the transaction claim is created by the exact execution transaction, and no caller can supply an xid", async () => {
    const { token, runId, migrationId } = await armAttempt();

    // The function takes no transaction id at any layer — there is no overload
    // that accepts one, so naming another transaction is not merely refused,
    // it is unexpressible.
    const signatures = await runner.query<{ args: string }>(
      "select pg_catalog.pg_get_function_arguments(p.oid) as args from pg_catalog.pg_proc p"
      + " join pg_catalog.pg_namespace n on n.oid = p.pronamespace"
      + " where n.nspname = 'migration_control' and p.proname = 'claim_transaction'");
    assert.deepEqual(signatures.rows.map(({ args }) => args), ["attempt_token text"]);

    const { claim, actualXid } = await inTransaction(async (client) => {
      const claimed = await client.query<{ claim: string }>(
        "select migration_control.claim_transaction($1) as claim", [token]);
      const current = await client.query<{ xid: string }>("select pg_current_xact_id()::text as xid");
      return { claim: claimed.rows[0].claim, actualXid: current.rows[0].xid };
    });
    assert.match(claim, /^[0-9]{1,20}:[0-9a-f]{64}$/);
    assert.equal(claim.split(":")[0], actualXid, "the claim names the caller's own real transaction");

    await runner.query("select migration_control.record_transaction_binding($1, $2, $3)", [token, 2, claim]);
    const bound = await admin.query<{ xact_id: string; run_id: string; migration_id: string; event_type: string }>(
      "select xact_id::text, run_id::text, migration_id, event_type from migration_control.migration_runs where xact_id is not null");
    assert.equal(bound.rows.length, 1);
    assert.equal(bound.rows[0].xact_id, actualXid);
    assert.equal(bound.rows[0].run_id, runId);
    assert.equal(bound.rows[0].migration_id, migrationId);
    assert.equal(bound.rows[0].event_type, "heartbeat");
  });

  // Part 5 items 3, 10, 11
  test("C2: a forged, replayed, or cross-attempt claim receipt is refused", async () => {
    const victim = await armAttempt({ migrationId: "0100" });
    const attacker = await armAttempt({ migrationId: "0100", runId: randomUUID(), sequence: 1 });

    const victimClaim = await inTransaction(async (client) => (
      await client.query<{ claim: string }>("select migration_control.claim_transaction($1) as claim", [victim.token])
    ).rows[0].claim);
    const [victimXid] = victimClaim.split(":");

    // A receipt invented from scratch, and one whose digest is simply flipped.
    for (const forged of [
      `${victimXid}:${"0".repeat(64)}`,
      `${victimXid}:${createHash("sha256").update("guess").digest("hex")}`,
      `${Number(victimXid) + 1}:${victimClaim.split(":")[1]}`,
    ]) {
      const code = await refused("select migration_control.record_transaction_binding($1, $2, $3)",
        [victim.token, 2, forged]);
      assert.equal(code, "42501", `a forged receipt must be refused: ${forged}`);
    }

    // Item 11: the victim's own authentic receipt, offered under another
    // attempt's token. The receipt is keyed to the attempt digest, so it is
    // not authentic for anyone else.
    assert.equal(
      await refused("select migration_control.record_transaction_binding($1, $2, $3)", [attacker.token, 2, victimClaim]),
      "42501",
      "another attempt's authentic receipt must not bind this one",
    );

    // Item 10: the authentic receipt binds once, and replaying it is refused
    // by PostgreSQL's own unique index (23505 on mr_one_binding_per_attempt /
    // mr_one_attempt_per_xact) rather than by a check the function performs.
    // That distinction matters: an index makes the second binding impossible,
    // where a pre-check would merely make it unlikely under concurrency.
    await runner.query("select migration_control.record_transaction_binding($1, $2, $3)", [victim.token, 2, victimClaim]);
    assert.equal(
      await refused("select migration_control.record_transaction_binding($1, $2, $3)", [victim.token, 3, victimClaim]),
      "23505",
      "a replayed receipt must be refused",
    );
    assert.equal(await bindingCount(), 1);
  });

  // Part 5 items 5, 6, 7, 8, 9
  test("C2: one attempt binds one transaction, one transaction binds one attempt, and neither can be replaced", async () => {
    const first = await armAttempt({ migrationId: "0100" });
    const second = await armAttempt({ migrationId: "0100", runId: randomUUID() });

    const bindFrom = async (token: string, sequence: number): Promise<string> => {
      const claim = await inTransaction(async (client) => (
        await client.query<{ claim: string }>("select migration_control.claim_transaction($1) as claim", [token])
      ).rows[0].claim);
      await runner.query("select migration_control.record_transaction_binding($1, $2, $3)", [token, sequence, claim]);
      return claim.split(":")[0];
    };

    const firstXid = await bindFrom(first.token, 2);
    const secondXid = await bindFrom(second.token, 2);
    assert.notEqual(firstXid, secondXid);
    assert.equal(await bindingCount(), 2);

    // Item 8: a second xid for an attempt that already has one. claim_transaction
    // itself refuses, before any receipt can even be produced.
    const secondClaimAttempt = await refusedInTransaction(
      "select migration_control.claim_transaction($1)", [first.token]);
    assert.equal(secondClaimAttempt, "55000", "an attempt with a durable binding cannot claim another transaction");

    // Item 9: the binding row is INSERT-only and immutable even to a would-be
    // replacement through the ordinary event path — the execution role has no
    // INSERT privilege on the xact_id column at all.
    assert.equal(
      await refused(
        `insert into migration_control.migration_runs
           (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha,
            executor_image_digest, metadata, xact_id)
         values ($1, '0100', 9, 'heartbeat', $2, $3, $4, '{}'::jsonb, $5::xid8)`,
        [first.runId, identity.runnerId, identity.sourceGitSha, identity.executorImageDigest, firstXid]),
      "42501",
      "the execution role may never name xact_id in an INSERT",
    );
    assert.equal(await refused("update migration_control.migration_runs set xact_id = null"), "42501");
    assert.equal(await bindingCount(), 2);
  });

  // Part 4 items 7, 9 / Part 5 item 1
  test("C1: commit proof cannot be recorded outside the exact bound transaction", async () => {
    const { token } = await armAttempt({ executionMode: "transactional" });

    // No binding yet: refused outright rather than recorded unprovably.
    assert.equal(
      await refused("select migration_control.record_applied_migration($1, $2, $3, $4::text[])",
        [token, CHECKSUM, "expand", ["schema"]]),
      "55000",
      "a transactional attempt with no binding must not record proof",
    );

    const claim = await inTransaction(async (client) => (
      await client.query<{ claim: string }>("select migration_control.claim_transaction($1) as claim", [token])
    ).rows[0].claim);
    await runner.query("select migration_control.record_transaction_binding($1, $2, $3)", [token, 2, claim]);

    // The bound transaction has already ended, so every later caller — in
    // autocommit, or in some *other* transaction — is refused. This is the
    // property that makes an applied row inseparable from one COMMIT.
    assert.equal(
      await refused("select migration_control.record_applied_migration($1, $2, $3, $4::text[])",
        [token, CHECKSUM, "expand", ["schema"]]),
      "42501",
      "proof must be refused outside the bound transaction",
    );
    assert.equal(
      await refusedInTransaction("select migration_control.record_applied_migration($1, $2, $3, $4::text[])",
        [token, CHECKSUM, "expand", ["schema"]]),
      "42501",
      "a different transaction is still not the bound one",
    );
    assert.equal(await appliedCount(), 0);
  });

  // Part 4 items 11, 12
  test("C1: a real commit creates proof atomically, and a rollback leaves none", async () => {
    // Committed: claim, bind, then record proof inside the very transaction
    // the binding names.
    const committed = await armAttempt({ migrationId: "0100", executionMode: "transactional" });
    const client = await runner.connect();
    try {
      await client.query("begin");
      const claim = (await client.query<{ claim: string }>(
        "select migration_control.claim_transaction($1) as claim", [committed.token])).rows[0].claim;
      // The binding is made durable on a *separate* connection in autocommit,
      // exactly as bindTransactionOutcome does, so it survives either outcome.
      await runner.query("select migration_control.record_transaction_binding($1, $2, $3)", [committed.token, 2, claim]);
      const proof = await client.query<{ commit_proof: string }>(
        "select migration_control.record_applied_migration($1, $2, $3, $4::text[]) as commit_proof",
        [committed.token, CHECKSUM, "expand", ["schema"]]);
      assert.equal(proof.rows[0].commit_proof, "transaction_atomic");
      assert.equal(await appliedCount(), 0, "the row is invisible to other sessions until COMMIT");
      await client.query("commit");
    } finally {
      client.release();
    }
    assert.equal(await appliedCount(), 1);
    const stored = await admin.query<{ commit_proof: string; applied_checksum_sha256: string }>(
      "select commit_proof, applied_checksum_sha256 from migration_control.schema_migrations where migration_id = '0100'");
    assert.equal(stored.rows[0].commit_proof, "transaction_atomic");
    assert.equal(stored.rows[0].applied_checksum_sha256, CHECKSUM,
      "the applied checksum is copied from the attempt's own started row, never supplied by the caller");

    // Rolled back: the identical sequence, ending in ROLLBACK, leaves no proof
    // at all — and PostgreSQL's own verdict on the bound transaction says so.
    const rolledBack = await armAttempt({ migrationId: "0200", executionMode: "transactional", ordinal: 2 });
    const other = await runner.connect();
    let rolledBackXid = "";
    try {
      await other.query("begin");
      const claim = (await other.query<{ claim: string }>(
        "select migration_control.claim_transaction($1) as claim", [rolledBack.token])).rows[0].claim;
      rolledBackXid = claim.split(":")[0];
      await runner.query("select migration_control.record_transaction_binding($1, $2, $3)", [rolledBack.token, 2, claim]);
      await other.query("select migration_control.record_applied_migration($1, $2, $3, $4::text[])",
        [rolledBack.token, CHECKSUM, "expand", ["schema"]]);
      await other.query("rollback");
    } finally {
      other.release();
    }
    const after = await admin.query("select 1 from migration_control.schema_migrations where migration_id = '0200'");
    assert.equal(after.rows.length, 0, "a rolled-back transaction leaves no accepted commit proof");

    // Part 5 item 14, and Part 5 item 17: the runner itself can read the
    // verdict, which is what lets an ordinary failed migration retry.
    const status = await runner.query<{ status: string | null }>(
      "select pg_catalog.pg_xact_status($1::xid8) as status", [rolledBackXid]);
    assert.equal(status.rows[0].status, "aborted");
    // The binding survived the rollback — that is why it can be asked about.
    assert.equal(await bindingCount(), 2);
  });

  // Part 4 item 10 / Part 5 item 4
  test("C1: an attempt token is single-use and identifies exactly one attempt", async () => {
    const { token, digest } = newToken();
    const runId = randomUUID();
    const insertStarted = (id: string, sequence: number) => runner.query(
      `insert into migration_control.migration_runs
         (run_id, migration_id, event_sequence, event_type, runner_id, source_git_sha,
          executor_image_digest, metadata, attempt_token_sha256)
       values ($1, $2, $3, 'started', $4, $5, $6, $7::jsonb, $8)`,
      [id, "0100", sequence, identity.runnerId, identity.sourceGitSha, identity.executorImageDigest,
        JSON.stringify({ execution_mode: "transactional", migration_filename: "0100_proof_demo.sql", migration_ordinal: 1, checksum_sha256: CHECKSUM }),
        digest]);

    await insertStarted(runId, 1);
    // mr_one_token_per_attempt: the same digest cannot arm a second attempt,
    // so one token can never resolve to two attempts.
    try {
      await insertStarted(randomUUID(), 1);
      assert.fail("a duplicate attempt token must be refused");
    } catch (error) {
      assert.equal((error as { code?: string }).code, "23505");
    }

    // An unknown token resolves to nothing at all.
    const unknown = randomBytes(32).toString("hex");
    assert.equal(await refused("select migration_control.claim_transaction($1)", [unknown]), "42501");
    assert.equal(await refused("select migration_control.record_applied_migration($1, $2, $3, $4::text[])",
      [unknown, CHECKSUM, "expand", ["schema"]]), "42501");
    // And a malformed one is rejected before any lookup.
    assert.equal(await refused("select migration_control.claim_transaction($1)", ["not-a-token"]), "42501");
    assert.equal(await refused("select migration_control.claim_transaction($1)", [null]), "42501");
  });

  // Part 4 item 8, Part 5 item 5: a second process, holding the execution
  // role's own credentials, cannot bind its transaction to somebody else's
  // attempt — the token it would need never leaves the arming process.
  test("C2: an unrelated process cannot bind its own transaction to another attempt", async () => {
    const victim = await armAttempt();
    const intruder = new Pool({ connectionString: install.executionUrl, max: 2, application_name: "pb10-proof-intruder" });
    try {
      // Everything the intruder can actually see about the victim attempt.
      const visible = await intruder.query<{ digest: string; run_id: string }>(
        "select encode(attempt_token_sha256, 'hex') as digest, run_id::text from migration_control.migration_runs where attempt_token_sha256 is not null");
      assert.equal(visible.rows.length, 1, "the digest is readable — that is deliberate, and it is not the token");
      const digest = visible.rows[0].digest;

      // The digest is not the token, and the functions demand the token.
      const client = await intruder.connect();
      try {
        await client.query("begin");
        for (const guess of [digest, digest.toUpperCase(), createHash("sha256").update(digest).digest("hex")]) {
          await assert.rejects(
            client.query("select migration_control.claim_transaction($1)", [guess]),
            (error: { code?: string }) => error.code === "42501",
            "a digest, however transformed, is not an attempt token",
          );
          await client.query("rollback");
          await client.query("begin");
        }
        await client.query("rollback");
      } finally {
        client.release();
      }
      assert.equal(await bindingCount(), 0);

      // The legitimate holder of the token still binds normally afterwards.
      const claim = await inTransaction(async (client) => (
        await client.query<{ claim: string }>("select migration_control.claim_transaction($1) as claim", [victim.token])
      ).rows[0].claim);
      await runner.query("select migration_control.record_transaction_binding($1, $2, $3)", [victim.token, 2, claim]);
      assert.equal(await bindingCount(), 1);
    } finally {
      await intruder.end();
    }
  });

  // Part 5 items 12, 13: the binding is durable before anything risky runs,
  // and it survives the loss of the transaction it describes.
  test("C2: the binding is durable before the migration transaction resolves, and outlives it either way", async () => {
    const { token } = await armAttempt();
    const client = await runner.connect();
    let xid = "";
    try {
      await client.query("begin");
      const claim = (await client.query<{ claim: string }>(
        "select migration_control.claim_transaction($1) as claim", [token])).rows[0].claim;
      xid = claim.split(":")[0];

      // Not durable yet: the claim is a value, not a row.
      assert.equal(await bindingCount(), 0);

      await runner.query("select migration_control.record_transaction_binding($1, $2, $3)", [token, 2, claim]);
      // Durable now, and visible from an entirely separate session, while the
      // migration transaction is still open and undecided.
      assert.equal(await bindingCount(), 1, "the binding must be committed before any risky SQL runs");

      // Simulate the crash: the connection dies with the transaction open.
      await client.query("select pg_terminate_backend(pg_backend_pid())").catch(() => undefined);
    } finally {
      client.release(new Error("connection destroyed"));
    }

    assert.equal(await bindingCount(), 1, "the binding outlives the transaction it names");
    const status = await runner.query<{ status: string | null }>(
      "select pg_catalog.pg_xact_status($1::xid8) as status", [xid]);
    assert.equal(status.rows[0].status, "aborted", "PostgreSQL's own verdict on the crashed transaction is available");
    assert.equal(await appliedCount(), 0);
  });

  // Part 5 items 17, 18
  test("C2: the execution role has exactly the pg_xact_status permission it needs, and no excess privilege", async () => {
    const { rows } = await runner.query<{
      xact_status: boolean; claim: boolean; bind: boolean; record: boolean;
      attempt_for_token: boolean; reject: boolean; canonical: boolean;
      schema_create: boolean; sequence_usage: boolean;
    }>(`
      select pg_catalog.has_function_privilege('pg_catalog.pg_xact_status(xid8)', 'EXECUTE') as xact_status,
             pg_catalog.has_function_privilege('migration_control.claim_transaction(text)', 'EXECUTE') as claim,
             pg_catalog.has_function_privilege('migration_control.record_transaction_binding(text, integer, text)', 'EXECUTE') as bind,
             pg_catalog.has_function_privilege('migration_control.record_applied_migration(text, character(64), text, text[])', 'EXECUTE') as record,
             pg_catalog.has_function_privilege('migration_control.attempt_for_token(text)', 'EXECUTE') as attempt_for_token,
             pg_catalog.has_function_privilege('migration_control.reject_ledger_mutation()', 'EXECUTE') as reject,
             pg_catalog.has_function_privilege('migration_control.canonical_operation_categories(text[])', 'EXECUTE') as canonical,
             pg_catalog.has_schema_privilege('migration_control', 'CREATE') as schema_create,
             pg_catalog.has_sequence_privilege('migration_control.migration_runs_event_id_seq', 'USAGE') as sequence_usage
    `);
    assert.deepEqual(rows[0], {
      // Needed: the three entry points, the sequence behind the event id, and
      // PostgreSQL's own transaction verdict.
      xact_status: true, claim: true, bind: true, record: true, sequence_usage: true,
      // Not needed, and deliberately absent: attempt_for_token is an internal
      // helper the three entry points call as their definer, and CREATE on the
      // schema would let the runner add objects of its own.
      attempt_for_token: false, reject: false, canonical: false, schema_create: false,
    });

    // No SELECT on the key, and no column-level INSERT on xact_id — asserted
    // together so a grant that widened either is caught here.
    const negative = await runner.query<{ key: boolean; binding: boolean; applied: boolean }>(`
      select coalesce(pg_catalog.has_table_privilege('migration_control.proof_key', 'SELECT'), false) as key,
             pg_catalog.has_column_privilege('migration_control.migration_runs', 'xact_id', 'INSERT') as binding,
             pg_catalog.has_table_privilege('migration_control.schema_migrations', 'INSERT') as applied
    `);
    assert.deepEqual(negative.rows[0], { key: false, binding: false, applied: false });
  });

  // Part 4 item 6 / hostile search_path (Part 9 item 19)
  test("C1: a hostile search_path cannot redirect any protected object", async () => {
    const { token } = await armAttempt({ executionMode: "legacy-verbatim" });
    const client = await runner.connect();
    try {
      // pg_temp is always searched first for unqualified relation names, so a
      // temp-schema shadow is the classic CVE-2018-1058 vector. Every function
      // carries a fixed `search_path = pg_catalog, pg_temp` and refers to its
      // own objects schema-qualified, so none of this can be consulted.
      await client.query("create temp table proof_key (singleton boolean, key bytea)");
      await client.query("insert into proof_key values (true, sha256('forged'::bytea))");
      await client.query("create temp table schema_migrations (migration_id text)");
      await client.query("set search_path = pg_temp, public");

      const proof = await client.query<{ commit_proof: string }>(
        "select migration_control.record_applied_migration($1, $2, $3, $4::text[]) as commit_proof",
        [token, CHECKSUM, "expand", ["schema"]]);
      assert.equal(proof.rows[0].commit_proof, "post_hoc_verified");
    } finally {
      client.release();
    }
    // The row landed in the real ledger, not the shadow.
    assert.equal(await appliedCount(), 1);
    const shadowed = await admin.query<{ total: string }>(
      "select count(*)::text as total from migration_control.schema_migrations where migration_id = '0100'");
    assert.equal(Number(shadowed.rows[0].total), 1);
  });

  async function appliedCount(): Promise<number> {
    const { rows } = await admin.query<{ total: string }>(
      "select count(*)::text as total from migration_control.schema_migrations");
    return Number(rows[0].total);
  }

  async function bindingCount(): Promise<number> {
    const { rows } = await admin.query<{ total: string }>(
      "select count(*)::text as total from migration_control.migration_runs where xact_id is not null");
    return Number(rows[0].total);
  }

  /** Like `refused`, but the statement runs inside its own real transaction. */
  async function refusedInTransaction(sql: string, values: unknown[] = []): Promise<string> {
    const client = await runner.connect();
    try {
      await client.query("begin");
      await client.query(sql, values);
      await client.query("rollback");
      throw new assert.AssertionError({ message: `the execution role was NOT refused inside a transaction: ${sql}` });
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      try { await client.query("rollback"); } catch { /* already aborted */ }
      const code = (error as { code?: string }).code;
      assert.ok(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code), `expected a SQLSTATE, got ${String(error)}`);
      return code;
    } finally {
      client.release();
    }
  }
}
