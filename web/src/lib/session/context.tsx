"use client";
import { createContext, useContext } from "react";
import type { Membership, Principal, TenantSession } from "@/lib/api/types";
import { can, type Permission } from "./permissions";

export interface AppSession {
  user: Principal;
  tenants: Membership[];
  tenant: TenantSession;
}

const SessionContext = createContext<AppSession | null>(null);

export function SessionProvider({
  value,
  children,
}: {
  value: AppSession;
  children: React.ReactNode;
}) {
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): AppSession {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return ctx;
}

/** True if the active tenant grants `permission`. Use to gate client actions. */
export function usePermission(permission: Permission): boolean {
  const { tenant } = useSession();
  return can(tenant.permissions, permission);
}
