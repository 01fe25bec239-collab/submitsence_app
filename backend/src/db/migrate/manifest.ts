import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export const LEGACY_BOUNDARY = "0099";

const MIGRATION_FILENAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const MIGRATION_LIKE_FILENAME = /^\d{4}.*\.sql$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LIFECYCLE_PHASES = ["expand", "backfill", "contract"] as const;
const OPERATION_CATEGORIES = [
  "schema",
  "data-correction",
  "security-policy",
  "function-replacement",
  "index",
  "seed-reference",
] as const;
const EXECUTION_MODES = ["legacy-verbatim", "transactional", "nontransactional", "batched"] as const;
const TIMEOUT_KEYS = ["lockMs", "statementMs", "transactionMs", "idleInTransactionMs", "wallClockMs"] as const;

type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];
type OperationCategory = (typeof OPERATION_CATEGORIES)[number];
type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface MigrationTimeouts {
  lockMs: number;
  statementMs: number;
  transactionMs: number;
  idleInTransactionMs: number;
  wallClockMs: number;
}

export interface MigrationManifestEntry {
  id: string;
  filename: string;
  sha256: string;
  lifecyclePhase: LifecyclePhase;
  operationCategories: OperationCategory[];
  executionMode: ExecutionMode;
  requiredRuntimeEpoch: number | null;
  timeouts: MigrationTimeouts;
}

export interface MigrationManifest {
  schemaVersion: 1;
  legacyBoundary: typeof LEGACY_BOUNDARY;
  migrations: MigrationManifestEntry[];
}

interface DiscoveredMigration {
  id: string;
  filename: string;
  sha256: string;
}

const repositoryRoot = path.resolve(__dirname, "../../../..");

function manifestPath(root: string): string {
  return path.join(root, "db", "migrations", "manifest.json");
}

