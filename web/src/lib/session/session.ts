import "server-only";
import { cache } from "react";
import { apiFetch } from "@/lib/api/client";
import type { MeResponse, TenantSession } from "@/lib/api/types";
import { DEV_AUTH, devMe, devTenantSession } from "./dev-stub";
import { getAuthToken } from "./token";

/**
 * Current user + their tenant memberships (GET /auth/me).
 * `cache()` dedupes the call within a single request (layout + page + nav).
 */
export const getMe = cache(async (): Promise<MeResponse | null> => {
  if (DEV_AUTH) return devMe;
  const token = await getAuthToken();
  if (!token) return null;
  try {
    return await apiFetch<MeResponse>("/auth/me");
  } catch {
    return null;
  }
});

/**
 * Role + permission set for one tenant (GET /tenants/:id/session).
 * Returns null if the user has no active session for that tenant — callers
 * treat that as "not a member", which prevents cross-tenant URL access.
 */
export const getTenantSession = cache(
  async (tenantId: string): Promise<TenantSession | null> => {
    if (DEV_AUTH) return devTenantSession(tenantId);
    try {
      return await apiFetch<TenantSession>(`/tenants/${tenantId}/session`);
    } catch {
      return null;
    }
  },
);
