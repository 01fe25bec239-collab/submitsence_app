import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import { getMe, getTenantSession } from "@/lib/session/session";

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;

  const me = await getMe();
  if (!me) redirect("/");

  // Membership check first: an unknown tenantId in the URL must 404, never leak
  // that the tenant exists or fall through to another tenant's data.
  const membership = me.tenants.find((t) => t.tenantId === tenantId);
  if (!membership) notFound();

  const tenant = await getTenantSession(tenantId);
  if (!tenant) notFound();

  return (
    <AppShell user={me.user} tenants={me.tenants} tenant={tenant}>
      {children}
    </AppShell>
  );
}
