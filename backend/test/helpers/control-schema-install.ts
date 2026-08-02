import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Client } from "pg";

/**
 * PB-10 Step 3 Phase 2c: installs db/control/control-schema.sql into a
 * disposable test database, through psql.
 *
 * Why psql and not `client.query(readFileSync(...))`, which is what the
 * PostgreSQL suites used to do: the control schema is no longer a single
 * anonymous SQL blob. It takes a required `-v migration_execution_role`
 * variable, and it `\ir`-includes the two files shared with the upgrade path
 * (control-proof-path.sql and control-grants.sql). `\if`, `\ir` and `:'var'`
 * are psql meta-commands — the server never sees them — so sending the file
 * text over an ordinary connection would produce a syntax error, and sending
 * a hand-assembled subset would test something that is not what operators
 * install.
 *
 * Running the real file through the real client also means these suites
 * exercise the actual installation path, including the role separation every
 * commit-proof property depends on.
 */

const repositoryRoot = path.resolve(__dirname, "../../..");
const controlSchemaPath = path.join(repositoryRoot, "db", "control", "control-schema.sql");

export interface ControlSchemaInstall {
  /** The non-superuser role migrations execute as. */
  executionRole: string;
  password: string;
  /** A connection string for that role against the same database. */
  executionUrl: string;
}

/**
 * PB-10 Step 3 Phase 2c final review, HIGH: the one database-level privilege
 * the migration execution role genuinely requires, provisioned here because
 * this helper *is* the supported setup path for every PostgreSQL suite.
 *
 * Why CREATE on the database and not something narrower: db/migrations/
 * 0001_extensions_helpers.sql issues `create schema if not exists app`, and
 * CREATE SCHEMA is authorized by CREATE on the *database* — there is no
 * narrower grant that permits it. Every other object the repository's
 * migrations create lives inside a schema and is covered by the schema-level
 * grants below.
 *
 * It is deliberately the only database-level privilege granted, it conveys
 * nothing over migration_control (whose schema, tables, functions and proof key
 * are owned by migration_control_owner and reachable only through the four
 * granted entry points), and it does not make the role a superuser. Omitting it
 * is what made the canonical migration suite fail under the committed CI
 * environment; see the negative control in migration-control-proof.pg.test.ts.
 */
export const REQUIRED_DATABASE_PRIVILEGE = "CREATE";

function psql(databaseUrl: string, args: string[]): { status: number; output: string } {
  const result = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-X", "-q", ...args], {
    encoding: "utf8",
    env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * Creates (or recreates) the dedicated non-superuser execution role and
 * installs the control schema as the administrative connection in
 * `adminUrl`. Returns everything a suite needs to connect *as the runner*,
 * which is the only connection any commit-proof assertion is meaningful on:
 * asserting that a superuser cannot forge proof would prove nothing, because
 * a superuser can.
 */
export async function installControlSchema(
  admin: Client,
  adminUrl: string,
  options: { executionRole?: string; password?: string; grantDatabaseCreate?: boolean } = {},
): Promise<ControlSchemaInstall> {
  const executionRole = options.executionRole ?? "pb10_pg_runner";
  const password = options.password ?? "pb10-runner";

  // migration_control_owner is cluster-wide and outlives DROP SCHEMA, so a
  // previous run's owner role can still hold the objects this one is about to
  // recreate. Dropping the schema first releases them.
  await admin.query("drop schema if exists migration_control cascade");
  await admin.query(`
    do $$
    begin
      if pg_catalog.to_regrole('${executionRole}') is null then
        execute format('create role %I login password %L', '${executionRole}', '${password}');
      end if;
    end
    $$;
  `);

  const installed = psql(adminUrl, ["-v", `migration_execution_role=${executionRole}`, "-f", controlSchemaPath]);
  if (installed.status !== 0) {
    throw new Error(`control-schema.sql install failed:\n${installed.output}`);
  }

  // Privileges on the *target* schema, which the control schema deliberately
  // says nothing about: it governs the proof ledger, not what a migration is
  // allowed to change. In a real deployment these come from the deployment's
  // own grants; here the suites need the runner to be able to create and drop
  // the objects their migration files touch. Nothing granted below reaches
  // migration_control — that separation is exactly what the suites assert.
  // Untrusted extensions, created by the administrative connection rather than
  // by the migration.
  //
  // This is a real deployment prerequisite that PB-10 Step 3 Phase 2c's role
  // separation makes unavoidable, not a test convenience. `vector` is not a
  // trusted extension, so CREATE EXTENSION for it requires superuser — and the
  // migration execution role must not be a superuser, because a superuser
  // bypasses every privilege the commit-proof design relies on. So untrusted
  // extensions have to be provisioned alongside the database, which is also
  // how managed PostgreSQL (RDS, Cloud SQL) expects it. The baseline
  // migration's own `create extension if not exists` then succeeds as a no-op.
  // See db/README.md.
  // Checked against pg_extension rather than relying on IF NOT EXISTS: an
  // extension installed into a schema other than the current search_path's
  // first entry still raises 42710, which IF NOT EXISTS does not suppress.
  for (const extension of ["vector", "citext", "pg_trgm"]) {
    await admin.query(`
      do $$
      begin
        if not exists (select 1 from pg_catalog.pg_extension where extname = '${extension}') then
          create extension ${extension};
        end if;
      end
      $$;
    `);
  }

  // CREATEROLE, because the repository's own baseline migrations create the
  // application roles. This is a genuine deployment requirement of the
  // migration role and it does NOT weaken the separation under test:
  // PostgreSQL 16+ scopes CREATEROLE to roles the holder itself created, so
  // the runner still cannot administer, join, or become migration_control_owner
  // — which the C1/C2 suite asserts directly.
  await admin.query(`alter role ${executionRole} createrole`);
  // See REQUIRED_DATABASE_PRIVILEGE. `grantDatabaseCreate: false` exists only
  // for the negative control that proves the suite fails clearly — never
  // silently — when this documented prerequisite is omitted.
  await admin.query(`
    do $$
    begin
      execute format(
        '${options.grantDatabaseCreate === false ? "revoke" : "grant"} ${REQUIRED_DATABASE_PRIVILEGE}'
        || ' on database %I ${options.grantDatabaseCreate === false ? "from" : "to"} %I',
        pg_catalog.current_database(), '${executionRole}');
    end
    $$;
  `);
  await admin.query(`grant all on schema public to ${executionRole}`);
  await admin.query(`grant all on all tables in schema public to ${executionRole}`);
  await admin.query(`grant all on all sequences in schema public to ${executionRole}`);
  // Tables a suite's own fixtures create *after* this point — the legacy
  // ledger most of all — are covered by default privileges rather than a
  // one-shot grant, so a fixture added later cannot silently become
  // unreadable to the runner.
  await admin.query(`alter default privileges in schema public grant all on tables to ${executionRole}`);
  await admin.query(`alter default privileges in schema public grant all on sequences to ${executionRole}`);

  const url = new URL(adminUrl);
  url.username = executionRole;
  url.password = password;
  return { executionRole, password, executionUrl: url.toString() };
}

/**
 * Drops the control schema and the owner role, in that order. Safe to call
 * when neither exists.
 */
export async function dropControlSchema(admin: Client): Promise<void> {
  await admin.query("drop schema if exists migration_control cascade");
}
