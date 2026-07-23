import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkManifest,
  checkHistoricalImmutability,
  discoverMigrations,
  generateManifest,
  hashBytes,
  type MigrationManifest,
  type MigrationManifestEntry,
} from "../src/db/migrate/manifest";

const repositoryRoot = path.resolve(__dirname, "../..");
const ZERO_HASH = "0".repeat(64);
const timeouts = {
  lockMs: 5000,
  statementMs: 60000,
  transactionMs: 300000,
  idleInTransactionMs: 60000,
  wallClockMs: 900000,
};

function entry(
  id: string,
  filename: string,
  sha256: string,
  executionMode: MigrationManifestEntry["executionMode"] = "legacy-verbatim",
): MigrationManifestEntry {
  return {
    id,
    filename,
    sha256,
    lifecyclePhase: "expand",
    operationCategories: ["schema"],
    executionMode,
    requiredRuntimeEpoch: null,
    timeouts: { ...timeouts },
  };
}

async function writeManifest(root: string, manifest: MigrationManifest): Promise<void> {
  await fs.writeFile(
    path.join(root, "db", "migrations", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function readManifest(root: string): Promise<MigrationManifest> {
  return JSON.parse(await fs.readFile(path.join(root, "db", "migrations", "manifest.json"), "utf8")) as MigrationManifest;
}

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "submitsense-manifest-"));
  const migrations = path.join(root, "db", "migrations");
  await fs.mkdir(migrations, { recursive: true });
  await fs.writeFile(path.join(root, ".gitattributes"), "db/migrations/*.sql -text\n");
  const files = [
    ["0001_alpha.sql", "begin;\nselect 1;\ncommit;\n"],
    ["0099_seed.sql", "begin;\nselect 99;\ncommit;\n"],
  ] as const;
  for (const [filename, source] of files) await fs.writeFile(path.join(migrations, filename), source);
  await writeManifest(root, {
    schemaVersion: 1,
    legacyBoundary: "0099",
    migrations: files.map(([filename, source]) => entry(filename.slice(0, 4), filename, hashBytes(source))),
  });
  return root;
}

function fixtureTest(name: string, run: (root: string) => Promise<void>): void {
  test(name, async (context) => {
    const root = await makeFixture();
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    await run(root);
  });
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Manifest Test",
      GIT_AUTHOR_EMAIL: "manifest@example.test",
      GIT_COMMITTER_NAME: "Manifest Test",
      GIT_COMMITTER_EMAIL: "manifest@example.test",
    },
  }).trim();
}

test("the committed manifest passes raw-byte validation", async () => {
  const manifest = await checkManifest(repositoryRoot);
  assert.equal(manifest.migrations.length, 24);
});

fixtureTest("repeated generation is deterministic", async (root) => {
  const manifest = await readManifest(root);
  manifest.migrations[0].sha256 = ZERO_HASH;
  await writeManifest(root, manifest);
  assert.equal(await generateManifest(root), true);
  const first = await fs.readFile(path.join(root, "db", "migrations", "manifest.json"));
  assert.equal(await generateManifest(root), false);
  const second = await fs.readFile(path.join(root, "db", "migrations", "manifest.json"));
  assert.deepEqual(second, first);
});

test("raw-byte changes alter SHA-256", () => {
  assert.notEqual(hashBytes(Buffer.from([0, 1, 2])), hashBytes(Buffer.from([0, 1, 3])));
});

test("line-ending changes alter SHA-256", () => {
  assert.notEqual(hashBytes("select 1;\n"), hashBytes("select 1;\r\n"));
});

test("whitespace changes alter SHA-256", () => {
  assert.notEqual(hashBytes("select 1;\n"), hashBytes("select  1;\n"));
});

fixtureTest("duplicate IDs are rejected", async (root) => {
  const manifest = await readManifest(root);
  manifest.migrations[1] = entry("0001", "0001_other.sql", ZERO_HASH);
  await writeManifest(root, manifest);
  await assert.rejects(checkManifest(root), /Duplicate migration id: 0001/);
});

fixtureTest("duplicate filenames are rejected", async (root) => {
  const manifest = await readManifest(root);
  manifest.migrations[1] = { ...manifest.migrations[0], timeouts: { ...timeouts } };
  await writeManifest(root, manifest);
  await assert.rejects(checkManifest(root), /Duplicate migration filename/);
});

fixtureTest("missing manifest entries are rejected", async (root) => {
  const manifest = await readManifest(root);
  manifest.migrations.shift();
  await writeManifest(root, manifest);
  await assert.rejects(checkManifest(root), /Missing manifest entry/);
});

fixtureTest("missing migration files are rejected", async (root) => {
  await fs.rm(path.join(root, "db", "migrations", "0099_seed.sql"));
  await assert.rejects(checkManifest(root), /missing migration file/);
});

fixtureTest("unexpected manifest entries are rejected", async (root) => {
  const manifest = await readManifest(root);
  manifest.migrations.push(entry("0100", "0100_expand_extra.sql", ZERO_HASH, "transactional"));
  await writeManifest(root, manifest);
  await assert.rejects(checkManifest(root), /Unexpected manifest entry/);
});

fixtureTest("reordered entries are rejected", async (root) => {
  const manifest = await readManifest(root);
  manifest.migrations.reverse();
  await writeManifest(root, manifest);
  await assert.rejects(checkManifest(root), /not in numeric order/);
});

