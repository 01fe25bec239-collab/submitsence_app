import Link from "next/link";
import { FolderKanban, Plus } from "lucide-react";
import type { Metadata } from "next";
import { apiFetch } from "@/lib/api/client";
import type { ProjectSummary } from "@/lib/api/types";
import { getTenantSession } from "@/lib/session/session";
import { can, PERM } from "@/lib/session/permissions";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PROJECT_STATUS, TRADE_PACKAGE } from "@/lib/compliance/copy";
import { buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const tenant = await getTenantSession(tenantId);
  const canCreate = can(tenant?.permissions, PERM.projectManage);

  let projects: ProjectSummary[];
  try {
    projects = await apiFetch<ProjectSummary[]>(
      `/tenants/${tenantId}/projects`,
    );
  } catch (error) {
    return (
      <Page tenantId={tenantId} canCreate={canCreate}>
        <ErrorState error={error} />
      </Page>
    );
  }

  return (
    <Page tenantId={tenantId} canCreate={canCreate}>
      {projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create a project to upload a spec and start building its submittal register."
          action={
            canCreate ? (
              <NewProjectButton tenantId={tenantId} />
            ) : undefined
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Trade</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Submission due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <Link
                    href={`/${tenantId}/projects/${p.id}`}
                    className="font-medium text-foreground hover:underline"
                  >
                    {p.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {p.clientName ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {TRADE_PACKAGE[p.trade] ?? p.trade}
                </TableCell>
                <TableCell>
                  <StatusBadge map={PROJECT_STATUS} value={p.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(p.submissionDeadline)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Page>
  );
}

function Page({
  tenantId,
  canCreate,
  children,
}: {
  tenantId: string;
  canCreate: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Your submittal workspaces. You see the projects you can access.
          </p>
        </div>
        {canCreate ? <NewProjectButton tenantId={tenantId} /> : null}
      </div>
      {children}
    </div>
  );
}

// Gated by project.manage. Wired to the create flow when that surface lands;
// disabled for now so the permission gate is visible without a dead route.
function NewProjectButton({ tenantId }: { tenantId: string }) {
  void tenantId;
  return (
    <span
      className={cn(
        buttonVariants(),
        "cursor-not-allowed opacity-60",
      )}
      aria-disabled="true"
      title="Project creation — coming soon"
    >
      <Plus />
      New project
    </span>
  );
}
