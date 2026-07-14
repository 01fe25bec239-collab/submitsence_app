import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenantClient } from "../db/tenant-db";
import { PG_POOL } from "../db.module";
import type {
  ActorType,
  AuthAction,
  AuthContext,
  AuthedRequest,
  Principal,
  ProjectAccess,
  TenantMembership,
  TenantRoleKey,
} from "./auth.types";
import { actionRule, canPerformAction, listProjectActions } from "./permissions";
import * as v from "./validation";

type AuditEventType = "auth_sensitive" | "admin_action" | "consent_change";

interface PrincipalRow {
  id: string;
  email: string;
  cognito_sub: string;
  full_name: string;
  kind: "human" | "service_account";
  status: string;
}

interface MembershipRow {
  membershipId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantStatus: string;
  membershipStatus: string;
  roleId: string;
  roleKey: TenantRoleKey;
  isOwner: boolean;
  mfaRequiredForAdmins: boolean;
}

@Injectable()
export class AuthService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async resolvePrincipal(cognitoSub: string): Promise<Principal | null> {
    const result = await this.pool.query<PrincipalRow>(
      `select id, email, cognito_sub, full_name, kind, status
         from app.resolve_cognito_principal($1)`,
      [cognitoSub],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      cognitoSub: row.cognito_sub,
      fullName: row.full_name,
      kind: row.kind,
      status: row.status,
    };
  }

  async linkCognitoUser(body: Record<string, unknown>): Promise<{ userId: string }> {
    const result = await this.pool.query<{ user_id: string }>(
      `select app.link_cognito_user($1, $2, $3) as user_id`,
      [v.string(body.cognitoSub, "cognitoSub"), v.email(body.email), v.string(body.fullName ?? body.email, "fullName")],
    );
    const userId = result.rows[0]?.user_id;
    await this.auditRaw({ actorType: "system" }, "cognito_link", "Cognito user linked", { userId });
    return { userId };
  }

  async recordLogin(principal: Principal): Promise<void> {
    await this.pool.query(`select app.record_auth_login($1)`, [principal.id]);
  }

  async listMemberships(userId: string): Promise<TenantMembership[]> {
    return this.withUserContext(userId, async (client) => {
      const result = await client.query<MembershipRow>(
        `select m.id as "membershipId",
                m.tenant_id as "tenantId",
                t.slug as "tenantSlug",
                t.name as "tenantName",
                t.status as "tenantStatus",
                m.status as "membershipStatus",
                r.id as "roleId",
                r.key as "roleKey",
                m.is_owner as "isOwner"
           from tenant_memberships m
           join tenants t on t.id = m.tenant_id
           join roles r on r.id = m.role_id
          where m.user_id = $1
          order by t.name`,
        [userId],
      );
      return result.rows.map(({ roleId: _roleId, ...row }) => row);
    });
  }

  async resolveTenantContext(principal: Principal, tenantId: string, claims: Record<string, unknown> = {}): Promise<AuthContext> {
    const activeTenantId = v.uuid(tenantId, "tenantId");
    const row = await this.withUserContext(principal.id, async (client) => {
      const result = await client.query<MembershipRow>(
        `select m.id as "membershipId",
                m.tenant_id as "tenantId",
                t.slug as "tenantSlug",
                t.name as "tenantName",
                t.status as "tenantStatus",
                m.status as "membershipStatus",
                r.id as "roleId",
                r.key as "roleKey",
                m.is_owner as "isOwner",
                coalesce((t.settings ->> 'mfaRequiredForAdmins')::boolean, false) as "mfaRequiredForAdmins"
           from tenant_memberships m
           join tenants t on t.id = m.tenant_id
           join roles r on r.id = m.role_id
          where m.user_id = $1 and m.tenant_id = $2`,
        [principal.id, activeTenantId],
      );
      return result.rows[0];
    });

    if (!row || row.tenantStatus !== "active" || row.membershipStatus !== "active") {
      throw new ForbiddenException("Forbidden");
    }
    if (row.mfaRequiredForAdmins && (row.roleKey === "owner" || row.roleKey === "admin") && !this.hasMfaClaim(claims)) {
      await this.auditRaw({ tenantId: activeTenantId, actorUserId: principal.id, actorType: "human" }, "mfa_required", "MFA required for admin tenant access");
      throw new UnauthorizedException("MFA required");
    }

    return {
      principal,
      tenantId: row.tenantId,
      membershipId: row.membershipId,
      tenantRole: row.roleKey,
      permissions: await this.permissionsForRole(row.roleId),
      actorType: principal.kind === "human" ? "human" : "system",
      isOwner: row.isOwner,
      mfaRequiredForAdmins: row.mfaRequiredForAdmins,
    };
  }

  async requireTenantPermission(ctx: AuthContext, permission: string, req?: AuthedRequest): Promise<void> {
    if (ctx.permissions.includes(permission)) return;
    await this.audit(ctx, "permission_denied", "Permission denied", { permission }, req);
    throw new ForbiddenException("Forbidden");
  }

  async requireAction(
    ctx: AuthContext,
    action: AuthAction,
    projectId?: string,
    req?: AuthedRequest,
  ): Promise<ProjectAccess | null> {
    const rule = actionRule(action);
    const project = rule.projectScoped ? await this.loadProjectAccess(ctx, v.uuid(projectId, "projectId")) : undefined;

    if (
      canPerformAction(
        {
          tenantRole: ctx.tenantRole,
          permissions: ctx.permissions,
          actorType: ctx.actorType,
          userKind: ctx.principal.kind,
        },
        action,
        project ?? undefined,
      )
    ) {
      return project ?? null;
    }

    await this.audit(ctx, "permission_denied", "Permission denied", { action, projectId }, req);
    throw new ForbiddenException("Forbidden");
  }

  async projectAccess(ctx: AuthContext, projectId: string): Promise<{ project: ProjectAccess; actions: AuthAction[] }> {
    const project = await this.loadProjectAccess(ctx, v.uuid(projectId, "projectId"));
    if (!project) throw new ForbiddenException("Forbidden");
    const permissionContext = {
      tenantRole: ctx.tenantRole,
      permissions: ctx.permissions,
      actorType: ctx.actorType,
      userKind: ctx.principal.kind,
    };
    if (!canPerformAction(permissionContext, "read", project)) throw new ForbiddenException("Forbidden");
    return {
      project,
      actions: listProjectActions(permissionContext, project),
    };
  }

  async createInvitation(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    const roleKey = v.tenantRole(body.roleKey);
    if (roleKey === "owner" && !ctx.isOwner) throw new ForbiddenException("Forbidden");

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + Number(process.env.INVITE_TTL_DAYS ?? 7) * 86_400_000);
    let row: { invitation_id: string; invited_user_id: string; membership_id: string };
    try {
      row = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
        const result = await client.query<typeof row>(
          `select * from app.create_tenant_invitation($1, $2, $3, $4, $5, $6, $7)`,
          [
            ctx.tenantId,
            v.email(body.email),
            typeof body.fullName === "string" ? body.fullName : "",
            roleKey,
            ctx.principal.id,
            this.hashToken(token),
            expiresAt,
          ],
        );
        return result.rows[0];
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "55000") {
        throw new ConflictException("User is already an active tenant member");
      }
      throw error;
    }
    await this.audit(ctx, "invite_create", "Tenant invitation created", { invitationId: row.invitation_id, roleKey }, req);
    return { ...row, roleKey, expiresAt: expiresAt.toISOString(), token };
  }

  async acceptInvitation(principal: Principal, body: Record<string, unknown>, req?: AuthedRequest) {
    const result = await this.pool.query<{ tenant_id: string; membership_id: string }>(
      `select * from app.accept_tenant_invitation($1, $2)`,
      [this.hashToken(v.string(body.token, "token")), principal.id],
    );
    const row = result.rows[0];
    if (!row) throw new UnauthorizedException("Invalid invitation");
    await this.auditRaw(
      { tenantId: row.tenant_id, actorUserId: principal.id, actorType: principal.kind === "human" ? "human" : "system" },
      "invite_accept",
      "Tenant invitation accepted",
      { membershipId: row.membership_id },
      req,
    );
    return { tenantId: row.tenant_id, membershipId: row.membership_id };
  }

  async revokeInvitation(ctx: AuthContext, invitationId: string, req?: AuthedRequest) {
    const id = v.uuid(invitationId, "invitationId");
    const row = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ id: string; email: string }>(
        `update tenant_invitations
            set revoked_at = now()
          where id = $1 and accepted_at is null and revoked_at is null
          returning id, email`,
        [id],
      );
      return result.rows[0];
    });
    if (!row) throw new ForbiddenException("Forbidden");
    await this.audit(ctx, "invite_revoke", "Tenant invitation revoked", { invitationId: id }, req);
    return row;
  }

  async resendInvitation(ctx: AuthContext, invitationId: string, req?: AuthedRequest) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + Number(process.env.INVITE_TTL_DAYS ?? 7) * 86_400_000);
    const row = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ id: string; email: string }>(
        `update tenant_invitations
            set token_hash = $2, expires_at = $3
          where id = $1 and accepted_at is null and revoked_at is null
          returning id, email`,
        [v.uuid(invitationId, "invitationId"), this.hashToken(token), expiresAt],
      );
      return result.rows[0];
    });
    if (!row) throw new ForbiddenException("Forbidden");
    await this.audit(ctx, "invite_resend", "Tenant invitation resent", { invitationId }, req);
    return { ...row, expiresAt: expiresAt.toISOString(), token };
  }

  async deactivateTenantUser(ctx: AuthContext, userId: string, req?: AuthedRequest) {
    const targetUserId = v.uuid(userId, "userId");
    if (targetUserId === ctx.principal.id) throw new BadRequestException("cannot deactivate yourself");
    const row = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ id: string }>(
        `update tenant_memberships
            set status = 'suspended'
          where tenant_id = $1 and user_id = $2 and is_owner = false
          returning id`,
        [ctx.tenantId, targetUserId],
      );
      return result.rows[0];
    });
    if (!row) throw new ForbiddenException("Forbidden");
    await this.audit(ctx, "member_deactivate", "Tenant member deactivated", { userId: targetUserId }, req, "admin_action");
    return row;
  }

  async grantProjectMember(ctx: AuthContext, projectId: string, body: Record<string, unknown>, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const userId = v.uuid(body.userId, "userId");
    const role = v.projectRole(body.role);
    const row = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const member = await client.query(`select 1 from tenant_memberships where tenant_id = $1 and user_id = $2 and status = 'active'`, [
        ctx.tenantId,
        userId,
      ]);
      if (!member.rows[0]) return null;
      const result = await client.query<{ id: string }>(
        `insert into project_memberships (tenant_id, project_id, user_id, role)
         values ($1, $2, $3, $4)
         on conflict (project_id, user_id) do update set role = excluded.role, updated_at = now()
         returning id`,
        [ctx.tenantId, pid, userId, role],
      );
      return result.rows[0];
    });
    if (!row) throw new ForbiddenException("Forbidden");
    await this.audit(ctx, "project_access_grant", "Project access granted", { projectId: pid, userId, role }, req, "admin_action");
    return row;
  }

  async revokeProjectMember(ctx: AuthContext, projectId: string, userId: string, req?: AuthedRequest) {
    const pid = v.uuid(projectId, "projectId");
    const targetUserId = v.uuid(userId, "userId");
    const row = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ id: string }>(
        `delete from project_memberships
          where tenant_id = $1 and project_id = $2 and user_id = $3
          returning id`,
        [ctx.tenantId, pid, targetUserId],
      );
      return result.rows[0];
    });
    if (!row) throw new ForbiddenException("Forbidden");
    await this.audit(ctx, "project_access_revoke", "Project access revoked", { projectId: pid, userId: targetUserId }, req, "admin_action");
    return row;
  }

  async updateTenantDataUse(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    const learningLoop = v.consentState(body.learningLoop);
    const dataUsePreferences = v.object(body.dataUsePreferences, "dataUsePreferences");
    const row = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ id: string }>(
        `insert into tenant_consents (tenant_id, learning_loop, data_use_preferences, decided_by, decided_at)
         values ($1, $2, $3::jsonb, $4, now())
         on conflict (tenant_id) do update
           set learning_loop = excluded.learning_loop,
               data_use_preferences = excluded.data_use_preferences,
               decided_by = excluded.decided_by,
               decided_at = excluded.decided_at,
               updated_at = now()
         returning id`,
        [ctx.tenantId, learningLoop, JSON.stringify(dataUsePreferences), ctx.principal.id],
      );
      return result.rows[0];
    });
    await this.audit(ctx, "tenant_data_use_update", "Tenant data-use settings updated", { learningLoop }, req, "consent_change");
    return row;
  }

  async updateTenantSecuritySettings(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    const mfaRequiredForAdmins = v.boolean(body.mfaRequiredForAdmins, "mfaRequiredForAdmins");
    const row = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ id: string; settings: Record<string, unknown> }>(
        `update tenants
            set settings = jsonb_set(settings, '{mfaRequiredForAdmins}', to_jsonb($2::boolean), true),
                updated_at = now()
          where id = $1
          returning id, settings`,
        [ctx.tenantId, mfaRequiredForAdmins],
      );
      return result.rows[0];
    });
    await this.audit(ctx, "tenant_security_update", "Tenant security settings updated", { mfaRequiredForAdmins }, req, "admin_action");
    return row;
  }

  async createServiceAccount(ctx: AuthContext, body: Record<string, unknown>, req?: AuthedRequest) {
    const roleKey = typeof body.roleKey === "string" ? v.tenantRole(body.roleKey) : "integration_admin";
    if (roleKey !== "integration_admin") throw new ForbiddenException("Forbidden");
    const row = await withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ service_user_id: string; membership_id: string }>(
        `select * from app.create_service_account($1, $2, $3, $4, $5)`,
        [
          ctx.tenantId,
          v.email(body.email),
          v.string(body.fullName ?? body.email, "fullName"),
          roleKey,
          ctx.principal.id,
        ],
      );
      return result.rows[0];
    });
    await this.audit(ctx, "service_account_create", "Service account created", { userId: row.service_user_id }, req, "admin_action");
    return row;
  }

  async audit(
    ctx: AuthContext | null,
    action: string,
    summary: string,
    payload: Record<string, unknown> = {},
    req?: AuthedRequest,
    eventType: AuditEventType = "auth_sensitive",
  ): Promise<void> {
    await this.auditRaw(
      {
        tenantId: ctx?.tenantId,
        actorUserId: ctx?.principal.id,
        actorType: ctx?.actorType,
      },
      action,
      summary,
      payload,
      req,
      eventType,
    );
  }

  async auditRaw(
    actor: { tenantId?: string; actorUserId?: string; actorType?: ActorType | "system" },
    action: string,
    summary: string,
    payload: Record<string, unknown> = {},
    req?: AuthedRequest,
    eventType: AuditEventType = "auth_sensitive",
  ): Promise<void> {
    await this.pool.query(
      `select app.auth_audit($1::uuid, $2::uuid, $3::text, $4::text, $5::text,
                             $6::jsonb, nullif($7::text, '')::inet, $8::text, $9::audit_event_type)`,
      [
        actor.tenantId ?? null,
        actor.actorUserId ?? null,
        actor.actorType ?? "system",
        action,
        summary,
        JSON.stringify(payload),
        this.ip(req) ?? "",
        this.userAgent(req),
        eventType,
      ],
    );
  }

  private async permissionsForRole(roleId: string): Promise<string[]> {
    const result = await this.pool.query<{ key: string }>(
      `select p.key
         from role_permissions rp
         join permissions p on p.id = rp.permission_id
        where rp.role_id = $1`,
      [roleId],
    );
    return result.rows.map((row) => row.key);
  }

  private async loadProjectAccess(ctx: AuthContext, projectId: string): Promise<ProjectAccess | null> {
    return withTenantClient(this.pool, this.dbContext(ctx), async (client) => {
      const result = await client.query<{ isArchived: boolean; projectRole: ProjectAccess["projectRole"] }>(
        `select p.is_archived as "isArchived", pm.role as "projectRole"
           from projects p
           left join project_memberships pm
             on pm.tenant_id = p.tenant_id
            and pm.project_id = p.id
            and pm.user_id = $2
          where p.id = $1`,
        [projectId, ctx.principal.id],
      );
      return result.rows[0] ?? null;
    });
  }

  private async withUserContext<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.user_id', $1, true)", [userId]);
      await client.query("select set_config('app.actor_type', $1, true)", ["human"]);
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  private dbContext(ctx: AuthContext) {
    return { tenantId: ctx.tenantId, userId: ctx.principal.id, actorType: ctx.actorType };
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private ip(req?: AuthedRequest): string | null {
    return req?.ip ?? req?.socket?.remoteAddress ?? null;
  }

  private userAgent(req?: AuthedRequest): string | null {
    const value = req?.headers["user-agent"];
    return Array.isArray(value) ? value[0] ?? null : value ?? null;
  }

  private hasMfaClaim(claims: Record<string, unknown>): boolean {
    const raw = claims.amr ?? claims["cognito:amr"];
    const values = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
    return values.some((value) => value === "mfa" || value === "sms_mfa" || value === "software_token_mfa");
  }
}
