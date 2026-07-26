import "server-only";
import { DEV_AUTH, DEV_TENANT_VIEWER } from "@/lib/session/dev-stub";
import type {
  DashboardResponse,
  PricingPlan,
  ProjectSummary,
} from "./types";

/*
 * Dev mock data. When DEV_AUTH=1 (no real backend), apiFetch serves these
 * fixtures for known read endpoints so every screen renders with realistic
 * sample data. Any path without a fixture falls through to a real fetch.
 * Turns off entirely when DEV_AUTH=0 — nothing to remove when the backend lands.
 */
export const MOCK_ENABLED = DEV_AUTH;

// ── Pricing (approved launch catalog) ───────────────────────────────────────
const PLANS: PricingPlan[] = [
  {
    key: "trial",
    name: "Free Trial",
    tier: "trial",
    description: "Run your 3 hardest worksections, free for 14 days.",
    priceCents: 0,
    currency: "AUD",
    billingInterval: null,
    taxInclusive: true,
    includedUsage: { users: 1, projects: 1, worksections: 3 },
    overagePolicy: null,
    featureLimits: null,
    features: ["Extraction with cited sources", "Submittal register"],
  },
  {
    key: "starter",
    name: "Starter",
    tier: "starter",
    description: "For small teams getting submittals out the door.",
    priceCents: 14900,
    currency: "AUD",
    billingInterval: "month",
    taxInclusive: true,
    includedUsage: { users: 3, projects: 3, worksectionsPerMonth: 50 },
    overagePolicy: "No automatic overage charges.",
    featureLimits: null,
    features: ["Vendor matching", "Rejection-risk checklists", "RFI drafts"],
  },
  {
    key: "professional",
    name: "Professional",
    tier: "professional",
    description: "For busy subcontractors across multiple projects.",
    priceCents: 39900,
    currency: "AUD",
    billingInterval: "month",
    taxInclusive: true,
    includedUsage: { users: 10, projects: 15, worksectionsPerMonth: 250 },
    overagePolicy: "No automatic overage charges.",
    featureLimits: null,
    features: ["Aconex/Procore export", "Audit export", "Priority support"],
  },
  {
    key: "enterprise",
    name: "Enterprise",
    tier: "enterprise",
    description: "SSO included. Limits agreed in your order form.",
    priceCents: null,
    currency: "AUD",
    billingInterval: null,
    taxInclusive: true,
    includedUsage: { users: "Custom", projects: "Custom" },
    overagePolicy: null,
    featureLimits: null,
    features: ["SSO / SAML", "Dedicated onboarding"],
  },
];

// ── Projects ────────────────────────────────────────────────────────────────
function project(p: Partial<ProjectSummary> & Pick<ProjectSummary, "id" | "name">): ProjectSummary {
  return {
    clientName: null,
    siteAddress: null,
    trade: "fire_protection",
    status: "active",
    isArchived: false,
    submissionDeadline: null,
    tenderCloseAt: null,
    projectRole: "lead",
    createdAt: "2026-05-01T00:00:00.000Z",
    ...p,
  };
}

const OWNER_PROJECTS: ProjectSummary[] = [
  project({
    id: "aa000000-0000-4000-8000-0000000000p1",
    name: "Riverbank Tower",
    clientName: "Meridian Construction",
    siteAddress: "12 Riverbank Rd, Southbank VIC",
    trade: "fire_protection",
    status: "active",
    submissionDeadline: "2026-08-14T00:00:00.000Z",
  }),
  project({
    id: "aa000000-0000-4000-8000-0000000000p2",
    name: "Southgate Hospital — Stage 2",
    clientName: "HealthBuild Group",
    trade: "mechanical",
    status: "active",
    submissionDeadline: "2026-09-02T00:00:00.000Z",
  }),
  project({
    id: "aa000000-0000-4000-8000-0000000000p3",
    name: "Metro Line Ventilation",
    clientName: "TransConnect JV",
    trade: "hydraulic",
    status: "on_hold",
    submissionDeadline: null,
  }),
  project({
    id: "aa000000-0000-4000-8000-0000000000p4",
    name: "Coastal Plaza Retail",
    clientName: "Seaboard Developments",
    trade: "electrical",
    status: "draft",
    projectRole: null,
  }),
];

const VIEWER_PROJECTS: ProjectSummary[] = [
  project({
    id: "bb000000-0000-4000-8000-0000000000p1",
    name: "Harbourside Fitout",
    clientName: "Portside Builders",
    trade: "fire_protection",
    status: "active",
    projectRole: "viewer",
    submissionDeadline: "2026-08-28T00:00:00.000Z",
  }),
];

const ALL_PROJECTS = [...OWNER_PROJECTS, ...VIEWER_PROJECTS];

// ── Dashboards ──────────────────────────────────────────────────────────────
const DEFAULT_DASHBOARD: DashboardResponse = {
  status: [
    { status: "draft", count: 3 },
    { status: "submitted", count: 4 },
    { status: "human_approved", count: 6 },
  ],
  due: [{ dueDate: "2026-08-01", count: 2 }],
  overdueCount: 0,
  packages: [],
  items: [],
};

const DASHBOARDS: Record<string, DashboardResponse> = {
  "aa000000-0000-4000-8000-0000000000p1": {
    status: [
      { status: "draft", count: 5 },
      { status: "submitted", count: 8 },
      { status: "human_approved", count: 12 },
      { status: "revise_and_resubmit", count: 2 },
      { status: "rejected", count: 1 },
    ],
    due: [
      { dueDate: "2026-07-25", count: 3 },
      { dueDate: "2026-08-05", count: 4 },
    ],
    overdueCount: 2,
    packages: [
      { id: "pkg-1", name: "Sprinkler heads submittal", status: "ready", currentVersion: 2, outputDocumentId: "doc-1", consultantPlatformRef: null },
      { id: "pkg-2", name: "Fire pump set", status: "draft", currentVersion: 1, outputDocumentId: null, consultantPlatformRef: null },
    ],
    items: [],
  },
};

// ── Router ──────────────────────────────────────────────────────────────────
/** Returns a fixture for a known GET path, or undefined (→ real fetch). */
export function mockResponse(path: string, method: string): unknown | undefined {
  if (method !== "GET") return undefined;
  const p = path.split("?")[0];

  if (p === "/pricing/plans") return PLANS;

  let m = p.match(/^\/tenants\/([^/]+)\/projects$/);
  if (m) return m[1] === DEV_TENANT_VIEWER ? VIEWER_PROJECTS : OWNER_PROJECTS;

  m = p.match(/^\/tenants\/[^/]+\/projects\/([^/]+)\/dashboard\/status$/);
  if (m) return DASHBOARDS[m[1]] ?? DEFAULT_DASHBOARD;

  m = p.match(/^\/tenants\/[^/]+\/projects\/([^/]+)$/);
  if (m) return ALL_PROJECTS.find((x) => x.id === m![1]) ?? ALL_PROJECTS[0];

  return undefined;
}
