import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import type { Pool } from "pg";
import { AuthService } from "../src/auth/auth.service";
import type { AuthContext } from "../src/auth/auth.types";

const actorId = "22222222-2222-2222-2222-222222222222";
const tenantId = "11111111-1111-1111-1111-111111111111";
const targetId = "33333333-3333-3333-3333-333333333333";

const ctx: AuthContext = {
  principal: {
    id: actorId,
    email: "owner@example.com",
    cognitoSub: "owner",
    fullName: "Owner",
    kind: "human",
    status: "active",
  },
  tenantId,
  membershipId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tenantRole: "owner",
  permissions: ["integration.manage", "member.manage"],
  actorType: "human",
  isOwner: true,
  mfaRequiredForAdmins: false,
};

function fakePool(statements: string[], activeInvite = false): Pool {
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("update tenant_memberships")) return { rows: [{ id: "membership" }] };
      if (sql.includes("app.create_service_account")) return { rows: [{ service_user_id: targetId, membership_id: "membership" }] };
      if (activeInvite && sql.includes("app.create_tenant_invitation")) throw Object.assign(new Error("already active"), { code: "55000" });
      if (sql.includes("app.create_tenant_invitation")) return { rows: [{ invitation_id: targetId, invited_user_id: targetId, membership_id: "membership" }] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    async connect() {
      return client;
    },
    async query(sql: string) {
      statements.push(sql);
      return { rows: [] };
    },
  } as unknown as Pool;
}

test("tenant deactivation suspends only the membership, not the global user", async () => {
  const statements: string[] = [];
  await new AuthService(fakePool(statements)).deactivateTenantUser(ctx, targetId);
  assert.ok(statements.some((sql) => sql.includes("update tenant_memberships")));
  assert.ok(!statements.some((sql) => /update\s+users/i.test(sql)));
});

test("service accounts cannot be assigned a human/admin tenant role", async () => {
  const statements: string[] = [];
  const service = new AuthService(fakePool(statements));
  await assert.rejects(
    service.createServiceAccount(ctx, { email: "bot@example.com", roleKey: "owner" }),
    ForbiddenException,
  );
  assert.ok(!statements.some((sql) => sql.includes("app.create_service_account")));
});

test("service-account creation binds the security-definer call to tenant context", async () => {
  const statements: string[] = [];
  await new AuthService(fakePool(statements)).createServiceAccount(ctx, { email: "bot@example.com" });
  const call = statements.findIndex((sql) => sql.includes("app.create_service_account"));
  assert.ok(call > statements.findIndex((sql) => sql.includes("app.tenant_id")));
  assert.ok(call > statements.findIndex((sql) => sql.includes("app.user_id")));
  assert.ok(statements.includes("commit"));
});

test("tenant invitation creation binds the security-definer call to tenant context", async () => {
  const statements: string[] = [];
  await new AuthService(fakePool(statements)).createInvitation(ctx, { email: "invitee@example.com", roleKey: "viewer" });
  const call = statements.findIndex((sql) => sql.includes("app.create_tenant_invitation"));
  assert.ok(call > statements.findIndex((sql) => sql.includes("app.tenant_id")));
  assert.ok(call > statements.findIndex((sql) => sql.includes("app.user_id")));
  assert.ok(statements.includes("commit"));
});

test("only tenant owners may request an owner invitation", async () => {
  const statements: string[] = [];
  await assert.rejects(
    new AuthService(fakePool(statements)).createInvitation({ ...ctx, isOwner: false }, { email: "invitee@example.com", roleKey: "owner" }),
    ForbiddenException,
  );
  assert.ok(!statements.some((sql) => sql.includes("app.create_tenant_invitation")));
});

test("inviting an already-active tenant member returns a conflict", async () => {
  await assert.rejects(
    new AuthService(fakePool([], true)).createInvitation(ctx, { email: "member@example.com", roleKey: "viewer" }),
    ConflictException,
  );
});
