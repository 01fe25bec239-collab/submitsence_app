import { AlertTriangle, CalendarClock, ClipboardList, Package } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import type { DashboardResponse, ProjectSummary } from "@/lib/api/types";
import { ErrorState } from "@/components/error-state";
import { StatusBadge } from "@/components/status-badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  PACKAGE_STATUS,
  PROJECT_STATUS,
  SUBMITTAL_STATUS,
  TRADE_PACKAGE,
} from "@/lib/compliance/copy";

export default async function ProjectDashboardPage({
  params,
}: {
  params: Promise<{ tenantId: string; projectId: string }>;
}) {
  const { tenantId, projectId } = await params;
  const base = `/tenants/${tenantId}/projects/${projectId}`;

  let project: ProjectSummary;
  let dashboard: DashboardResponse;
  try {
    [project, dashboard] = await Promise.all([
      apiFetch<ProjectSummary>(base),
      apiFetch<DashboardResponse>(`${base}/dashboard/status`),
    ]);
  } catch (error) {
    return <ErrorState error={error} />;
  }

  const registerTotal = dashboard.status.reduce((n, s) => n + s.count, 0);
  const upcoming = dashboard.due.reduce((n, d) => n + d.count, 0);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.name}
          </h1>
          <StatusBadge map={PROJECT_STATUS} value={project.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {[project.clientName, TRADE_PACKAGE[project.trade] ?? project.trade]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ClipboardList className="size-4 text-muted-foreground" />
              Submittal register
            </CardTitle>
            <CardDescription>{registerTotal} items tracked</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {registerTotal === 0 ? (
              <p className="text-sm text-muted-foreground">
                No register items yet — upload a spec to extract requirements.
              </p>
            ) : (
              dashboard.status.map((s) => (
                <span key={s.status} className="inline-flex items-center gap-1.5">
                  <StatusBadge map={SUBMITTAL_STATUS} value={s.status} />
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {s.count}
                  </span>
                </span>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarClock className="size-4 text-muted-foreground" />
              Deadlines
            </CardTitle>
            <CardDescription>Open items with a due date</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {dashboard.overdueCount}
              </span>
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                {dashboard.overdueCount > 0 ? (
                  <AlertTriangle className="size-3.5 text-[var(--color-warning)]" />
                ) : null}
                overdue
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {upcoming} upcoming
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="size-4 text-muted-foreground" />
              Packages
            </CardTitle>
            <CardDescription>
              {dashboard.packages.length} assembled
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {dashboard.packages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No packages assembled yet.
              </p>
            ) : (
              dashboard.packages.map((pkg) => (
                <StatusBadge
                  key={pkg.id}
                  map={PACKAGE_STATUS}
                  value={pkg.status}
                />
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
