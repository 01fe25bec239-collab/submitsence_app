import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const matching = readFileSync(new URL("../src/matching/matching.service.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/worker/worker.ts", import.meta.url), "utf8");
const service = readFileSync(new URL("../src/api/api.service.ts", import.meta.url), "utf8");
const claim = readFileSync(new URL("../../db/migrations/0016_job_claim.sql", import.meta.url), "utf8");

test("matching only ever considers the caller's own tenant (explicit filter + RLS + pending default)", () => {
  // Candidate load carries an explicit tenant filter (defence-in-depth on top of RLS).
  assert.match(matching, /from products p[\s\S]*where p\.tenant_id = \$1/);
  // Suggestions are written as pending; only a human transitions them.
  assert.match(matching, /decision\)\s*\n?\s*values \(\$1, \$2, \$3, \$4, \$5, \$6, \$7::jsonb, 'pending'\)/);
  // Re-run replaces prior pending rows only; human decisions are preserved.
  assert.match(matching, /delete from product_matches where tenant_id = \$1 and register_item_id = \$2 and decision = 'pending'/);
  // Evidence + missing-info are stored for source-cited, assistive output.
  assert.match(matching, /references: s\.evidence, missingInfo: s\.missingInfo/);
});

test("worker processes each job as a system actor with the job's trusted tenant_id", () => {
  assert.match(worker, /claim_next_job/);
  assert.match(worker, /actorType: "system"/);
  // A job can never be its own approver: no direct human_approved anywhere in the worker.
  assert.doesNotMatch(worker, /human_approved/);
});

test("job claimer bypasses RLS only for the narrow cross-tenant pick, returns the trusted tenant_id", () => {
  assert.match(claim, /security definer/i);
  assert.match(claim, /for update skip locked/i);
  assert.match(claim, /returning j\.id, j\.tenant_id/);
  assert.match(claim, /grant execute on function app\.claim_next_job/i);
});

test("learning aggregate is consent-gated and reads only eligible, non-opted-out, opted-in rows", () => {
  assert.match(service, /learning_loop !== "opted_in"/);
  assert.equal(service.match(/select learning_loop from tenant_consents where tenant_id = \$1 for share/g)?.length, 2);
  assert.match(service, /anonymised_eligible = true and e\.opted_out = false and e\.consent_state = 'opted_in'/);
});

test("opt-out permanently excludes previously collected learning events", () => {
  assert.match(service, /update rejection_learning_events set opted_out = true where tenant_id = \$1 and opted_out = false/);
  assert.match(service, /"consent_change", "tenant_consent"/);
});

test("learning-event references are bound to the authorized project and each other", () => {
  assert.match(service, /requireRegisterItem\(client, pid, registerItemId\)/);
  assert.match(service, /requireRiskFlag\(client, pid, riskFlagId\)/);
  assert.match(service, /flag\.register_item_id !== registerItemId/);
  assert.match(service, /api\.enumValue\(body\.humanDecision, "humanDecision", api\.riskStates\)/);
  assert.match(service, /api\.enumValue\(body\.consultantOutcome, "consultantOutcome", api\.consultantOutcomes\)/);
});

test("manual product corrections are stored as manual_entry so re-ingestion never clobbers them", () => {
  assert.match(service, /source = 'manual_entry'/);
  assert.match(matching, /'match', /); // match audit emitted per suggestion run
});
