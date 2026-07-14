import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { AuthAction, AuthedRequest } from "./auth.types";
import { AuthService } from "./auth.service";
import { isAuthAction } from "./permissions";

const PERMISSION = "submitsense:permission";

interface PermissionMeta {
  action: AuthAction;
  projectParam?: string;
}

interface JwtVerifier {
  verify(token: string): Promise<Record<string, unknown>>;
}

export const RequirePermission = (action: AuthAction, projectParam?: string) => SetMetadata(PERMISSION, { action, projectParam });

@Injectable()
export class CognitoAuthGuard implements CanActivate {
  private readonly verifier: JwtVerifier | null;

  constructor(private readonly auth: AuthService) {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    const clientId = process.env.COGNITO_CLIENT_ID;
    this.verifier =
      userPoolId && clientId
        ? (CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" }) as unknown as JwtVerifier)
        : null;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    try {
      const token = this.bearer(req);
      const claims = await this.verify(token);
      const sub = typeof claims.sub === "string" ? claims.sub : "";
      if (!sub) throw new UnauthorizedException("Invalid token");

      const principal = await this.auth.resolvePrincipal(sub);
      if (!principal || principal.status !== "active") throw new UnauthorizedException("User is not active");

      req.principal = principal;
      req.cognitoClaims = claims;
      return true;
    } catch (e) {
      await this.auth.auditRaw({ actorType: "system" }, "failed_login", "Cognito token rejected", {}, req).catch(() => undefined);
      throw e;
    }
  }

  private bearer(req: AuthedRequest): string {
    const value = req.headers.authorization;
    const header = Array.isArray(value) ? value[0] : value;
    const match = header?.match(/^Bearer (.+)$/i);
    if (!match) throw new UnauthorizedException("Missing bearer token");
    return match[1];
  }

  private async verify(token: string): Promise<Record<string, unknown>> {
    if (this.verifier) return this.verifier.verify(token);
    if (["development", "test"].includes(process.env.NODE_ENV ?? "") && process.env.AUTH_ALLOW_UNSIGNED_JWT === "true") return this.decodeUnsignedJwt(token);
    throw new UnauthorizedException("Cognito verifier is not configured");
  }

  private decodeUnsignedJwt(token: string): Record<string, unknown> {
    const [, payload] = token.split(".");
    if (!payload) throw new UnauthorizedException("Invalid token");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  }
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.principal) throw new UnauthorizedException("Missing principal");
    const tenantId = req.params.tenantId ?? this.header(req, "x-tenant-id");
    if (!tenantId) throw new UnauthorizedException("Active tenant is required");
    req.auth = await this.auth.resolveTenantContext(req.principal, tenantId, req.cognitoClaims);
    return true;
  }

  private header(req: AuthedRequest, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<PermissionMeta>(PERMISSION, [context.getHandler(), context.getClass()]);
    if (!meta) return true;
    if (!isAuthAction(meta.action)) return false;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.auth) throw new UnauthorizedException("Missing tenant context");
    await this.auth.requireAction(req.auth, meta.action, meta.projectParam ? req.params[meta.projectParam] : undefined, req);
    return true;
  }
}