function migrationDirectory(root: string): string {
  return path.join(root, "db", "migrations");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

export function hashBytes(bytes: NodeJS.ArrayBufferView | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readManifest(root: string): Promise<{ manifest: MigrationManifest; source: string }> {
  const source = await fs.readFile(manifestPath(root), "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid migration manifest JSON: ${(error as Error).message}`);
  }
  validateManifest(parsed);
  return { manifest: parsed, source };
}

export function validateManifest(value: unknown): asserts value is MigrationManifest {
  assertCondition(isRecord(value), "Manifest must be a JSON object");
  assertCondition(value.schemaVersion === 1, "schemaVersion must be 1");
  assertCondition(value.legacyBoundary === LEGACY_BOUNDARY, `legacyBoundary must be "${LEGACY_BOUNDARY}"`);
  assertCondition(Array.isArray(value.migrations), "migrations must be an array");

  const ids = new Set<string>();
  const filenames = new Set<string>();
  let previousId = -1;

  for (const [index, rawEntry] of value.migrations.entries()) {
    assertCondition(isRecord(rawEntry), `Migration entry ${index} must be an object`);
    const entry = rawEntry as Record<string, unknown>;
    assertCondition(typeof entry.id === "string" && /^\d{4}$/.test(entry.id), `Migration entry ${index} has an invalid id`);
    assertCondition(typeof entry.filename === "string", `Migration ${entry.id} has an invalid filename`);
    assertCondition(!entry.filename.endsWith(".down.sql"), `Down migration ${entry.filename} cannot appear in the production manifest`);
    const match = MIGRATION_FILENAME.exec(entry.filename);
    assertCondition(match !== null, `Migration ${entry.id} has a malformed or unsafe filename: ${entry.filename}`);
    assertCondition(path.basename(entry.filename) === entry.filename, `Migration ${entry.id} filename must stay inside db/migrations`);
    assertCondition(match[1] === entry.id, `Migration ${entry.id} filename id does not match`);
    assertCondition(!filenames.has(entry.filename), `Duplicate migration filename: ${entry.filename}`);
    assertCondition(!ids.has(entry.id), `Duplicate migration id: ${entry.id}`);
    const numericId = Number(entry.id);
    assertCondition(numericId > previousId, `Migration entries are not in numeric order at ${entry.id}`);
    ids.add(entry.id);
    filenames.add(entry.filename);
    previousId = numericId;

    assertCondition(typeof entry.sha256 === "string" && SHA256.test(entry.sha256), `Migration ${entry.id} has an invalid SHA-256`);
    assertCondition(isOneOf(entry.lifecyclePhase, LIFECYCLE_PHASES), `Migration ${entry.id} has an invalid lifecycle phase`);
    assertCondition(Array.isArray(entry.operationCategories) && entry.operationCategories.length > 0, `Migration ${entry.id} must have operation categories`);
    const categories = entry.operationCategories as unknown[];
    const seenCategories = new Set<string>();
    for (const category of categories) {
      assertCondition(isOneOf(category, OPERATION_CATEGORIES), `Migration ${entry.id} has an invalid operation category`);
      assertCondition(!seenCategories.has(category), `Migration ${entry.id} has duplicate operation categories`);
      seenCategories.add(category);
    }
    assertCondition(isOneOf(entry.executionMode, EXECUTION_MODES), `Migration ${entry.id} has an invalid execution mode`);
    if (numericId <= Number(LEGACY_BOUNDARY)) {
      assertCondition(entry.executionMode === "legacy-verbatim", `Migration ${entry.id} must use legacy-verbatim at or below ${LEGACY_BOUNDARY}`);
    } else {
      assertCondition(entry.executionMode !== "legacy-verbatim", `Migration ${entry.id} above ${LEGACY_BOUNDARY} cannot use legacy-verbatim`);
    }
    assertCondition(
      entry.requiredRuntimeEpoch === null
        || (Number.isInteger(entry.requiredRuntimeEpoch) && (entry.requiredRuntimeEpoch as number) >= 0),
      `Migration ${entry.id} has an invalid requiredRuntimeEpoch`,
    );
    assertCondition(isRecord(entry.timeouts), `Migration ${entry.id} has invalid timeouts`);
    assertCondition(
      Object.keys(entry.timeouts).length === TIMEOUT_KEYS.length,
      `Migration ${entry.id} must declare exactly the required timeouts`,
    );
    for (const timeout of TIMEOUT_KEYS) {
      const milliseconds = entry.timeouts[timeout];
      assertCondition(Number.isInteger(milliseconds) && (milliseconds as number) > 0, `Migration ${entry.id} has an invalid ${timeout}`);
    }
  }
}

export async function discoverMigrations(root: string): Promise<DiscoveredMigration[]> {
  const directory = migrationDirectory(root);
  const directoryEntries = await fs.readdir(directory, { withFileTypes: true });
  const migrations: DiscoveredMigration[] = [];
  const ids = new Set<string>();
  const filenames = new Set<string>();

  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isFile() || !directoryEntry.name.endsWith(".sql") || directoryEntry.name.endsWith(".down.sql")) continue;
    if (!MIGRATION_LIKE_FILENAME.test(directoryEntry.name)) continue;
    const match = MIGRATION_FILENAME.exec(directoryEntry.name);
    assertCondition(match !== null, `Malformed production migration filename: ${directoryEntry.name}`);
    const id = match[1];
    assertCondition(!ids.has(id), `Duplicate migration id: ${id}`);
    assertCondition(!filenames.has(directoryEntry.name), `Duplicate migration filename: ${directoryEntry.name}`);
    ids.add(id);
    filenames.add(directoryEntry.name);
    const bytes = await fs.readFile(path.join(directory, directoryEntry.name));
    migrations.push({ id, filename: directoryEntry.name, sha256: hashBytes(bytes) });
  }

  return migrations.sort((left, right) => Number(left.id) - Number(right.id));
}

function canonicalCategories(categories: OperationCategory[]): OperationCategory[] {
  return [...categories].sort(
    (left, right) => OPERATION_CATEGORIES.indexOf(left) - OPERATION_CATEGORIES.indexOf(right),
  );
}

