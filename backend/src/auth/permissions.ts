import policy from "./permission-policy.json";
import type { ActorType, AuthAction, ProjectAccess, ProjectRoleKey, TenantRoleKey, UserKind } from "./auth.types";

interface ActionRule {
  permission: string;
  projectScoped: boolean;
  humanOnly?: boolean;
}

interface PermissionContext {
  tenantRole: TenantRoleKey;
  permissions: string[];
  actorType: ActorType;
  userKind: UserKind;
}

const actions = policy.actions as Record<AuthAction, ActionRule>;
const projectRoles = policy.projectRoles as Record<ProjectRoleKey, AuthAction[]>;
const tenantWideProjectRoles = new Set(policy.tenantWideProjectRoles as TenantRoleKey[]);

export function isAuthAction(value: string): value is AuthAction {
  return value in actions;
}

export function actionRule(action: AuthAction): ActionRule {
  return actions[action];
}

export function canPerformAction(ctx: PermissionContext, action: AuthAction, project?: ProjectAccess): boolean {
  const rule = actionRule(action);
  if (!ctx.permissions.includes(rule.permission)) return false;
  if (rule.humanOnly && (ctx.actorType !== "human" || ctx.userKind !== "human")) return false;
  if (!rule.projectScoped) return true;
  if (!project || (project.isArchived && action !== "archive")) return false;
  if (tenantWideProjectRoles.has(ctx.tenantRole)) return true;
  return !!project.projectRole && projectRoles[project.projectRole].includes(action);
}

export function listProjectActions(ctx: PermissionContext, project: ProjectAccess): AuthAction[] {
  return (Object.keys(actions) as AuthAction[]).filter((action) => canPerformAction(ctx, action, project));
}
