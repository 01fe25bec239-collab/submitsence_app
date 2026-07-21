import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const transitions = JSON.parse(readFileSync(new URL("../src/api/status-transitions.json", import.meta.url), "utf8"));
const openapiSource = readFileSync(new URL("../src/api/openapi.ts", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../src/api/api.service.ts", import.meta.url), "utf8");
const commercialSource = readFileSync(new URL("../src/commercial/commercial.service.ts", import.meta.url), "utf8");
const handoff = readFileSync(new URL("../docs/api-handoff.md", import.meta.url), "utf8");

test("register status policy keeps human approval on the sign-off path", () => {
  assert.deepEqual(transitions.draft, ["submitted", "cancelled"]);
  assert.ok(transitions.submitted.includes("human_approved"));
  assert.ok(!transitions.draft.includes("human_approved"));
  assert.deepEqual(transitions.closed, []);
});

test("API contract documents the material backend surfaces", () => {
  for (const path of [
    "/tenants/{tenantId}/projects/{projectId}/documents/finalize",
    "/tenants/{tenantId}/projects/{projectId}/register-items/sign-off",
    "/tenants/{tenantId}/projects/{projectId}/packages/{packageId}/export-pdf",
    "/tenants/{tenantId}/audit-events",
    "/billing/webhooks/stripe",
    "/integrations/webhooks/{provider}",
  ]) {
    assert.match(openapiSource, new RegExp(path.replace(/[{}]/g, "\\$&")));
  }
});

test("service enforces assistive language and blocks direct human_approved transitions", () => {
  assert.match(serviceSource, /assertSafeStatusLanguage/);
  assert.match(serviceSource, /use the human sign-off endpoint for human_approved/);
});

test("webhooks resolve tenant from a trusted server-side mapping, never the request body", () => {
  assert.match(serviceSource, /resolve_integration_tenant/);
  assert.match(commercialSource, /resolve_billing_tenant/);
  assert.doesNotMatch(serviceSource, /v\.uuid\(body\.tenantId/);
  assert.doesNotMatch(commercialSource, /body\.tenantId/);
});

test("queue handoff keeps broker/runtime open and DB ledgers binding", () => {
  assert.match(handoff, /processing_jobs/);
  assert.match(handoff, /sync_jobs/);
  assert.match(handoff, /Queue broker\/runtime\/retry\/DLQ policy is still open/);
  assert.match(handoff, /actorType: "system"/);
});
