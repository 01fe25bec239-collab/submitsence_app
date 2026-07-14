import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  AconexAdapter,
  IntegrationProviderError,
  MockIntegrationAdapter,
  ProcoreAdapter,
  assertAustralianSecretReference,
  listProviderCapabilities,
  mapExternalConsultantStatus,
} from "../src/integrations/provider";

test("external approval is recorded without becoming SubmitSense human approval", () => {
  assert.deepEqual(mapExternalConsultantStatus("approved"), { consultantStatus: "approved", registerStatus: null });
  assert.deepEqual(mapExternalConsultantStatus("returned"), { consultantStatus: "revise_and_resubmit", registerStatus: "revise_and_resubmit" });
  assert.throws(() => mapExternalConsultantStatus("human_approved"), /Unsupported external consultant status/);
});

test("live Aconex and Procore adapters remain feature-gated", async () => {
  assert.deepEqual(listProviderCapabilities().map((item) => [item.provider, item.enabled]), [["aconex", false], ["procore", false]]);
  for (const adapter of [new AconexAdapter(), new ProcoreAdapter()]) {
    await assert.rejects(
      adapter.pullResponses({ tenantId: "tenant", projectId: "project", externalProjectId: "external" }),
      (error: unknown) => error instanceof IntegrationProviderError && error.code === "partner_approval_required" && !error.retryable,
    );
  }
});

test("mock provider is tenant-scoped and idempotent", async () => {
  const adapter = new MockIntegrationAdapter("aconex");
  const push = {
    tenantId: "tenant-a", projectId: "project-a", externalProjectId: "external-a", packageId: "package-a",
    idempotencyKey: "same-key", fileName: "package.zip", content: new Uint8Array([1]), metadata: {},
  };
  assert.deepEqual(await adapter.pushPackage(push), await adapter.pushPackage(push));
  assert.notDeepEqual(await adapter.pushPackage({ ...push, tenantId: "tenant-b" }), await adapter.pushPackage(push));

  adapter.seedResponse({
    tenantId: "tenant-a", projectId: "project-a", externalProjectId: "external-a", registerItemId: "item-a",
    externalEventId: "event-a", status: "approved", responseRef: "response-a",
  });
  assert.equal((await adapter.pullResponses({ tenantId: "tenant-a", projectId: "project-a", externalProjectId: "external-a" })).responses.length, 1);
  assert.equal((await adapter.pullResponses({ tenantId: "tenant-b", projectId: "project-a", externalProjectId: "external-a" })).responses.length, 0);
});

test("token metadata accepts only Australian Secrets Manager references", () => {
  const arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:submitsense/procore/token-AbCdEf";
  assert.equal(assertAustralianSecretReference(arn), arn);
  assert.throws(() => assertAustralianSecretReference("plaintext-access-token"), /Australian region/);
  assert.throws(() => assertAustralianSecretReference("arn:aws:secretsmanager:us-east-1:123456789012:secret:token"), /Australian region/);
});

test("integration persistence remains tenant-scoped and stores only token references", () => {
  const migration = readFileSync(resolve(process.cwd(), "../db/migrations/0012_integrations.sql"), "utf8");
  const service = readFileSync(resolve(process.cwd(), "src/api/api.service.ts"), "utf8");
  const webhook = service.slice(service.indexOf("async integrationWebhook"), service.indexOf("async createExportJob"));
  assert.match(migration, /token_reference\s+text/);
  assert.doesNotMatch(migration, /access_token\s+text|refresh_token\s+text/);
  assert.match(migration, /foreign key \(tenant_id, connection_id\)/);
  assert.match(webhook, /resolveIntegrationTenant\(connectionId, checkedProvider\)/);
  assert.doesNotMatch(webhook, /const tenantId\s*=.*body\.tenantId/);
});
