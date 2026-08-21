import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import test, { mock } from "node:test";
import type { Pool } from "pg";
import { executeMigrations, MigrationExecutionError } from "../src/db/migrate/execute";
import { reportDestroyedMigrationClient, reportSanitizedPoolError } from "../src/db/migrate/execution-errors";
import { runMigrationPlan } from "../src/db/migrate/runner";

const CANARIES = [
  "PHASE2E_PASSWORD_CANARY",
  "postgresql://phase2e_user:PHASE2E_PASSWORD_CANARY@phase2e-host.invalid:6543/phase2e_db",
  "select phase2e_sql_canary from phase2e_secret_table",
  "phase2e-host.internal",
  "PHASE2E_CERTIFICATE_CANARY",
];

function assertSafe(output: string, classification: string): void {
  assert.match(output, new RegExp(classification));
  for (const canary of CANARIES) assert.doesNotMatch(output, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(output, /\n\s*at |node_modules|db\/migrate\/|password|postgres(?:ql)?:\/\//i);
}

function rejectingPool(value: unknown): Pool {
  return new class extends EventEmitter {
    async connect(): Promise<never> { throw value; }
  }() as unknown as Pool;
}

test("phase2e: executeMigrations strips forged trust, AggregateError properties, cycles, proxies, and secrets", async () => {
  const previous = {
    source: process.env.MIGRATION_SOURCE_GIT_SHA,
    digest: process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST,
    runner: process.env.MIGRATION_RUNNER_ID,
  };
  process.env.MIGRATION_SOURCE_GIT_SHA = "5324116250977b5e8ac24bc83b6cae89ebcbd990";
  process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
  process.env.MIGRATION_RUNNER_ID = "pb10-phase2e-hostile";
  const cyclic: Record<string, unknown> = { secret: CANARIES[0] };
  cyclic.self = cyclic;
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const forgedKnownError = new MigrationExecutionError("sql_failed", CANARIES.join(" "), "0100", "42601") as MigrationExecutionError & Record<string, unknown>;
  forgedKnownError.cause = { secret: CANARIES[0] };
  const nested = Object.assign(new Error(CANARIES[0], { cause: cyclic }), {
    query: CANARIES[2], host: CANARIES[3], driver: { certificate: CANARIES[4] },
  });
  const aggregate = Object.assign(new AggregateError([nested, cyclic], CANARIES[0], { cause: nested }), {
    sql: CANARIES[2], host: CANARIES[3], metadata: cyclic,
  });
  const hostile = [
    aggregate,
    Object.assign(Object.create(null), { secret: CANARIES[0] }),
    { [Symbol.toPrimitive]() { throw new Error(CANARIES[0]); }, toString() { throw new Error(CANARIES[0]); }, valueOf() { throw new Error(CANARIES[0]); } },
    new Proxy({}, { get() { throw new Error(CANARIES[0]); }, getPrototypeOf() { throw new Error(CANARIES[0]); } }),
    revoked.proxy,
    cyclic,
    forgedKnownError,
  ];
  try {
    for (const thrown of hostile) {
      await assert.rejects(executeMigrations(rejectingPool(thrown)), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.stack, undefined);
        assert.equal("cause" in error, false);
        assertSafe(`${error.name}: ${error.message} ${JSON.stringify(error)} ${inspect(error, { depth: 8 })}`, thrown === aggregate ? "Multiple migration failures occurred" : "PB10_MIGRATION_EXECUTION_FAILED");
        if (thrown === aggregate) {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(Reflect.ownKeys(error).sort(), ["errors", "message", "stack"]);
          assert.equal(error.errors.length, 2);
          for (const member of error.errors) {
            assert.ok(member instanceof Error);
            assert.deepEqual(Reflect.ownKeys(member).sort(), ["code", "message", "name", "stack"]);
          }
        }
        return true;
      });
    }
  } finally {
    if (previous.source === undefined) delete process.env.MIGRATION_SOURCE_GIT_SHA; else process.env.MIGRATION_SOURCE_GIT_SHA = previous.source;
    if (previous.digest === undefined) delete process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST; else process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = previous.digest;
    if (previous.runner === undefined) delete process.env.MIGRATION_RUNNER_ID; else process.env.MIGRATION_RUNNER_ID = previous.runner;
  }
});

