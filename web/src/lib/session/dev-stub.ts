import "server-only";
import type { MeResponse, Principal, TenantSession } from "@/lib/api/types";

/*
 * Dev auth stub. Lets us build and demo the whole UI before Cognito is wired.
 * Enabled with DEV_AUTH=1 (see .env.local). In production DEV_AUTH must be unset
 * so the real Cognito token path in session.ts is used instead.
 *
 * Two tenants with different roles so the tenant switcher and role-aware nav are
 * demonstrably real: an owner (every action) and a viewer (read-only).
 */
export const DEV_AUTH = process.env.DEV_AUTH === "1";

export const DEV_TENANT_OWNER = "00000000-0000-4000-8000-000000000001";
export const DEV_TENANT_VIEWER = "00000000-0000-4000-8000-000000000002";

const devPrincipal: Principal = {
  id: "00000000-0000-4000-8000-0000000000aa",
  email: "dev.reviewer@example.com.au",
  fullName: "Dev Reviewer",
  kind: "human",
};

// Mirrors tenantRolePermissions in backend/src/auth/permission-policy.json.
const OWNER_PERMISSIONS = [
  "project.read", "project.manage", "document.read", "document.upload",
  "register.read", "register.manage", "submittal.approve", "risk.review",
  "rfi.manage", "product.match", "vendor.manage", "package.manage",
  "integration.manage", "billing.manage", "content.author", "member.manage",
  "audit.read",
];
const VIEWER_PERMISSIONS = ["project.read", "document.read", "register.read"];

export const devMe: MeResponse = {
  user: devPrincipal,
  tenants: [
    {
      tenantId: DEV_TENANT_OWNER,
      tenantName: "Example Fire Pty Ltd",
      tenantSlug: "example-fire",
      role: "owner",
    },
    {
      tenantId: DEV_TENANT_VIEWER,
      tenantName: "Harbourside Mechanical",
      tenantSlug: "harbourside-mech",
      role: "viewer",
    },
  ],
};

export function devTenantSession(tenantId: string): TenantSession | null {
  const membership = devMe.tenants.find((t) => t.tenantId === tenantId);
  if (!membership) return null;
  return {
    userId: devPrincipal.id,
    tenantId,
    membershipId: `mem-${tenantId}`,
    role: membership.role,
    permissions:
      membership.role === "owner" ? OWNER_PERMISSIONS : VIEWER_PERMISSIONS,
    actorType: "human",
    mfaRequiredForAdmins: false,
  };
}

export const DEV_TOKEN = "dev-stub-token";
