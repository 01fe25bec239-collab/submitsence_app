"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CreditCard,
  FolderKanban,
  LogOut,
  Package,
  Plug,
  ScrollText,
  Settings,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Membership, Principal, TenantSession } from "@/lib/api/types";
import { SessionProvider, type AppSession } from "@/lib/session/context";
import { can, PERM, type Permission } from "@/lib/session/permissions";
import { AssistiveDisclaimer } from "@/components/assistive-disclaimer";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface NavItem {
  slug: string;
  label: string;
  icon: LucideIcon;
  perm: Permission;
  ready: boolean; // false → shown but disabled until the surface is built
}

// The role-aware map. `ready` flips to true as each surface lands, so nav never
// links to an unbuilt page but still shows the full, permission-filtered shape.
const NAV: NavItem[] = [
  { slug: "projects", label: "Projects", icon: FolderKanban, perm: PERM.projectRead, ready: true },
  { slug: "vendors", label: "Vendors & products", icon: Package, perm: PERM.projectRead, ready: false },
  { slug: "audit", label: "Audit trail", icon: ScrollText, perm: PERM.auditRead, ready: false },
  { slug: "integrations", label: "Integrations", icon: Plug, perm: PERM.integrationManage, ready: false },
  { slug: "billing", label: "Billing", icon: CreditCard, perm: PERM.billingManage, ready: false },
  { slug: "settings", label: "Settings", icon: Settings, perm: PERM.memberManage, ready: false },
];

export function AppShell({
  user,
  tenants,
  tenant,
  children,
}: {
  user: Principal;
  tenants: Membership[];
  tenant: TenantSession;
  children: React.ReactNode;
}) {
  const session: AppSession = { user, tenants, tenant };
  const items = NAV.filter((item) => can(tenant.permissions, item.perm));

  return (
    <SessionProvider value={session}>
      <div className="flex min-h-dvh">
        <Sidebar tenant={tenant} tenants={tenants} user={user} items={items} />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="flex-1 px-6 py-6 md:px-8">{children}</main>
          <footer className="border-t px-6 py-3 md:px-8">
            <AssistiveDisclaimer />
          </footer>
        </div>
      </div>
    </SessionProvider>
  );
}

function Sidebar({
  tenant,
  tenants,
  user,
  items,
}: {
  tenant: TenantSession;
  tenants: Membership[];
  user: Principal;
  items: NavItem[];
}) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r bg-card md:flex">
      <div className="flex items-center gap-2 px-4 py-4">
        <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
        <span className="font-semibold tracking-tight">SubmitSense</span>
      </div>

      <div className="px-3 pb-2">
        <TenantSwitcher tenant={tenant} tenants={tenants} />
      </div>

      <nav aria-label="Primary" className="flex-1 space-y-0.5 px-3 py-2">
        {items.map((item) => (
          <NavLink key={item.slug} tenantId={tenant.tenantId} item={item} />
        ))}
      </nav>

      <div className="border-t p-3">
        <div className="mb-2 px-1">
          <p className="truncate text-sm font-medium">{user.fullName}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        </div>
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </Link>
      </div>
    </aside>
  );
}

function NavLink({ tenantId, item }: { tenantId: string; item: NavItem }) {
  const pathname = usePathname();
  const href = `/${tenantId}/${item.slug}`;
  const active = pathname === href || pathname.startsWith(`${href}/`);
  const Icon = item.icon;

  if (!item.ready) {
    return (
      <span
        aria-disabled="true"
        title="Coming soon"
        className="flex cursor-not-allowed items-center justify-between rounded-md px-2 py-1.5 text-sm text-muted-foreground/60"
      >
        <span className="flex items-center gap-2">
          <Icon className="size-4" aria-hidden="true" />
          {item.label}
        </span>
        <Badge variant="muted" className="text-[10px]">
          Soon
        </Badge>
      </span>
    );
  }

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {item.label}
    </Link>
  );
}

function TenantSwitcher({
  tenant,
  tenants,
}: {
  tenant: TenantSession;
  tenants: Membership[];
}) {
  const router = useRouter();
  return (
    <label className="block">
      <span className="sr-only">Switch workspace</span>
      <select
        value={tenant.tenantId}
        onChange={(e) => router.push(`/${e.target.value}/projects`)}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {tenants.map((t) => (
          <option key={t.tenantId} value={t.tenantId}>
            {t.tenantName}
          </option>
        ))}
      </select>
    </label>
  );
}