test("phase2e: application executeMigrations rejection is sanitized while safe execution classification survives", async () => {
  const previous = {
    source: process.env.MIGRATION_SOURCE_GIT_SHA,
    digest: process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST,
    runner: process.env.MIGRATION_RUNNER_ID,
  };
  process.env.MIGRATION_SOURCE_GIT_SHA = "5324116250977b5e8ac24bc83b6cae89ebcbd990";
  process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
  process.env.MIGRATION_RUNNER_ID = "pb10-phase2e";
  const raw = new Error(CANARIES.join(" "), { cause: { password: CANARIES[0] } }) as Error & Record<string, unknown>;
  Object.assign(raw, { query: CANARIES[2], detail: CANARIES[0], host: CANARIES[3], cert: CANARIES[4] });
  try {
    await assert.rejects(executeMigrations(rejectingPool(raw)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assertSafe(`${error.name}: ${error.message} code=${(error as Error & { code?: string }).code} ${JSON.stringify(error)} ${inspect(error)}`, "PB10_MIGRATION_EXECUTION_FAILED");
      return true;
    });
    process.env.MIGRATION_SOURCE_GIT_SHA = "invalid";
    await assert.rejects(executeMigrations(rejectingPool(raw)), (error: unknown) => {
      const classified = error as MigrationExecutionError;
      assert.equal(classified.errorClass, "identity_missing");
      assert.equal(classified.migrationId, null);
      assert.equal(classified.sqlstate, null);
      assert.match(classified.message, /identity_missing/);
      return true;
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const name = { source: "MIGRATION_SOURCE_GIT_SHA", digest: "MIGRATION_EXECUTOR_IMAGE_DIGEST", runner: "MIGRATION_RUNNER_ID" }[key] as keyof NodeJS.ProcessEnv;
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("phase2e: public runMigrationPlan rejection is sanitized at the application boundary", async () => {
  const raw = Object.assign(new Error(CANARIES.join(" "), { cause: { secret: CANARIES[0] } }), {
    query: CANARIES[2], host: CANARIES[3], certificate: CANARIES[4],
  });
  await assert.rejects(runMigrationPlan(rejectingPool(raw), { manifest: { schemaVersion: 1, legacyBoundary: "0099", migrations: [] } }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Migration plan failed");
    assert.equal((error as Error & { code?: string }).code, "PB10_MIGRATION_PLAN_FAILED");
    assert.equal(error.stack, undefined);
    assert.deepEqual(Reflect.ownKeys(error).sort(), ["code", "message", "name", "stack"]);
    assertSafe(`${error.name}: ${error.message} ${JSON.stringify(error)} ${inspect(error)}`, "Migration plan failed");
    return true;
  });
});

test("phase2e: fresh emitted modules expose no trusted constructor or sanitizer internals", () => {
  const buildRoot = mkdtempSync(path.join(os.tmpdir(), "pb10-phase2e-build-"));
  try {
    const output = path.join(buildRoot, "dist");
    const built = spawnSync(process.execPath, [
      path.resolve(__dirname, "../node_modules/typescript/bin/tsc"),
      "--project", path.resolve(__dirname, "../tsconfig.json"),
      "--outDir", output,
      "--declaration",
    ], { encoding: "utf8" });
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
    const migrateOutput = path.join(output, "db", "migrate");
    const probe = spawnSync(process.execPath, ["-e", `
      const assert = require("node:assert/strict");
      const path = require("node:path");
      const root = ${JSON.stringify("__MIGRATE_OUTPUT__")}.replace("__MIGRATE_OUTPUT__", process.argv[1]);
      for (const name of ["execution-errors", "execute", "runner", "manifest"]) {
        const runtime = require(path.join(root, name + ".js"));
        for (const forbidden of ["TrustedMigrationExecutionError", "SanitizedDiagnosticError", "sanitizeMigrationError", "renderSanitizedMigrationError", "writeSanitizedMigrationError", "classify", "sqlstateOf"]) {
          assert.equal(forbidden in runtime, false, name + ".js exposes " + forbidden);
        }
      }
    `, migrateOutput], {
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: path.resolve(__dirname, "../node_modules") },
    });
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    for (const name of ["execution-errors", "execute", "runner", "manifest"]) {
      const declaration = readFileSync(path.join(migrateOutput, `${name}.d.ts`), "utf8");
      assert.doesNotMatch(declaration, /TrustedMigrationExecutionError|SanitizedDiagnosticError|sanitizeMigrationError|renderSanitizedMigrationError|writeSanitizedMigrationError/);
    }
    assert.match(readFileSync(path.join(migrateOutput, "execution-errors.d.ts"), "utf8"), /class MigrationExecutionError/);
  } finally {
    rmSync(buildRoot, { recursive: true, force: true });
  }
});

test("phase2e: CI binds both diagnostic streams, sanitizer status, and PostgreSQL scenario provenance", () => {
  const workflow = readFileSync(path.resolve(__dirname, "../../.github/workflows/ci.yml"), "utf8");
  const databaseJob = workflow.slice(workflow.indexOf("  database:"), workflow.indexOf("  infrastructure:"));
  // The sanitizer path must be one the Actions runner can resolve on its own.
  // A custom shell is not run through a shell, so `$GITHUB_WORKSPACE` (or any
  // other interpolation) is passed literally and every run step dies with
  // exit 127 before reaching its boundary; a relative path breaks the steps
  // that set `working-directory: backend`. Only an Actions expression, which
  // the workflow engine resolves to a literal absolute path, is executable.
  assert.match(databaseJob, /shell: bash --noprofile --norc \$\{\{ github\.workspace \}\}\/infra\/scripts\/sanitize-ci-stderr\.sh \{0\}/);
  const shellLine = databaseJob.slice(databaseJob.indexOf("shell:"), databaseJob.indexOf("\n", databaseJob.indexOf("shell:")));
  assert.doesNotMatch(shellLine, /\$[A-Za-z_(]/, "a custom shell definition is never expanded by a shell");
  assert.match(databaseJob, /Verify CI diagnostic stream and status propagation[\s\S]*sanitize-ci-stderr\.sh --self-test/);
  assert.doesNotMatch(databaseJob, /2>&1\s*\|\s*tee/, "database diagnostics must never be merged into stdout ahead of the boundary");
  assert.match(databaseJob, /grep -qx '# pass 4' "\$log"/);
  assert.match(databaseJob, /grep -qx '# fail 0' "\$log"/);
  assert.match(databaseJob, /grep -qx '# skipped 0' "\$log"/);
  for (const scenario of [
    "a real PostgreSQL ErrorResponse is sanitized at executeMigrations",
    "real PostgreSQL query text and driver fields never cross the application boundary",
    "a real PostgreSQL ErrorResponse is sanitized at public runMigrationPlan",
    "advisory-lock contention ages cross the diagnostic allowlist as bounded text",
  ]) assert.match(databaseJob, new RegExp(scenario));
  assert.match(databaseJob, /grep -qx "Migration plan failed" \/tmp\/divergence\.err/);
  assert.match(databaseJob, /migration_control\.schema_migrations[\s\S]*public\.infrastructure_schema_migrations/);
});

test("phase2e: CLI runner and manifest stderr boundaries emit only fixed diagnostics", () => {
  const repositoryRoot = path.resolve(__dirname, "../..");
  const common = { ...process.env, MIGRATION_SOURCE_GIT_SHA: "5324116250977b5e8ac24bc83b6cae89ebcbd990", MIGRATION_EXECUTOR_IMAGE_DIGEST: `sha256:${"9".repeat(64)}`, MIGRATION_RUNNER_ID: "pb10-phase2e" };
  const runner = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate/runner.ts", "execute", "--json"], {
    cwd: path.join(repositoryRoot, "backend"), encoding: "utf8", env: { ...common, DATABASE_URL: "postgresql://phase2e_user:PHASE2E_PASSWORD_CANARY@127.0.0.1:1/phase2e_db" },
  });
  assert.notEqual(runner.status, 0);
  assertSafe(runner.stderr, "Migration execution failed");

  const manifest = spawnSync(process.execPath, ["--import", "tsx", "src/db/migrate/manifest.ts", CANARIES[0]], {
    cwd: path.join(repositoryRoot, "backend"), encoding: "utf8", env: common,
  });
  assert.notEqual(manifest.status, 0);
  assertSafe(manifest.stderr, "Migration manifest operation failed");
});

test("phase2e: warning boundaries allowlist code and cannot interrupt finalization", () => {
  const seen: string[] = [];
  const warning = mock.method(process, "emitWarning", ((message: string) => { seen.push(message); }) as typeof process.emitWarning);
  const hostile = new Proxy({}, { has() { throw new Error(CANARIES[0]); }, get() { throw new Error(CANARIES[0]); } });
  reportSanitizedPoolError(hostile);
  reportDestroyedMigrationClient(hostile);
  warning.mock.restore();
  assert.equal(seen.length, 2);
  for (const output of seen) assertSafe(output, "code=UNKNOWN");

  const throwing = mock.method(process, "emitWarning", (() => { throw new Error(CANARIES[0]); }) as typeof process.emitWarning);
  assert.doesNotThrow(() => reportSanitizedPoolError(hostile));
  assert.doesNotThrow(() => reportDestroyedMigrationClient(hostile));
  throwing.mock.restore();
});
