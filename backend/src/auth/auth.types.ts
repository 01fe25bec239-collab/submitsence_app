export type ActorType = "human" | "system";
export type UserKind = "human" | "service_account";
export type TenantRoleKey =
  | "owner"
  | "admin"
  | "project_manager"
  | "reviewer"
  | "contributor"
  | "viewer"
  | "billing_admin"
  | "integration_admin";
export type ProjectRoleKey = "lead" | "reviewer" | "contributor" | "viewer";
export type AuthAction =
  | "read"
  | "upload"
  | "edit"
  | "generate"
  | "review"
  | "rfi_manage"
  | "sign_off"
  | "export"
  | "archive"
  | "billing"
  | "content_admin"
  | "integration_admin"
  | "member_manage"
  | "project_manage"
  | "tenant_settings";

export interface Principal {
  id: string;
  email: string;
  cognitoSub: string;
  fullName: string;
  kind: UserKind;
  status: string;
}

export interface TenantMembership {
  membershipId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantStatus: string;
  membershipStatus: string;
  roleKey: TenantRoleKey;
  isOwner: boolean;
}

export interface AuthContext {
  principal: Principal;
  tenantId: string;
  membershipId: string;
  tenantRole: TenantRoleKey;
  permissions: string[];
  actorType: ActorType;
  isOwner: boolean;
  mfaRequiredForAdmins: boolean;
}

export interface ProjectAccess {
  projectRole: ProjectRoleKey | null;
  isArchived: boolean;
}

export interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string | undefined>;
  query?: Record<string, unknown>;
  body: unknown;
  method?: string;
  path?: string;
  originalUrl?: string;
  requestId?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
  principal?: Principal;
  auth?: AuthContext;
  cognitoClaims?: Record<string, unknown>;
}
