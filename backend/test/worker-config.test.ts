import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ServiceUnavailableException } from "@nestjs/common";
import { ApiService } from "../src/api/api.service";
import type { AuthContext } from "../src/auth/auth.types";
import { documentProcessingJobTypes, processingJobRegistry, syncJobRegistry } from "../src/job-types";
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
  assert.deepEqual(configuredJobTypes(), [...processingJobRegistry.asynchronous]);
  assert.deepEqual(configuredJobTypes(" ingest_vendor_catalogue, product_rematch "), ["ingest_vendor_catalogue", "product_rematch"]);
  assert.throws(() => configuredJobTypes("ingest_spec"), /Unsupported WORKER_JOB_TYPES entry/);
  assert.ok(!registeredWorkerJobTypes.includes("package_draft" as never));
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
