import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { Pool } from "pg";
import { ApiService } from "../src/api/api.service";
import type { AuthContext } from "../src/auth/auth.types";
import { processPackageJob, type PackageJob } from "../src/package/package.service";
import type { ObjectStore, PutObjectInput } from "../src/package/storage";
import type { PackageDocumentRef } from "../src/package/package.types";

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async assertAustralianBucket() { return "ap-southeast-2"; }
  async get(document: PackageDocumentRef) {
    const object = this.objects.get(`${document.storageBucket}/${document.objectKey}`);
    if (!object) throw new Error(`Missing memory object ${document.objectKey}`);
    return object.bytes;
  }
  async put(input: PutObjectInput) {
    this.objects.set(`${input.bucket}/${input.key}`, { bytes: input.body, contentType: input.contentType });
    return { versionId: "memory-version" };
  }
}

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "55555555-5555-5555-5555-555555555555";
const REGISTER_ITEM_ID = "99999999-9999-9999-9999-999999999999";
const USER_ID = "22222222-2222-2222-2222-222222222222";

function job(id: string, type: string, output: Record<string, unknown>): PackageJob {
  return { id, tenant_id: TENANT_ID, job_type: type, document_id: null, worker_output: { projectId: PROJECT_ID, ...output } };
}

async function main() {
  const connectionString = process.env.PACKAGE_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("PACKAGE_TEST_DATABASE_URL is required");
  process.env.S3_OUTPUT_BUCKET = "submitsense-package-test-ap-southeast-2";
  const pool = new Pool({ connectionString });
  const store = new MemoryStore();
  const api = new ApiService(pool, null as never);
  const ctx: AuthContext = {
    principal: {
      id: USER_ID,
      email: "owner@acme.example",
      cognitoSub: "worker-verification-owner",
      fullName: "Olivia Owner",
      kind: "human",
      status: "active",
    },
    tenantId: TENANT_ID,
    membershipId: randomUUID(),
    tenantRole: "owner",
    permissions: [],
    actorType: "human",
    isOwner: true,
    mfaRequiredForAdmins: false,
  };
  try {
    const packageId = randomUUID();
    const packageItemId = randomUUID();
    const generationJobId = randomUUID();
    const cover = {
      companyName: "Worker Verification Pty Ltd", legalName: "Worker Verification Pty Ltd", abn: "12345678901",
      logoDocumentId: null, primaryColour: "#16697A", address: "Sydney NSW", phone: null, email: null,
      projectName: "Northbridge Data Centre - Fire", clientName: "BuildCo", siteAddress: null,
      trade: "fire_protection", preparedBy: "Owner User",
    };
    await pool.query(`insert into packages (id, tenant_id, project_id, name, assembled_by, cover_sheet) values ($1, $2, $3, 'Worker verification package', $4, $5::jsonb)`, [packageId, TENANT_ID, PROJECT_ID, USER_ID, JSON.stringify(cover)]);
    await pool.query(`insert into package_items (id, tenant_id, package_id, register_item_id, sequence, manual_notes) values ($1, $2, $3, $4, 1, 'version-one-note')`, [packageItemId, TENANT_ID, packageId, REGISTER_ITEM_ID]);
    await pool.query(`insert into processing_jobs (id, tenant_id, job_type, idempotency_key, worker_output) values ($1, $2, 'package_generation', $3, $4::jsonb)`, [generationJobId, TENANT_ID, `verify-${generationJobId}`, JSON.stringify({ projectId: PROJECT_ID, packageId })]);

    const generated = await processPackageJob(pool, job(generationJobId, "package_generation", { packageId }), store);
    assert.equal(generated.version, 1);
    assert.ok(generated.documentId);
    assert.equal((await processPackageJob(pool, job(generationJobId, "package_generation", { packageId }), store)).packageVersionId, generated.packageVersionId);
    const versionCount = await pool.query(`select count(*)::int as count from package_versions where package_id = $1`, [packageId]);
    assert.equal(versionCount.rows[0].count, 1);
    const preview = await api.packagePreview(ctx, PROJECT_ID, packageId);
    assert.deepEqual(preview.items[0].documents, []);
    const packageObject = [...store.objects.values()].find((item) => item.contentType === "application/pdf");
    assert.ok(packageObject);
    assert.equal((await PDFDocument.load(packageObject!.bytes)).getSubject(), "Prepared for review submittal package");
    await pool.query(`update package_items set manual_notes = 'draft-changed-after-v1' where id = $1`, [packageItemId]);

    for (const exportType of ["consultant_pdf", "aconex_bundle"] as const) {
      const exportId = randomUUID();
      const exportJobId = randomUUID();
      await pool.query(`insert into exports (id, tenant_id, project_id, package_id, export_type, status, error_message, requested_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [exportId, TENANT_ID, PROJECT_ID, packageId, exportType, exportType === "aconex_bundle" ? "failed" : "pending", exportType === "aconex_bundle" ? "old retry error" : null, USER_ID]);
      await pool.query(`insert into processing_jobs (id, tenant_id, job_type, idempotency_key, worker_output) values ($1, $2, $3, $4, $5::jsonb)`, [exportJobId, TENANT_ID, `export_${exportType}`, `verify-${exportJobId}`, JSON.stringify({ projectId: PROJECT_ID, packageId, exportId, exportType })]);
      if (exportType === "aconex_bundle") {
        const originalPackageBytes = packageObject!.bytes;
        packageObject!.bytes = new TextEncoder().encode("tampered-package");
        await assert.rejects(
          processPackageJob(pool, job(exportJobId, `export_${exportType}`, { packageId, exportId, exportType }), store),
          /checksum does not match/,
        );
        packageObject!.bytes = originalPackageBytes;
      }
      await processPackageJob(pool, job(exportJobId, `export_${exportType}`, { packageId, exportId, exportType }), store);
      const exported = await pool.query(`select status, output_document_id, error_message from exports where id = $1`, [exportId]);
      assert.equal(exported.rows[0].status, "ready");
      assert.ok(exported.rows[0].output_document_id);
      assert.equal(exported.rows[0].error_message, null);
      if (exportType === "aconex_bundle") {
        const bundle = [...store.objects.values()].find((item) => item.contentType === "application/zip");
        assert.ok(bundle);
        const zip = await JSZip.loadAsync(bundle!.bytes);
        assert.ok(zip.file("metadata.json"));
        const registerCsv = await zip.file("register/submittal-register.csv")!.async("string");
        assert.match(registerCsv, /version-one-note/);
        assert.doesNotMatch(registerCsv, /draft-changed-after-v1/);
      }
    }

    const mismatchedExportId = randomUUID();
    await pool.query(`insert into exports (id, tenant_id, project_id, package_id, export_type, requested_by) values ($1, $2, $3, $4, 'consultant_pdf', $5)`, [mismatchedExportId, TENANT_ID, PROJECT_ID, packageId, USER_ID]);
    await assert.rejects(
      processPackageJob(pool, job(randomUUID(), "export_consultant_pdf", { packageId: randomUUID(), exportId: mismatchedExportId }), store),
      /does not match the job payload/,
    );

    const deliverable = await api.createPhysicalDeliverable(ctx, PROJECT_ID, REGISTER_ITEM_ID, {
      kind: "physical_sample",
      quantity: 1,
      trackingRef: "TRACK-VERIFY",
      dueDate: "2026-08-01",
      notes: "clear-me",
      responsibleUserId: USER_ID,
    });
    const clearedDeliverable = await api.updatePhysicalDeliverable(ctx, PROJECT_ID, deliverable.id, {
      trackingRef: null,
      dueDate: null,
      notes: null,
      responsibleUserId: null,
    });
    assert.equal(clearedDeliverable.trackingRef, null);
    assert.equal(clearedDeliverable.dueDate, null);
    assert.equal(clearedDeliverable.notes, null);
    assert.equal(clearedDeliverable.responsibleUserId, null);
    const notOverdue = await api.listRegister(ctx, PROJECT_ID, { overdue: "false" });
    assert.ok(notOverdue.some((item) => item.id === REGISTER_ITEM_ID && item.overdue === false));

    for (const format of ["csv", "xlsx", "pdf"] as const) {
      const exportId = randomUUID();
      const exportJobId = randomUUID();
      await pool.query(`insert into exports (id, tenant_id, project_id, export_type, requested_by) values ($1, $2, $3, $4, $5)`, [exportId, TENANT_ID, PROJECT_ID, `register_${format}`, USER_ID]);
      await pool.query(`insert into processing_jobs (id, tenant_id, job_type, idempotency_key, worker_output) values ($1, $2, $3, $4, $5::jsonb)`, [exportJobId, TENANT_ID, `export_register_${format}`, `verify-${exportJobId}`, JSON.stringify({ projectId: PROJECT_ID, exportId, exportType: format })]);
      await processPackageJob(pool, job(exportJobId, `export_register_${format}`, { exportId, exportType: format }), store);
      const exported = await pool.query(`select status, output_document_id from exports where id = $1`, [exportId]);
      assert.equal(exported.rows[0].status, "ready");
      assert.ok(exported.rows[0].output_document_id);
    }

    const idempotencyKey = `verify-regenerate-${randomUUID()}`;
    const regenerationJob = await api.regeneratePackage(ctx, PROJECT_ID, packageId, idempotencyKey);
    assert.equal(regenerationJob.inserted, true);
    await processPackageJob(pool, job(regenerationJob.id, "package_generation", { packageId }), store);
    await pool.query(`update processing_jobs set status = 'succeeded', finished_at = now() where id = $1`, [regenerationJob.id]);
    const repeatedJob = await api.regeneratePackage(ctx, PROJECT_ID, packageId, idempotencyKey);
    assert.equal(repeatedJob.id, regenerationJob.id);
    assert.equal(repeatedJob.inserted, false);
    const regeneratedPackage = await pool.query(`select status, current_version from packages where id = $1`, [packageId]);
    assert.deepEqual(regeneratedPackage.rows[0], { status: "ready", current_version: 2 });
    const regenerationAudits = await pool.query(`select count(*)::int as count from audit_events where entity_id = $1 and action = 'package_regenerate'`, [packageId]);
    assert.equal(regenerationAudits.rows[0].count, 1);

    const audits = await pool.query(`select action from audit_events where entity_id in ($1, $2)`, [packageId, generated.packageVersionId]);
    assert.ok(audits.rows.some((row) => row.action === "package_generated"));
    console.log("PASS worker/API: preview, nullable updates, overdue filtering, idempotency, version snapshot, bound exports, renderers, and audit events");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
