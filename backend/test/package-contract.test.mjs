import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const service = readFileSync(new URL("../src/package/package.service.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../src/package/render.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/worker/worker.ts", import.meta.url), "utf8");
const jobTypes = readFileSync(new URL("../src/job-types.ts", import.meta.url), "utf8");
const apiService = readFileSync(new URL("../src/api/api.service.ts", import.meta.url), "utf8");
const storage = readFileSync(new URL("../src/package/storage.ts", import.meta.url), "utf8");
const controller = readFileSync(new URL("../src/api/api.controller.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../db/migrations/0017_package_assembly.sql", import.meta.url), "utf8");
const queueMigration = readFileSync(new URL("../../db/migrations/0022_queue_ledger_hardening.sql", import.meta.url), "utf8");

test("package versions are immutable job reservations and preserve prior output documents", () => {
  assert.match(migration, /create table package_versions/);
  assert.match(migration, /unique \(package_id, version_number\)/);
  assert.match(service, /supersedes_document_id/);
  assert.match(service, /select current_version from packages[\s\S]*for update/);
  assert.match(service, /version_number < \$2[\s\S]*status = 'ready'/);
  assert.match(service, /warnings: rendered\.warnings,[\s\S]*snapshot/);
  assert.match(service, /Package version snapshot is missing or does not match/);
  assert.match(service, /Package version reservation does not match the job payload/);
});

test("queue crash reconciliation remains active behind lease expiry", () => {
  assert.match(queueMigration, /package_versions pv[\s\S]*pv\.status = 'ready'/);
  assert.match(queueMigration, /exports e[\s\S]*e\.status = 'ready'/);
  assert.match(queueMigration, /lease_expires_at <= clock_timestamp\(\)/);
});

test("every included file is explicitly tenant and project scoped", () => {
  assert.match(service, /d\.tenant_id = pid\.tenant_id/);
  assert.match(service, /d\.project_id is null or d\.project_id = \$3/);
  assert.match(service, /ri\.tenant_id = \$1 and ri\.project_id = \$2/);
  assert.match(apiService, /jsonb_agg\(jsonb_build_object\([\s\S]*'documentId'[\s\S]*'included'/);
});

test("large PDF and export generation runs through the background worker", () => {
  for (const type of ["package_generation", "export_consultant_pdf", "export_aconex_bundle", "export_register_csv", "export_register_xlsx", "export_register_pdf"]) {
    assert.match(jobTypes, new RegExp(`"${type}"`));
    assert.match(worker, new RegExp(`\\b${type}: processPackageJob`));
  }
  assert.match(worker, /processPackageJob/);
  assert.match(controller, /register-items\/export"\)[\s\S]{0,80}@HttpCode\(202\)/);
  assert.match(controller, /packages\/:packageId\/regenerate"\)[\s\S]{0,80}@HttpCode\(202\)/);
});

test("generated wording remains assistive and never claims certification", () => {
  assert.match(renderer, /Prepared for review/);
  assert.match(renderer, /does not generate stamped or certified drawings/);
  assert.doesNotMatch(renderer, /certified compliant/i);
});

test("Aconex bundle is a file handoff and performs no integration API call", () => {
  assert.match(renderer, /submitsense\.aconex-bundle\.v1/);
  assert.match(renderer, /metadata\.json/);
  assert.doesNotMatch(renderer, /fetch\(|axios|aconex\.com/i);
});

test("consultant updates are mapped, replay-safe, and cannot perform human sign-off", () => {
  assert.match(apiService, /externalProjectMappings|external_project_mappings/);
  assert.match(apiService, /integration_connections[\s\S]*status = 'connected'/);
  assert.match(apiService, /!result\.rows\[0\]\.inserted[\s\S]*status === "processed"/);
  assert.match(apiService, /mapExternalConsultantStatus\(payload\.status\)/);
  assert.match(apiService, /consultant_status = \$5/);
  assert.match(apiService, /status: "processed"/);
  assert.doesNotMatch(apiService.slice(apiService.indexOf('if (eventType === "consultant_status")'), apiService.indexOf("private async createExportJob")), /set status = 'human_approved'/);
});

test("physical samples and stamped drawings remain tracked line items", () => {
  assert.match(apiService, /insert into physical_deliverables[\s\S]*due_date, notes, attachment_document_id/);
  assert.match(renderer, /does not generate stamped or certified drawings/);
  assert.doesNotMatch(renderer, /engineer[- ]stamp|certification service/i);
});

test("register filters, nullable edits, retries, and AU storage keep their edge-case guards", () => {
  assert.match(apiService, /coalesce\(ri\.due_date < \(now\(\) at time zone 'Australia\/Sydney'\)::date[\s\S]*false\) = \$7/);
  assert.match(apiService, /manual_notes = case when \$6 then \$7 else manual_notes end/);
  assert.match(apiService, /requireActiveTenantMember\(client, responsibleUserId\)/);
  assert.match(apiService, /if \(job\.inserted\)[\s\S]*update packages set status = 'assembling'/);
  assert.match(queueMigration, /last_error = null,[\s\S]*error_details = null/);
  assert.match(service, /status = 'ready'[\s\S]*error_message = null/);
  assert.match(storage, /followRegionRedirects: true/);
});
