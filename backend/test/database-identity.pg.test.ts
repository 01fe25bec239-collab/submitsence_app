import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Client } from "pg";
import { assertDistinctDatabases } from "../src/db/migrate/database-identity";

/**
 * Real-PostgreSQL contract for the database-identity guard used at the
 * destructive migration test-suite boundary (see migration-execute.pg.test.ts).
 * Registered only when a disposable target is supplied.
 *
 *   MIGRATION_TEST_DATABASE_URL=postgres://... node --import tsx --test test/database-identity.pg.test.ts
 */
const baseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required for the database-identity PostgreSQL suite in CI");
}

if (!baseUrl) {
  test("pg: database-identity suite requires a dedicated disposable database", {
    skip: "MIGRATION_TEST_DATABASE_URL is not set",
  }, () => undefined);
} else {
  const parsed = new URL(baseUrl);
  const probeRole = "pb10_identity_probe_role";
  const probePassword = "pb10-identity-probe";
  let admin: Client;

  const withUser = (url: string, user: string, password: string): string => {
    const copy = new URL(url);
    copy.username = user;
    copy.password = password;
    return copy.toString();
  };
  const withHost = (url: string, host: string): string => {
    const copy = new URL(url);
    copy.hostname = host;
    return copy.toString();
  };
  const withQuery = (url: string, query: string): string => `${url}${url.includes("?") ? "&" : "?"}${query}`;

  before(async () => {
    admin = new Client({ connectionString: baseUrl, application_name: "pb10-identity-admin" });
    await admin.connect();
    await admin.query(`drop role if exists ${probeRole}`);
    await admin.query(`create role ${probeRole} login password '${probePassword}' superuser`);
  });

  after(async () => {
    await admin.query(`drop role if exists ${probeRole}`);
    await admin.end();
  });

  test("pg: exact same URL rejects", async () => {
    await assert.rejects(
      assertDistinctDatabases({ a: baseUrl, b: baseUrl }, { a: "A", b: "B" }),
    );
  });

  test("pg: same database with different users rejects", async () => {
    const asProbe = withUser(baseUrl, probeRole, probePassword);
    await assert.rejects(
      assertDistinctDatabases({ a: baseUrl, b: asProbe }, { a: "A", b: "B" }),
    );
  });

  test("pg: localhost and 127.0.0.1 aliases reject", async () => {
    if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) return; // ponytail: only meaningful for local CI/dev targets
    const alias = parsed.hostname === "localhost" ? "127.0.0.1" : "localhost";
    await assert.rejects(
      assertDistinctDatabases({ a: baseUrl, b: withHost(baseUrl, alias) }, { a: "A", b: "B" }),
    );
  });

  test("pg: reordered URL parameters reject", async () => {
    const withParamsA = withQuery(baseUrl, "application_name=probe-a&sslmode=disable");
    const withParamsB = withQuery(baseUrl, "sslmode=disable&application_name=probe-a");
    await assert.rejects(
      assertDistinctDatabases({ a: withParamsA, b: withParamsB }, { a: "A", b: "B" }),
    );
  });

  test("pg: differently encoded equivalent URLs reject", async () => {
    const dbName = parsed.pathname.replace(/^\//, "");
    // Percent-encode the first character so the URL text differs but decodes
    // to the identical database name (e.g. "m" -> "%6D...").
    const percentEncodedFirstChar = `%${dbName.charCodeAt(0).toString(16).toUpperCase()}${dbName.slice(1)}`;
    const encoded = baseUrl.replace(`/${dbName}`, `/${percentEncodedFirstChar}`);
    await assert.rejects(
      assertDistinctDatabases({ a: baseUrl, b: encoded }, { a: "A", b: "B" }),
    );
  });

  test("pg: two distinct databases in the same cluster pass", async () => {
    const otherDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (!otherDatabaseUrl) return; // covered explicitly in migration-execute.pg.test.ts under CI
    await assert.doesNotReject(
      assertDistinctDatabases({ a: baseUrl, b: otherDatabaseUrl }, { a: "A", b: "B" }),
    );
  });

  test("pg: missing migration URL fails clearly", async () => {
    await assert.rejects(
      assertDistinctDatabases({ a: undefined, b: baseUrl }, { a: "MIGRATION_TEST_DATABASE_URL", b: "TEST_DATABASE_URL" }),
      /MIGRATION_TEST_DATABASE_URL is required/,
    );
  });

  test("pg: no destructive query executes before equality rejection", async () => {
    await admin.query("drop table if exists public.pb10_identity_probe_marker");
    await admin.query("create table public.pb10_identity_probe_marker (id integer primary key)");
    try {
      let destructiveQueryRan = false;
      const runGuardedDestructiveStep = async () => {
        await assertDistinctDatabases({ a: baseUrl, b: baseUrl }, { a: "A", b: "B" });
        destructiveQueryRan = true;
        await admin.query("drop table public.pb10_identity_probe_marker");
      };
      await assert.rejects(runGuardedDestructiveStep());
      assert.equal(destructiveQueryRan, false);
      const stillPresent = await admin.query<{ present: boolean }>(
        "select pg_catalog.to_regclass('public.pb10_identity_probe_marker') is not null as present",
      );
      assert.equal(stillPresent.rows[0]?.present, true);
    } finally {
      await admin.query("drop table if exists public.pb10_identity_probe_marker");
    }
  });
}
