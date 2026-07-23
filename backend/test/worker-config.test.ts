import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ServiceUnavailableException } from "@nestjs/common";
import { ApiService } from "../src/api/api.service";
import type { AuthContext } from "../src/auth/auth.types";
import { configuredPoolMax, createPool } from "../src/db.module";
import { documentProcessingJobTypes, processingJobRegistry, syncJobRegistry, workerPools } from "../src/job-types";
import { evaluateDbCapacity } from "../src/ops/check-db-capacity";
import { configuredJobTypes, registeredWorkerJobTypes } from "../src/worker/worker";

const tenantId = "10000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000002";
const entityId = "10000000-0000-4000-8000-000000000003";
const ctx: AuthContext = {
  tenantId,
  membershipId: "10000000-0000-4000-8000-000000000004",
  tenantRole: "admin",
  permissions: ["vendor.manage", "rfi.manage", "integration.manage"],
  actorType: "human",
  isOwner: false,
  mfaRequiredForAdmins: false,
  principal: {
    id: "10000000-0000-4000-8000-000000000005",
    email: "reviewer@example.test",
    cognitoSub: "reviewer",
    fullName: "Reviewer",
    kind: "human",
    status: "active",
  },
};

const unavailable = (error: unknown) =>
  error instanceof ServiceUnavailableException &&
  error.getStatus() === 503 &&
  error.message === "This operation is temporarily unavailable";

function serviceWithoutDatabase() {
  let connections = 0;
  const pool = { connect: async () => { connections += 1; throw new Error("database must not be reached"); } };
  const auth = { requireTenantPermission: async () => undefined };
  return { service: new ApiService(pool as never, auth as never), connections: () => connections };
}

test("production worker handlers exactly cover the supported asynchronous registry", () => {
  assert.deepEqual([...registeredWorkerJobTypes].sort(), [...processingJobRegistry.asynchronous].sort());
  assert.throws(() => configuredJobTypes(undefined), /WORKER_JOB_TYPES is required/);
  assert.throws(() => configuredJobTypes("   "), /WORKER_JOB_TYPES is required/);
  assert.deepEqual(configuredJobTypes(" ingest_vendor_catalogue, product_rematch "), ["ingest_vendor_catalogue", "product_rematch"]);
  assert.throws(() => configuredJobTypes("ingest_spec"), /Unsupported WORKER_JOB_TYPES entry/);
  assert.throws(() => configuredJobTypes("product_rematch,product_rematch"), /must not contain duplicates/);
  assert.ok(!registeredWorkerJobTypes.includes("package_draft" as never));
});

test("canonical worker pools map every supported job exactly once with scheduled as the sole anchor", () => {
  const enabledPools = Object.entries(workerPools).filter(([, pool]) => pool.enabled);
  assert.deepEqual(enabledPools.map(([name]) => name), ["ocr", "vendor", "package", "scheduled"]);
  assert.deepEqual(enabledPools.filter(([, pool]) => pool.anchor).map(([name]) => name), ["scheduled"]);
  assert.deepEqual(enabledPools.flatMap(([, pool]) => pool.jobTypes).sort(), [...processingJobRegistry.asynchronous].sort());
  assert.equal(new Set(enabledPools.flatMap(([, pool]) => pool.jobTypes)).size, processingJobRegistry.asynchronous.length);
  assert.ok(!("integration" in workerPools));
});

test("PG_POOL_MAX is optional and otherwise must be a positive integer", () => {
  assert.equal(configuredPoolMax(undefined), undefined);
  assert.equal(configuredPoolMax("3"), 3);
  for (const invalid of ["", " ", "0", "-1", "3.5", "nope"]) {
    assert.throws(() => configuredPoolMax(invalid), /positive integer/);
  }
  const prior = process.env.PG_POOL_MAX;
  process.env.PG_POOL_MAX = "3";
  try {
    const pool = createPool();
    assert.equal(pool.options.max, 3);
    void pool.end();
  } finally {
    if (prior === undefined) delete process.env.PG_POOL_MAX;
    else process.env.PG_POOL_MAX = prior;
  }
});

test("database capacity gate reserves 20 percent and fails closed below the required total", () => {
  assert.deepEqual(evaluateDbCapacity(112, 61, 20), {
    maxConnections: 112,
    usableConnections: 89,
    requiredConnections: 61,
    reservePercent: 20,
    sufficient: true,
  });
  assert.equal(evaluateDbCapacity(100, 81, 20).sufficient, false);
  assert.throws(() => evaluateDbCapacity(112, 61, 100), /less than 100/);
  assert.throws(() => evaluateDbCapacity(Number.NaN, 61, 20), /invalid max_connections/);
});