async function canonicalManifest(root: string, manifest: MigrationManifest, checkHashes: boolean): Promise<MigrationManifest> {
  const files = await discoverMigrations(root);
  const entriesByFilename = new Map(manifest.migrations.map((entry) => [entry.filename, entry]));
  const filesByFilename = new Map(files.map((file) => [file.filename, file]));

  for (const file of files) {
    assertCondition(entriesByFilename.has(file.filename), `Missing manifest entry for ${file.filename}`);
  }
  for (const entry of manifest.migrations) {
    assertCondition(filesByFilename.has(entry.filename), `Unexpected manifest entry or missing migration file: ${entry.filename}`);
  }

  return {
    schemaVersion: 1,
    legacyBoundary: LEGACY_BOUNDARY,
    migrations: files.map((file) => {
      const entry = entriesByFilename.get(file.filename)!;
      if (checkHashes) {
        assertCondition(entry.sha256 === file.sha256, `SHA-256 mismatch for ${file.filename}`);
      }
      return {
        id: file.id,
        filename: file.filename,
        sha256: file.sha256,
        lifecyclePhase: entry.lifecyclePhase,
        operationCategories: canonicalCategories(entry.operationCategories),
        executionMode: entry.executionMode,
        requiredRuntimeEpoch: entry.requiredRuntimeEpoch,
        timeouts: {
          lockMs: entry.timeouts.lockMs,
          statementMs: entry.timeouts.statementMs,
          transactionMs: entry.timeouts.transactionMs,
          idleInTransactionMs: entry.timeouts.idleInTransactionMs,
          wallClockMs: entry.timeouts.wallClockMs,
        },
      };
    }),
  };
}

function renderManifest(manifest: MigrationManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function checkRawByteAttributes(root: string): Promise<void> {
  const attributes = await fs.readFile(path.join(root, ".gitattributes"), "utf8");
  assertCondition(
    attributes.split(/\r?\n/).includes("db/migrations/*.sql -text"),
    ".gitattributes must contain: db/migrations/*.sql -text",
  );
}

export async function generateManifest(root = repositoryRoot): Promise<boolean> {
  await checkRawByteAttributes(root);
  const { manifest, source } = await readManifest(root);
  const rendered = renderManifest(await canonicalManifest(root, manifest, false));
  if (rendered === source) return false;

  const target = manifestPath(root);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, rendered, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return true;
}

export async function checkManifest(root = repositoryRoot): Promise<MigrationManifest> {
  await checkRawByteAttributes(root);
  const { manifest, source } = await readManifest(root);
  const canonical = await canonicalManifest(root, manifest, true);
  assertCondition(source === renderManifest(canonical), "Migration manifest is not in canonical generated form");
  return canonical;
}

function legacyMigrationPath(filePath: string, boundary: number): boolean {
  const match = /^db\/migrations\/(\d{4})_[^/]+\.sql$/.exec(filePath);
  return match !== null && Number(match[1]) <= boundary;
}

export async function checkHistoricalImmutability(
  baseRef: string,
  root = repositoryRoot,
): Promise<"anchored" | "bootstrap"> {
  assertCondition(baseRef.length > 0, "A Git base commit is required");
  execFileSync("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], { cwd: root, stdio: "ignore" });
  let baseHasManifest = true;
  try {
    execFileSync("git", ["cat-file", "-e", `${baseRef}:db/migrations/manifest.json`], { cwd: root, stdio: "ignore" });
  } catch {
    baseHasManifest = false;
  }
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", baseRef, "HEAD", "--", "db/migrations"],
    { cwd: root },
  );
  const fields = output.toString("utf8").split("\0").filter(Boolean);
  const changes: string[] = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const paths = status.startsWith("R") || status.startsWith("C")
      ? [fields[index++], fields[index++]]
      : [fields[index++]];
    const touchesLegacyHistory = paths.some((filePath) => legacyMigrationPath(filePath, Number(LEGACY_BOUNDARY)));
    // The first manifest anchors pre-existing additions; every later base is strict.
    const bootstrapAddition = !baseHasManifest && status === "A";
    if (touchesLegacyHistory && !bootstrapAddition) {
      changes.push(`${status} ${paths.join(" -> ")}`);
    }
  }

  assertCondition(
    changes.length === 0,
    `Historical migrations at or below ${LEGACY_BOUNDARY} are immutable:\n${changes.join("\n")}`,
  );
  return baseHasManifest ? "anchored" : "bootstrap";
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (command === "generate") {
    console.log((await generateManifest()) ? "Migration manifest generated." : "Migration manifest already current.");
  } else if (command === "check") {
    const manifest = await checkManifest();
    console.log(`Migration manifest valid: ${manifest.migrations.length} raw-byte hashes verified.`);
  } else if (command === "check-history") {
    assertCondition(argument, "Usage: manifest.ts check-history <base-commit>");
    const mode = await checkHistoricalImmutability(argument);
    console.log(
      mode === "anchored"
        ? `Historical migrations unchanged from ${argument}.`
        : `Historical files present at ${argument} are unchanged; this change establishes the first manifest anchor.`,
    );
  } else {
    throw new Error("Usage: manifest.ts <generate|check|check-history> [base-commit]");
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
