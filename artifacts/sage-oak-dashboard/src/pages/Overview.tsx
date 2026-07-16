import { useMemo, useState } from "react";
import {
  useGetUsageSummary,
  useGetDailyUsage,
  useGetUsageByApp,
  useGetUsageMix,
  useGetUsageBySchool,
  useGetAppEngagement,
  useGetAdditionalResources,
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
import { useAuth } from "@/components/auth/AuthProvider";
import { useLocation } from "wouter";
import { DailyUsageChart } from "@/components/charts/DailyUsageChart";
import { TopAppsChart } from "@/components/charts/TopAppsChart";
import { MixDonut } from "@/components/charts/MixDonut";
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

  const [appMetric, setAppMetric] = useState<"uniqueUsers" | "adoptionPct">("uniqueUsers");
  const [engSort, setEngSort] = useState<EngagementSort>("studentPercent");

  const sortedEngagement = useMemo(
    () => [...(engagement ?? [])].sort((a, b) => b[engSort] - a[engSort]),
    [engagement, engSort],
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
                  <TableHead className="text-right">Unique users</TableHead>
                  <TableHead className="text-right">Rostered</TableHead>
                  <TableHead className="text-right">Adoption</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(bySchool ?? []).map((s) => (
                  <TableRow key={s.school}>
                    <TableCell className="font-medium">{s.school}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.uniqueUsers)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(s.scopedUsers)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(s.adoptionPct)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {resources && resources.length > 0 && (
              <div className="mt-6">
                <h4 className="text-sm font-medium mb-2">Additional resources</h4>
                <ul className="space-y-1">
                  {resources.map((r) => (
                    <li key={r.link} className="flex justify-between gap-2 text-sm">
                      <span className="text-muted-foreground">{r.link}</span>
                      <span className="tabular-nums whitespace-nowrap">
                        {fmt(r.uniqueUsers)} users · {fmt(r.totalAccesses)} opens
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

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
                <TableHead className="text-right">
                  <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => setEngSort("activeTimePerUserMinutes")}>
                    Active min/user <ArrowUpDown className="h-3 w-3" />
                  </button>
                </TableHead>
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
                  <TableCell className="text-right tabular-nums">{e.activeTimePerUserMinutes}</TableCell>
                </TableRow>
              ))}
              {sortedEngagement.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No engagement data in this snapshot.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
