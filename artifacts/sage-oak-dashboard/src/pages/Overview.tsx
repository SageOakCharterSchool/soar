import { useMemo, useState } from "react";
import {
  useGetUsageSummary,
  useGetDailyUsage,
  useGetUsageByApp,
  useGetUsageMix,
  useGetUsageBySchool,
  useGetAppEngagement,
  useGetAdditionalResources,
  useGetAdditionalResourcesHistory,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useAuth } from "@/components/auth/AuthProvider";
import { useLocation } from "wouter";
import { DailyUsageChart } from "@/components/charts/DailyUsageChart";
import { TopAppsChart } from "@/components/charts/TopAppsChart";
import { MixDonut } from "@/components/charts/MixDonut";
import { ResourceSparkline, ResourceTrendBadge } from "@/components/charts/ResourceSparkline";
import { ResourceHistoryChart } from "@/components/charts/ResourceHistoryChart";
import { ArrowUpDown, UploadCloud } from "lucide-react";

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function HiddenColumnsNote({ hiddenColumns }: { hiddenColumns: string[] }) {
  if (hiddenColumns.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground mt-2" data-testid="hidden-columns-note">
      Hidden: {hiddenColumns.join(", ")} — no data in this snapshot.
    </p>
  );
}

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString();
const pct = (n: number | null | undefined) => (n == null ? "—" : `${n}%`);

type EngagementSort = "studentPercent" | "teacherPercent" | "activeTimePerUserMinutes";

