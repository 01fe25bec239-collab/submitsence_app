import { existsSync, promises as fs } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { mock } from "node:test";
import type { Pool } from "pg";
import type {
  ExecutionIdentity,
  ExecutionReport,
} from "../../src/db/migrate/execute";
import type { MigrationManifest } from "../../src/db/migrate/manifest";

const cryptoImport = require("node:crypto") as typeof import("node:crypto") & { default?: typeof import("node:crypto") };
const manifestImport = require("../../src/db/migrate/manifest") as typeof import("../../src/db/migrate/manifest") & {
  default?: typeof import("../../src/db/migrate/manifest");
};
const cryptoModule = cryptoImport.default ?? cryptoImport;
const manifestModule = manifestImport.default ?? manifestImport;

export interface TestExecuteOptions {
  manifest?: MigrationManifest;
  repositoryRoot?: string;
  identity?: ExecutionIdentity;
  runId?: `${string}-${string}-${string}-${string}-${string}`;
  now?: () => number;
  /**
   * PB-10 Step 3 Phase 2b: deterministically controls the sleep used by
   * superviseOperation/superviseCallback's Promise.race, so wall-clock and
   * cancellation-confirmation timing can be driven by a test instead of a
   * real timer. Stubs node:timers/promises the same way manifest checking
   * is stubbed above: a Module._load interception scoped to execute.ts's own
   * import, not a production-reachable hook.
   */
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Test-side dependency substitution around the real production entry point.
 * No synthetic input crosses executeMigrations()'s runtime boundary.
 */
export async function executeMigrationsForTest(pool: Pool, options: TestExecuteOptions): Promise<ExecutionReport> {
  const originalCheckManifest = manifestModule.checkManifest;
  const originalReadFile = fs.readFile.bind(fs);
  const executePath = require.resolve("../../src/db/migrate/execute");
  const moduleLoader = Module as typeof Module & {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function load(request, parent, isMain) {
    if (request === "./manifest" && parent?.filename === executePath) {
      return {
        ...manifestModule,
        checkManifest: async () => options.manifest ?? originalCheckManifest(options.repositoryRoot),
      };
    }
    if (options.sleep && request === "node:timers/promises" && parent?.filename === executePath) {
      const real = originalLoad.call(this, request, parent, isMain) as typeof import("node:timers/promises");
      return { ...real, setTimeout: options.sleep };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[executePath];
  let executeMigrations: typeof import("../../src/db/migrate/execute").executeMigrations;
  try {
    ({ executeMigrations } = require(executePath) as typeof import("../../src/db/migrate/execute"));
  } finally {
    moduleLoader._load = originalLoad;
  }
  const readMock = options.repositoryRoot
    ? mock.method(fs, "readFile", async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
      const fixture = path.join(options.repositoryRoot!, "db", "migrations", path.basename(String(target)));
      return Reflect.apply(originalReadFile, fs, [
        existsSync(fixture) ? fixture : target,
        ...args,
      ]) as ReturnType<typeof fs.readFile>;
    })
    : undefined;
  const uuidMock = options.runId ? mock.method(cryptoModule, "randomUUID", () => options.runId!) : undefined;
  const nowMock = options.now ? mock.method(Date, "now", options.now) : undefined;

  const previous = {
    source: process.env.MIGRATION_SOURCE_GIT_SHA,
    digest: process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST,
    runner: process.env.MIGRATION_RUNNER_ID,
  };
  if (options.identity) {
    process.env.MIGRATION_SOURCE_GIT_SHA = options.identity.sourceGitSha;
    process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = options.identity.executorImageDigest;
    if (options.identity.runnerId === null) delete process.env.MIGRATION_RUNNER_ID;
    else process.env.MIGRATION_RUNNER_ID = options.identity.runnerId;
  }

  try {
    return await executeMigrations(pool);
  } finally {
    readMock?.mock.restore();
    uuidMock?.mock.restore();
    nowMock?.mock.restore();
    delete require.cache[executePath];
    if (previous.source === undefined) delete process.env.MIGRATION_SOURCE_GIT_SHA;
    else process.env.MIGRATION_SOURCE_GIT_SHA = previous.source;
    if (previous.digest === undefined) delete process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST;
    else process.env.MIGRATION_EXECUTOR_IMAGE_DIGEST = previous.digest;
    if (previous.runner === undefined) delete process.env.MIGRATION_RUNNER_ID;
    else process.env.MIGRATION_RUNNER_ID = previous.runner;
  }
}
