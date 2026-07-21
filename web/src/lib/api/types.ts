/*
 * Types for the SubmitSense API responses the web app consumes.
 *
 * The backend OpenAPI document (`/api/v1/openapi.json`) declares paths but no
 * response schemas (every body is `type: object`), so code generation yields no
 * usable types. We hand-model what we render, mirroring db/docs/enums.md, and
 * grow this file per surface. Enum unions are the DB contract — keep them exact.
 */

// ── Enums (db/docs/enums.md) ────────────────────────────────────────────────
export type SubmittalStatus =
  | "draft"
  | "submitted"
  | "human_approved"
  | "revise_and_resubmit"
  | "rejected"
  | "closed"
  | "cancelled";

export type ProjectStatus =
  | "draft"
  | "active"
  | "on_hold"
  | "completed"
  | "archived"
  | "cancelled";

export type TradePackage =
  | "mechanical"
  | "electrical"
  | "hydraulic"
  | "fire_protection"
  | "communications"
  | "other";

export type JobStatus =
  | "queued"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RiskSeverity = "low" | "medium" | "high" | "critical";
export type RiskState = "open" | "confirmed" | "dismissed" | "resolved";
export type MatchDecision = "pending" | "accepted" | "rejected" | "superseded";
export type PackageStatus =
  | "draft"
  | "assembling"
  | "ready"
  | "submitted"
  | "superseded";
export type ExportStatus =
  | "pending"
  | "generating"
  | "ready"
  | "failed"
  | "delivered";
export type RfiReviewStatus = "draft" | "in_review" | "approved" | "rejected";
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete";
export type PlanTier = "trial" | "starter" | "professional" | "enterprise";
export type IntegrationStatus =
  | "connected"
  | "disconnected"
  | "error"
  | "revoked";
export type TenantRole =
  | "owner"
  | "admin"
  | "project_manager"
  | "reviewer"
  | "contributor"
  | "viewer"
  | "billing_admin"
  | "integration_admin";

// ── Auth / session ──────────────────────────────────────────────────────────
export interface Principal {
  id: string;
  email: string;
  fullName: string;
  kind: "human" | "service_account";
}

export interface Membership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: TenantRole;
}

/** GET /auth/me */
export interface MeResponse {
  user: Principal;
  tenants: Membership[];
}

/** GET /tenants/:tenantId/session */
export interface TenantSession {
  userId: string;
  tenantId: string;
  membershipId: string;
  role: TenantRole;
  permissions: string[];
  actorType: "human" | "system";
  mfaRequiredForAdmins: boolean;
}

// ── Projects ────────────────────────────────────────────────────────────────
// GET /tenants/:id/projects returns a bare array of these (api.service.ts).
export interface ProjectSummary {
  id: string;
  name: string;
  clientName: string | null;
  siteAddress: string | null;
  trade: TradePackage;
  status: ProjectStatus;
  isArchived: boolean;
  submissionDeadline: string | null;
  tenderCloseAt: string | null;
  projectRole: string | null;
  createdAt: string;
}

// GET /projects/:id/dashboard/status (api.service.ts dashboard()).
export interface DashboardResponse {
  status: { status: SubmittalStatus; count: number }[];
  due: { dueDate: string; count: number }[];
  overdueCount: number;
  packages: {
    id: string;
    name: string;
    status: PackageStatus;
    currentVersion: number | null;
    outputDocumentId: string | null;
    consultantPlatformRef: string | null;
  }[];
  items: unknown; // register-item list — modelled when we build the register
}

// ── Billing / pricing (public) ──────────────────────────────────────────────
// GET /pricing/plans returns a bare array (commercial.service.ts publicPlans()).
export interface PricingPlan {
  key: string;
  name: string;
  tier: PlanTier;
  description: string | null;
  priceCents: number | null;
  currency: string;
  billingInterval: "month" | "year" | null;
  taxInclusive: boolean;
  includedUsage: Record<string, unknown> | null;
  overagePolicy: string | null;
  featureLimits: Record<string, unknown> | null;
  features: unknown;
}
