import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { AuthedRequest } from "./auth.types";
import { AuthService } from "./auth.service";
import { CognitoAuthGuard, PermissionGuard, RequirePermission, TenantGuard } from "./auth.guards";

function bodyObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("auth/cognito/link-user")
  async linkCognitoUser(@Headers("x-internal-auth") secret: string | undefined, @Body() body: unknown) {
    if (!process.env.AUTH_INTERNAL_SECRET || secret !== process.env.AUTH_INTERNAL_SECRET) {
      throw new UnauthorizedException("Invalid internal secret");
    }
    return this.auth.linkCognitoUser(bodyObject(body));
  }

  @UseGuards(CognitoAuthGuard)
  @Get("auth/me")
  async me(@Req() req: AuthedRequest) {
    const principal = req.principal!;
    await this.auth.recordLogin(principal);
    await this.auth.auditRaw({ actorUserId: principal.id, actorType: principal.kind === "human" ? "human" : "system" }, "login", "Backend session recognised", {}, req);
    return {
      user: principal,
      tenants: await this.auth.listMemberships(principal.id),
    };
  }

  @UseGuards(CognitoAuthGuard)
  @Post("auth/invitations/accept")
  acceptInvitation(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.auth.acceptInvitation(req.principal!, bodyObject(body), req);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission("member_manage")
  @Post("tenants/:tenantId/invitations")
  createInvitation(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.auth.createInvitation(req.auth!, bodyObject(body), req);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission("member_manage")
  @Post("tenants/:tenantId/invitations/:invitationId/revoke")
  revokeInvitation(@Req() req: AuthedRequest, @Param("invitationId") invitationId: string) {
    return this.auth.revokeInvitation(req.auth!, invitationId, req);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission("member_manage")
  @Post("tenants/:tenantId/invitations/:invitationId/resend")
  resendInvitation(@Req() req: AuthedRequest, @Param("invitationId") invitationId: string) {
    return this.auth.resendInvitation(req.auth!, invitationId, req);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission("member_manage")
  @Post("tenants/:tenantId/members/:userId/deactivate")
  deactivateMember(@Req() req: AuthedRequest, @Param("userId") userId: string) {
    return this.auth.deactivateTenantUser(req.auth!, userId, req);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission("member_manage")
  @Delete("tenants/:tenantId/members/:userId")
  removeMember(@Req() req: AuthedRequest, @Param("userId") userId: string) {
    return this.auth.deactivateTenantUser(req.auth!, userId, req);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission("project_manage", "projectId")
  @Post("tenants/:tenantId/projects/:projectId/members")
  grantProjectMember(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    return this.auth.grantProjectMember(req.auth!, projectId, bodyObject(body), req);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission("project_manage", "projectId")
  @Delete("tenants/:tenantId/projects/:projectId/members/:userId")
  revokeProjectMember(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("userId") userId: string) {
    return this.auth.revokeProjectMember(req.auth!, projectId, userId, req);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission("tenant_settings")
  @Patch("tenants/:tenantId/settings/data-use")
  updateDataUse(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.auth.updateTenantDataUse(req.auth!, bodyObject(body), req);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission("tenant_settings")
  @Patch("tenants/:tenantId/settings/security")
  updateSecuritySettings(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.auth.updateTenantSecuritySettings(req.auth!, bodyObject(body), req);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
  @RequirePermission("integration_admin")
  @Post("tenants/:tenantId/service-accounts")
  createServiceAccount(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.auth.createServiceAccount(req.auth!, bodyObject(body), req);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard)
  @Get("tenants/:tenantId/projects/:projectId/access")
  projectAccess(@Req() req: AuthedRequest, @Param("projectId") projectId: string) {
    return this.auth.projectAccess(req.auth!, projectId);
  }

  @UseGuards(CognitoAuthGuard, TenantGuard)
  @Get("tenants/:tenantId/session")
  tenantSession(@Req() req: AuthedRequest) {
    const ctx = req.auth!;
    return {
      userId: ctx.principal.id,
      tenantId: ctx.tenantId,
      membershipId: ctx.membershipId,
      role: ctx.tenantRole,
      permissions: ctx.permissions,
      actorType: ctx.actorType,
      mfaRequiredForAdmins: ctx.mfaRequiredForAdmins,
    };
  }

}
