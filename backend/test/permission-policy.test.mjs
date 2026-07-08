import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const policyUrl = new URL("../src/auth/permission-policy.json", import.meta.url);
const policy = JSON.parse(readFileSync(policyUrl, "utf8"));

test("all prompt-2 actions have permission mappings", () => {
  for (const action of ["read", "upload", "edit", "generate", "review", "sign_off", "export", "archive", "billing", "content_admin", "integration_admin"]) {
    assert.ok(policy.actions[action], action);
  }
});

test("human sign-off requires app permission and human actor gate", () => {
  assert.equal(policy.actions.sign_off.permission, "submittal.approve");
  assert.equal(policy.actions.sign_off.humanOnly, true);
  assert.ok(policy.tenantRolePermissions.reviewer.includes("submittal.approve"));
  assert.ok(!policy.tenantRolePermissions.contributor.includes("submittal.approve"));
});

test("viewer and billing admin stay least privilege", () => {
  assert.deepEqual(policy.projectRoles.viewer, ["read"]);
  assert.deepEqual(policy.tenantRolePermissions.billing_admin, ["billing.manage", "audit.read"]);
});

test("integration admin does not inherit billing or member management", () => {
  assert.deepEqual(policy.tenantRolePermissions.integration_admin, ["integration.manage", "audit.read"]);
});
