import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { HttpException } from "@nestjs/common";
import { ApiController } from "../src/api/api.controller";
import {
  MAX_RATE_LIMIT_BUCKETS,
  MAX_RATE_LIMIT_ROUTES_PER_CLIENT,
  rateLimitBucketCount,
  rateLimitMiddleware,
} from "../src/api/rate-limit";
import { CognitoAuthGuard } from "../src/auth/auth.guards";
import { canPerformAction } from "../src/auth/permissions";

const permission = (method: keyof ApiController) =>
  Reflect.getMetadata("submitsense:permission", ApiController.prototype[method]) as { action: string; projectParam: string };

test("project and RFI mutating routes carry project-scoped permissions", () => {
  for (const method of ["archiveProject", "unarchiveProject"] as const) assert.deepEqual(permission(method), { action: "archive", projectParam: "projectId" });
  for (const method of ["generateRfi", "updateRfi"] as const) assert.deepEqual(permission(method), { action: "rfi_manage", projectParam: "projectId" });
  for (const method of ["reviewRfi", "exportRfi", "handoffRfi"] as const) assert.deepEqual(permission(method), { action: "review", projectParam: "projectId" });
});

test("only archive actions remain available on archived projects", () => {
  const project = { projectRole: "lead" as const, isArchived: true };
  const manager = { tenantRole: "project_manager" as const, permissions: ["project.manage"], actorType: "human" as const, userKind: "human" as const };
  assert.equal(canPerformAction(manager, "archive", project), true);
  assert.equal(canPerformAction(manager, "project_manage", project), false);
  assert.equal(canPerformAction({ tenantRole: "viewer", permissions: ["project.manage"], actorType: "human", userKind: "human" }, "archive", { ...project, projectRole: "viewer" }), false);
});

test("unsigned JWTs are accepted only in explicit development and test environments", async () => {
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    allowUnsigned: process.env.AUTH_ALLOW_UNSIGNED_JWT,
    poolId: process.env.COGNITO_USER_POOL_ID,
    clientId: process.env.COGNITO_CLIENT_ID,
  };
  delete process.env.COGNITO_USER_POOL_ID;
  delete process.env.COGNITO_CLIENT_ID;
  process.env.AUTH_ALLOW_UNSIGNED_JWT = "true";
  const token = `x.${Buffer.from(JSON.stringify({ sub: "test-user" })).toString("base64url")}.x`;
  const guard = new CognitoAuthGuard({} as never);
  const verify = (guard as unknown as { verify(token: string): Promise<Record<string, unknown>> }).verify.bind(guard);

  try {
    process.env.NODE_ENV = "production";
    await assert.rejects(verify(token), /Cognito verifier is not configured/);
    delete process.env.NODE_ENV;
    await assert.rejects(verify(token), /Cognito verifier is not configured/);
    process.env.NODE_ENV = "staging";
    await assert.rejects(verify(token), /Cognito verifier is not configured/);
    process.env.NODE_ENV = "test";
    assert.equal((await verify(token)).sub, "test-user");
    process.env.NODE_ENV = "development";
    assert.equal((await verify(token)).sub, "test-user");
  } finally {
    for (const [key, value] of Object.entries({
      NODE_ENV: saved.nodeEnv,
      AUTH_ALLOW_UNSIGNED_JWT: saved.allowUnsigned,
      COGNITO_USER_POOL_ID: saved.poolId,
      COGNITO_CLIENT_ID: saved.clientId,
    })) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("varying resource IDs share the same expensive-operation rate bucket", () => {
  let passed = 0;
  for (let i = 0; i < 10; i += 1) {
    rateLimitMiddleware({ ip: "rate-id-test", method: "POST", path: `/tenants/${i}/projects/${i}/risk-flags/generate` }, {}, () => { passed += 1; });
  }
  assert.throws(
    () => rateLimitMiddleware({ ip: "rate-id-test", method: "POST", path: "/tenants/99/projects/99/risk-flags/generate" }, {}, () => { passed += 1; }),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
  );
  assert.equal(passed, 10);
});

test("varying UUIDs share the same expensive-operation rate bucket", () => {
  for (let i = 0; i < 10; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    rateLimitMiddleware({ ip: "rate-uuid-test", method: "POST", path: `/tenants/${id}/projects/${id}/export` }, {}, () => undefined);
  }
  assert.throws(
    () => rateLimitMiddleware({ ip: "rate-uuid-test", method: "POST", path: "/tenants/%31%31%31%31%31%31%31%31-%31%31%31%31-%34%31%31%31-%38%31%31%31-%31%31%31%31%31%31%31%31%31%31%31%31/projects/%32%32%32%32%32%32%32%32-%32%32%32%32-%34%32%32%32-%38%32%32%32-%32%32%32%32%32%32%32%32%32%32%32%32/export" }, {}, () => undefined),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
  );
});

test("unrelated expensive endpoints keep independent rate buckets", () => {
  for (let i = 0; i < 10; i += 1) {
    rateLimitMiddleware({ ip: "rate-route-test", method: "POST", path: `/tenants/${i}/projects/${i}/risk-flags/generate` }, {}, () => undefined);
  }
  assert.doesNotThrow(() =>
    rateLimitMiddleware({ ip: "rate-route-test", method: "POST", path: "/tenants/1/projects/1/packages/generate" }, {}, () => undefined),
  );
});

test("path casing cannot bypass an expensive-operation bucket", () => {
  for (let i = 0; i < 10; i += 1) {
    const path = i % 2 === 0 ? "/Tenants/1/Projects/1/RFIS/Generate" : "/tenants/1/projects/1/rfis/generate";
    rateLimitMiddleware({ ip: "rate-case-test", method: "POST", path }, {}, () => undefined);
  }
  assert.throws(
    () => rateLimitMiddleware({ ip: "rate-case-test", method: "POST", path: "/TENANTS/2/PROJECTS/2/RFIS/GENERATE" }, {}, () => undefined),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
  );
});

test("route overflow throttles only the client that created it", () => {
  for (let i = 0; i < MAX_RATE_LIMIT_ROUTES_PER_CLIENT - 1; i += 1) {
    rateLimitMiddleware({ ip: "rate-attacker", method: "GET", path: `/arbitrary/route-${i.toString(36)}-x` }, {}, () => undefined);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    rateLimitMiddleware({ ip: "rate-attacker", method: "GET", path: `/overflow/path-${attempt.toString(36)}-x` }, {}, () => undefined);
  }
  assert.throws(
    () => rateLimitMiddleware({ ip: "rate-attacker", method: "GET", path: "/overflow/blocked-x" }, {}, () => undefined),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
  );
  assert.doesNotThrow(() =>
    rateLimitMiddleware({ ip: "rate-innocent", method: "POST", path: "/still-another/%invalid-path" }, {}, () => undefined),
  );
});

test("global rate-limit storage stays capped under many clients", () => {
  for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS + 100; i += 1) {
    rateLimitMiddleware({ ip: `global-client-${i}`, method: "GET", path: "/health" }, {}, () => undefined);
  }
  assert.ok(rateLimitBucketCount() <= MAX_RATE_LIMIT_BUCKETS);
});