export default function Overview() {
  const { isAdmin } = useAuth();
  const [, setLocation] = useLocation();
  const { data: summary, isLoading } = useGetUsageSummary();
  const { data: daily } = useGetDailyUsage();
  const { data: byApp } = useGetUsageByApp();
  const { data: mix } = useGetUsageMix();
  const { data: bySchool } = useGetUsageBySchool();
  const { data: engagement } = useGetAppEngagement();
  const { data: resources } = useGetAdditionalResources();
  const { data: resourceHistory } = useGetAdditionalResourcesHistory();

  const historyByLink = useMemo(() => {
    const m = new Map<string, NonNullable<typeof resourceHistory>["resources"][number]["points"]>();
    for (const r of resourceHistory?.resources ?? []) m.set(r.link, r.points);
    return m;
  }, [resourceHistory]);

  // Prefer the latest snapshot's rows; if the newest snapshot has no resource
  // data (e.g. a partial import), fall back to the most recent values from the
  // usage history so trends stay visible.
  const displayResources = useMemo(() => {
    if (resources && resources.length > 0) return resources;
    return (resourceHistory?.resources ?? [])
      .map((r) => {
        const last = r.points[r.points.length - 1];
        return last
          ? { link: r.link, uniqueUsers: last.uniqueUsers, totalAccesses: last.totalAccesses }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r != null);
  }, [resources, resourceHistory]);

  const [appMetric, setAppMetric] = useState<"uniqueUsers" | "adoptionPct">("uniqueUsers");
  const [expandedResource, setExpandedResource] = useState<string | null>(null);
  const [engSort, setEngSort] = useState<EngagementSort>("studentPercent");

  const hasActiveTime = useMemo(
    () => (engagement ?? []).some((e) => e.activeTimePerUserMinutes != null),
    [engagement],
  );

  const schoolCols = useMemo(
    () => ({
      uniqueUsers: (bySchool ?? []).some((s) => s.uniqueUsers != null),
      scopedUsers: (bySchool ?? []).some((s) => s.scopedUsers != null),
      adoptionPct: (bySchool ?? []).some((s) => s.adoptionPct != null),
    }),
    [bySchool],
  );

  const resourceStats = useMemo(
    () => ({
      uniqueUsers: displayResources.some((r) => r.uniqueUsers != null),
      totalAccesses: displayResources.some((r) => r.totalAccesses != null),
    }),
    [displayResources],
  );

  const hiddenSchoolCols =
    (bySchool?.length ?? 0) > 0
      ? (
          [
            [schoolCols.uniqueUsers, "Unique users"],
            [schoolCols.scopedUsers, "Rostered"],
            [schoolCols.adoptionPct, "Adoption"],
          ] as const
        )
          .filter(([shown]) => !shown)
          .map(([, label]) => label)
      : [];

  const hiddenResourceStats =
    displayResources.length > 0
      ? (
          [
            [resourceStats.uniqueUsers, "Users"],
            [resourceStats.totalAccesses, "Opens"],
          ] as const
        )
          .filter(([shown]) => !shown)
          .map(([, label]) => label)
      : [];

  const effectiveEngSort: EngagementSort =
    engSort === "activeTimePerUserMinutes" && !hasActiveTime
      ? "studentPercent"
      : engSort;

  const sortedEngagement = useMemo(
    () =>
      [...(engagement ?? [])].sort(
        (a, b) =>
          (b[effectiveEngSort] ?? -Infinity) - (a[effectiveEngSort] ?? -Infinity),
      ),
    [engagement, effectiveEngSort],
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  if (!summary?.hasData) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center space-y-4">
        <div className="h-14 w-14 rounded-2xl bg-muted flex items-center justify-center">
          <UploadCloud className="h-7 w-7 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-semibold">No usage data yet</h2>
        <p className="text-muted-foreground max-w-md">
          Once the monthly Clever CSV exports are uploaded, usage analytics for
          Sage Oak will appear here.
        </p>
        {isAdmin && (
          <Button onClick={() => setLocation("/upload")}>Upload data</Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl font-bold tracking-tight">Usage Overview</h2>
        <div className="text-sm text-muted-foreground">
          Data as of <span className="font-medium text-foreground">{summary.snapshotDate}</span>
          {summary.timeRange ? ` · ${summary.timeRange}` : null}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard label="Unique students" value={fmt(summary.uniqueStudents)} sub={`of ${fmt(summary.scopedStudents)} rostered`} />
        <KpiCard label="Student logins" value={fmt(summary.totalStudentLogins)} />
        <KpiCard label="Student adoption" value={pct(summary.studentAdoptionPct)} />
        <KpiCard label="Unique teachers" value={fmt(summary.uniqueTeachers)} sub={`of ${fmt(summary.scopedTeachers)} rostered`} />
        <KpiCard label="Teacher logins" value={fmt(summary.totalTeacherLogins)} />
        <KpiCard label="Teacher adoption" value={pct(summary.teacherAdoptionPct)} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Daily active users</CardTitle>
        </CardHeader>
        <CardContent>
          {daily && daily.length > 0 ? (
            <DailyUsageChart data={daily} />
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">No daily usage history yet.</p>
          )}
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Top applications</CardTitle>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={appMetric === "uniqueUsers" ? "default" : "outline"}
                onClick={() => setAppMetric("uniqueUsers")}
              >
                Unique users
              </Button>
              <Button
                size="sm"
                variant={appMetric === "adoptionPct" ? "default" : "outline"}
                onClick={() => setAppMetric("adoptionPct")}
              >
                Adoption %
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {byApp && byApp.length > 0 ? (
              <TopAppsChart data={byApp} metric={appMetric} />
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center">No app usage in this snapshot.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Usage by school</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>School</TableHead>
                  {schoolCols.uniqueUsers && <TableHead className="text-right">Unique users</TableHead>}
                  {schoolCols.scopedUsers && <TableHead className="text-right">Rostered</TableHead>}
                  {schoolCols.adoptionPct && <TableHead className="text-right">Adoption</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(bySchool ?? []).map((s) => (
                  <TableRow key={s.school}>
                    <TableCell className="font-medium">{s.school}</TableCell>
                    {schoolCols.uniqueUsers && (
                      <TableCell className="text-right tabular-nums">{fmt(s.uniqueUsers)}</TableCell>
                    )}
                    {schoolCols.scopedUsers && (
                      <TableCell className="text-right tabular-nums">{fmt(s.scopedUsers)}</TableCell>
                    )}
                    {schoolCols.adoptionPct && (
                      <TableCell className="text-right tabular-nums">{pct(s.adoptionPct)}</TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <HiddenColumnsNote hiddenColumns={hiddenSchoolCols} />
            {displayResources.length > 0 && (
              <div className="mt-6">
                <h4 className="text-sm font-medium mb-2">Additional resources</h4>
                <ul className="space-y-1">
                  {displayResources.map((r) => {
                    const points = historyByLink.get(r.link) ?? [];
                    return (
                      <li key={r.link}>
                        <button
                          type="button"
                          onClick={() => setExpandedResource(r.link)}
                          className="w-full flex items-center justify-between gap-2 text-sm rounded-md px-1 py-0.5 -mx-1 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-left cursor-pointer"
                          title="Click to see full usage history"
                          data-testid={`resource-row-${r.link}`}
                        >
                          <span className="text-muted-foreground min-w-0 truncate">{r.link}</span>
                          <span className="flex items-center gap-3 shrink-0">
                            <ResourceSparkline points={points} />
                            <ResourceTrendBadge points={points} />
                            {(resourceStats.uniqueUsers || resourceStats.totalAccesses) && (
                              <span className="tabular-nums whitespace-nowrap">
                                {[
                                  resourceStats.uniqueUsers ? `${fmt(r.uniqueUsers)} users` : null,
                                  resourceStats.totalAccesses ? `${fmt(r.totalAccesses)} opens` : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {hiddenResourceStats.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-2" data-testid="hidden-resource-stats-note">
                    Hidden stats: {hiddenResourceStats.join(", ")} — no data in this snapshot.
                  </p>
                )}
                {resourceHistory && resourceHistory.snapshotDates.length > 1 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Trend of unique users across the last {resourceHistory.snapshotDates.length} snapshots
                    ({resourceHistory.snapshotDates[0]} – {resourceHistory.snapshotDates[resourceHistory.snapshotDates.length - 1]})
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={expandedResource != null}
        onOpenChange={(open) => {
          if (!open) setExpandedResource(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="break-all pr-6">{expandedResource}</DialogTitle>
            <DialogDescription>
              Usage history across snapshots — unique users and total opens.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            if (!expandedResource) return null;
            const points = historyByLink.get(expandedResource) ?? [];
            if (points.length === 0) {
              return (
                <p className="text-sm text-muted-foreground py-10 text-center">
                  No usage history recorded for this resource yet.
                </p>
              );
            }
            if (points.length === 1) {
              const p = points[0];
              return (
                <div className="py-8 text-center space-y-1">
                  <p className="text-sm text-muted-foreground">
                    Only one snapshot so far ({p.snapshotDate}) — a trend chart will appear
                    once more history is available.
                  </p>
                  <p className="text-sm tabular-nums">
                    {p.uniqueUsers.toLocaleString()} users · {p.totalAccesses.toLocaleString()} opens
                  </p>
                </div>
              );
            }
            return <ResourceHistoryChart points={points} />;
          })()}
        </DialogContent>
      </Dialog>

      <div className="grid md:grid-cols-3 gap-4">
        {[
          { title: "Devices", data: mix?.devices },
          { title: "Browsers", data: mix?.browsers },
          { title: "Login methods", data: mix?.loginMethods },
        ].map(({ title, data }) => (
          <Card key={title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              {data && data.length > 0 ? (
                <MixDonut data={data} />
              ) : (
                <p className="text-sm text-muted-foreground py-8 text-center">No data.</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">App engagement</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Application</TableHead>
                <TableHead className="text-right">Students</TableHead>
                <TableHead className="text-right">
                  <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setEngSort("studentPercent")}>
                    % of students <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
                <TableHead className="text-right">Teachers</TableHead>
                <TableHead className="text-right">
                  <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setEngSort("teacherPercent")}>
                    % of teachers <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
                {hasActiveTime && (
                  <TableHead className="text-right">
                    <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setEngSort("activeTimePerUserMinutes")}>
                      Active min/user <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedEngagement.map((e) => (
                <TableRow key={e.appName}>
                  <TableCell className="font-medium">{e.appName}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(e.studentCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(e.studentPercent)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(e.teacherCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(e.teacherPercent)}</TableCell>
                  {hasActiveTime && (
                    <TableCell className="text-right tabular-nums">{fmt(e.activeTimePerUserMinutes)}</TableCell>
                  )}
                </TableRow>
              ))}
              {sortedEngagement.length === 0 && (
                <TableRow>
                  <TableCell colSpan={hasActiveTime ? 6 : 5} className="text-center text-muted-foreground py-8">
                    No engagement data in this snapshot.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <HiddenColumnsNote
            hiddenColumns={sortedEngagement.length > 0 && !hasActiveTime ? ["Active min/user"] : []}
          />
        </CardContent>
      </Card>
    </div>
  );
}