fixtureTest("down files are excluded", async (root) => {
  await fs.writeFile(path.join(root, "db", "migrations", "0002_beta.down.sql"), "drop table beta;\n");
  assert.deepEqual((await discoverMigrations(root)).map(({ filename }) => filename), ["0001_alpha.sql", "0099_seed.sql"]);
  await checkManifest(root);
});

fixtureTest("the legacy boundary value is enforced", async (root) => {
  const manifest = await readManifest(root) as MigrationManifest & { legacyBoundary: string };
  manifest.legacyBoundary = "0023";
  await writeManifest(root, manifest as MigrationManifest);
  await assert.rejects(checkManifest(root), /legacyBoundary must be "0099"/);
});

fixtureTest("legacy execution mode is enforced at the boundary", async (root) => {
  const manifest = await readManifest(root);
  manifest.migrations[0].executionMode = "transactional";
  await writeManifest(root, manifest);
  await assert.rejects(checkManifest(root), /must use legacy-verbatim/);
});

fixtureTest("invalid lifecycle phases are rejected", async (root) => {
  const manifest = await readManifest(root);
  (manifest.migrations[0] as { lifecyclePhase: string }).lifecyclePhase = "cleanup";
  await writeManifest(root, manifest);
  await assert.rejects(checkManifest(root), /invalid lifecycle phase/);
});

fixtureTest("invalid operation categories are rejected", async (root) => {
  const manifest = await readManifest(root);
  (manifest.migrations[0] as { operationCategories: string[] }).operationCategories = ["ddl"];
  await writeManifest(root, manifest);
  await assert.rejects(checkManifest(root), /invalid operation category/);
});

fixtureTest("invalid execution modes are rejected", async (root) => {
  const manifest = await readManifest(root);
  (manifest.migrations[0] as { executionMode: string }).executionMode = "autocommit";
  await writeManifest(root, manifest);
  await assert.rejects(checkManifest(root), /invalid execution mode/);
});

fixtureTest("invalid SHA-256 values are rejected", async (root) => {
  const manifest = await readManifest(root);
  manifest.migrations[0].sha256 = "not-a-hash";
  await writeManifest(root, manifest);
  await assert.rejects(checkManifest(root), /invalid SHA-256/);
});

fixtureTest("raw file changes are rejected as hash mismatches", async (root) => {
  await fs.appendFile(path.join(root, "db", "migrations", "0001_alpha.sql"), " ");
  await assert.rejects(checkManifest(root), /SHA-256 mismatch/);
});

fixtureTest("path traversal filenames are rejected", async (root) => {
  const manifest = await readManifest(root);
  manifest.migrations[0].filename = "../0001_alpha.sql";
  await writeManifest(root, manifest);
  await assert.rejects(checkManifest(root), /malformed or unsafe filename/);
});

fixtureTest("malformed migration filenames are rejected", async (root) => {
  await fs.writeFile(path.join(root, "db", "migrations", "0002-bad.sql"), "select 2;\n");
  await assert.rejects(discoverMigrations(root), /Malformed production migration filename/);
});

fixtureTest("raw-byte Git attributes are enforced", async (root) => {
  await fs.writeFile(path.join(root, ".gitattributes"), "db/migrations/*.sql text\n");
  await assert.rejects(checkManifest(root), /\.gitattributes must contain/);
});

fixtureTest("check does not rewrite the manifest", async (root) => {
  const target = path.join(root, "db", "migrations", "manifest.json");
  const before = await fs.readFile(target);
  const beforeMtime = (await fs.stat(target)).mtimeMs;
  await checkManifest(root);
  assert.deepEqual(await fs.readFile(target), before);
  assert.equal((await fs.stat(target)).mtimeMs, beforeMtime);
});

fixtureTest("generation never modifies historical migration bytes", async (root) => {
  const migrations = path.join(root, "db", "migrations");
  const before = new Map<string, string>();
  for (const { filename } of await discoverMigrations(root)) {
    before.set(filename, hashBytes(await fs.readFile(path.join(migrations, filename))));
  }
  const manifest = await readManifest(root);
  manifest.migrations[0].sha256 = ZERO_HASH;
  await writeManifest(root, manifest);
  await generateManifest(root);
  for (const [filename, checksum] of before) {
    assert.equal(hashBytes(await fs.readFile(path.join(migrations, filename))), checksum);
  }
});

fixtureTest("the first manifest anchor permits only newly added legacy files", async (root) => {
  const migrations = path.join(root, "db", "migrations");
  const seed = await fs.readFile(path.join(migrations, "0099_seed.sql"));
  const manifest = await fs.readFile(path.join(migrations, "manifest.json"));
  await fs.rm(path.join(migrations, "0099_seed.sql"));
  await fs.rm(path.join(migrations, "manifest.json"));
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base without manifest");
  const base = git(root, "rev-parse", "HEAD");
  await fs.writeFile(path.join(migrations, "0099_seed.sql"), seed);
  await fs.writeFile(path.join(migrations, "manifest.json"), manifest);
  git(root, "add", ".");
  git(root, "commit", "-qm", "establish manifest anchor");
  assert.equal(await checkHistoricalImmutability(base, root), "bootstrap");
});

fixtureTest("an anchored manifest rejects historical byte changes", async (root) => {
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "manifest anchor");
  const base = git(root, "rev-parse", "HEAD");
  await fs.appendFile(path.join(root, "db", "migrations", "0001_alpha.sql"), " ");
  git(root, "add", ".");
  git(root, "commit", "-qm", "mutate history");
  await assert.rejects(checkHistoricalImmutability(base, root), /Historical migrations at or below 0099 are immutable/);
});