test("unsupported upload API paths fail before opening a transaction", async () => {
  const { service, connections } = serviceWithoutDatabase();
  const unsupportedUploads = Object.entries(documentProcessingJobTypes)
    .filter(([, jobType]) => processingJobRegistry.unsupported.includes(jobType as never));

  assert.deepEqual(unsupportedUploads.map(([, jobType]) => jobType).sort(), [
    "ingest_addendum", "ingest_attachment", "ingest_document", "ingest_drawing", "ingest_spec",
  ]);
  for (const [docType] of unsupportedUploads) {
    await assert.rejects(service.initiateUpload(ctx, projectId, { docType }), unavailable);
    await assert.rejects(service.finalizeUpload(ctx, projectId, { docType }, `disabled-${docType}`), unavailable);
  }
  assert.equal(connections(), 0);
});

test("RFI PDF export and both sync job types fail before creating rows", async () => {
  const { service, connections } = serviceWithoutDatabase();
  await assert.rejects(service.exportRfi(ctx, projectId, entityId, "disabled-rfi-export"), unavailable);
  await assert.rejects(service.handoffRfi(ctx, projectId, entityId, { connectionId: entityId }, "disabled-rfi-handoff"), unavailable);
  for (const jobType of syncJobRegistry.unsupported) {
    await assert.rejects(service.createSyncJob(ctx, entityId, { jobType }, `disabled-${jobType}`), unavailable);
  }
  assert.equal(connections(), 0);
});

test("the persistence boundary accepts supported jobs and rejects unsupported jobs before SQL", async () => {
  const service = new ApiService({} as never, {} as never) as unknown as {
    enqueueDocumentJob(client: unknown, ctx: AuthContext, documentId: string, jobType: string, key: string, payload: Record<string, unknown>): Promise<unknown>;
    enqueueProjectJob(client: unknown, ctx: Pick<AuthContext, "tenantId">, projectId: string, jobType: string, key: string, payload: Record<string, unknown>): Promise<unknown>;
  };
  const inserted: string[] = [];
  const client = {
    async query(_sql: string, values: unknown[]) {
      inserted.push(String(values[1]));
      return { rows: [{ id: entityId, job_type: values[1], status: "queued", worker_output: {}, inserted: true }], rowCount: 1 };
    },
  };

  for (const jobType of processingJobRegistry.asynchronous) {
    await service.enqueueProjectJob(client, ctx, projectId, jobType, `supported-${jobType}`, {});
  }
  assert.deepEqual(inserted, [...processingJobRegistry.asynchronous]);

  for (const jobType of processingJobRegistry.unsupported) {
    await assert.rejects(service.enqueueProjectJob(client, ctx, projectId, jobType, `unsupported-${jobType}`, {}), unavailable);
  }
  assert.deepEqual(inserted, [...processingJobRegistry.asynchronous]);

  const insertedDocuments: string[] = [];
  const documentClient = {
    async query(sql: string, values: unknown[]) {
      if (!sql.includes("insert into processing_jobs")) return { rows: [], rowCount: 1 };
      insertedDocuments.push(String(values[2]));
      return { rows: [{ id: entityId, job_type: values[2], status: "queued", worker_output: {}, inserted: true }], rowCount: 1 };
    },
  };
  for (const jobType of ["ingest_vendor_catalogue", "ingest_past_submittal"] as const) {
    await service.enqueueDocumentJob(documentClient, ctx, entityId, jobType, `supported-${jobType}`, {});
  }
  assert.deepEqual(insertedDocuments, ["ingest_vendor_catalogue", "ingest_past_submittal"]);
});

test("package_draft remains synchronous idempotency tracking", () => {
  const source = readFileSync(new URL("../src/api/api.service.ts", import.meta.url), "utf8");
  const createPackage = source.slice(source.indexOf("async createPackage"), source.indexOf("async packagePreview"));
  assert.deepEqual(processingJobRegistry.synchronousLedger, ["package_draft"]);
  assert.ok(!processingJobRegistry.asynchronous.includes("package_draft" as never));
  assert.match(createPackage, /startSynchronousProjectJob\(client, ctx, pid, "package_draft"/);
  assert.match(createPackage, /update processing_jobs set status = 'succeeded'/);
  assert.doesNotMatch(createPackage, /enqueueProjectJob/);
});
