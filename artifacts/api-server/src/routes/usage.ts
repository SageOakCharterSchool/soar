import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  usageKeyMetricsTable,
  usageByAppTable,
  usageBySchoolTable,
  usageByDeviceTable,
  usageByBrowserTable,
  usageByLoginMethodTable,
  usageAdditionalResourcesTable,
  usageAppListTable,
  usageDailyStudentTable,
  usageDailyTeacherTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

async function latestSnapshotDate(): Promise<string | null> {
  const candidates: string[] = [];
  const [m] = await db
    .select({ d: usageKeyMetricsTable.snapshotDate })
    .from(usageKeyMetricsTable)
    .orderBy(desc(usageKeyMetricsTable.snapshotDate))
    .limit(1);
  if (m) candidates.push(m.d);
  const [a] = await db
    .select({ d: usageByAppTable.snapshotDate })
    .from(usageByAppTable)
    .orderBy(desc(usageByAppTable.snapshotDate))
    .limit(1);
  if (a) candidates.push(a.d);
  if (candidates.length === 0) return null;
  return candidates.sort().at(-1) ?? null;
}

function pct(n: number, d: number): number {
  if (!d) return 0;
  return Math.round((n / d) * 1000) / 10;
}

router.get("/usage/summary", requireAuth, async (_req, res): Promise<void> => {
  const [metrics] = await db
    .select()
    .from(usageKeyMetricsTable)
    .orderBy(desc(usageKeyMetricsTable.snapshotDate))
    .limit(1);
  if (!metrics) {
    res.json({ hasData: false });
    return;
  }
  res.json({
    hasData: true,
    snapshotDate: metrics.snapshotDate,
    timeRange: metrics.timeRange,
    uniqueStudents: metrics.uniqueStudents,
    scopedStudents: metrics.scopedStudents,
    totalStudentLogins: metrics.totalStudentLogins,
    uniqueTeachers: metrics.uniqueTeachers,
    scopedTeachers: metrics.scopedTeachers,
    totalTeacherLogins: metrics.totalTeacherLogins,
    studentAdoptionPct:
      metrics.uniqueStudents != null && metrics.scopedStudents
        ? pct(metrics.uniqueStudents, metrics.scopedStudents)
        : null,
    teacherAdoptionPct:
      metrics.uniqueTeachers != null && metrics.scopedTeachers
        ? pct(metrics.uniqueTeachers, metrics.scopedTeachers)
        : null,
  });
});

router.get("/usage/daily", requireAuth, async (req, res): Promise<void> => {
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate : null;
  const endDate = typeof req.query.endDate === "string" ? req.query.endDate : null;

  const studentFilters = [];
  const teacherFilters = [];
  if (startDate) {
    studentFilters.push(gte(usageDailyStudentTable.date, startDate));
    teacherFilters.push(gte(usageDailyTeacherTable.date, startDate));
  }
  if (endDate) {
    studentFilters.push(lte(usageDailyStudentTable.date, endDate));
    teacherFilters.push(lte(usageDailyTeacherTable.date, endDate));
  }

  const students = await db
    .select()
    .from(usageDailyStudentTable)
    .where(studentFilters.length ? and(...studentFilters) : undefined)
    .orderBy(asc(usageDailyStudentTable.date));
  const teachers = await db
    .select()
    .from(usageDailyTeacherTable)
    .where(teacherFilters.length ? and(...teacherFilters) : undefined)
    .orderBy(asc(usageDailyTeacherTable.date));

  const merged = new Map<string, { date: string; studentUsers: number | null; teacherUsers: number | null }>();
  for (const s of students) {
    merged.set(s.date, { date: s.date, studentUsers: s.activeUsers, teacherUsers: null });
  }
  for (const t of teachers) {
    const row = merged.get(t.date);
    if (row) row.teacherUsers = t.activeUsers;
    else merged.set(t.date, { date: t.date, studentUsers: null, teacherUsers: t.activeUsers });
  }
  res.json([...merged.values()].sort((a, b) => a.date.localeCompare(b.date)));
});

router.get("/usage/by-app", requireAuth, async (_req, res): Promise<void> => {
  const snapshot = await latestSnapshotDate();
  if (!snapshot) {
    res.json([]);
    return;
  }
  const rows = await db
    .select()
    .from(usageByAppTable)
    .where(eq(usageByAppTable.snapshotDate, snapshot))
    .orderBy(desc(usageByAppTable.uniqueUsers));
  res.json(
    rows.map((r) => ({
      application: r.application,
      uniqueUsers: r.uniqueUsers,
      scopedUsers: r.scopedUsers,
      adoptionPct: pct(r.uniqueUsers, r.scopedUsers),
    })),
  );
});

router.get("/usage/by-school", requireAuth, async (_req, res): Promise<void> => {
  const snapshot = await latestSnapshotDate();
  if (!snapshot) {
    res.json([]);
    return;
  }
  const rows = await db
    .select()
    .from(usageBySchoolTable)
    .where(eq(usageBySchoolTable.snapshotDate, snapshot))
    .orderBy(desc(usageBySchoolTable.uniqueUsers));
  res.json(
    rows.map((r) => ({
      school: r.school,
      uniqueUsers: r.uniqueUsers,
      scopedUsers: r.scopedUsers,
      adoptionPct: pct(r.uniqueUsers, r.scopedUsers),
    })),
  );
});

router.get("/usage/mix", requireAuth, async (_req, res): Promise<void> => {
  const snapshot = await latestSnapshotDate();
  if (!snapshot) {
    res.json({ devices: [], browsers: [], loginMethods: [] });
    return;
  }
  const [devices, browsers, loginMethods] = await Promise.all([
    db
      .select()
      .from(usageByDeviceTable)
      .where(eq(usageByDeviceTable.snapshotDate, snapshot))
      .orderBy(desc(usageByDeviceTable.uniqueUsers)),
    db
      .select()
      .from(usageByBrowserTable)
      .where(eq(usageByBrowserTable.snapshotDate, snapshot))
      .orderBy(desc(usageByBrowserTable.uniqueUsers)),
    db
      .select()
      .from(usageByLoginMethodTable)
      .where(eq(usageByLoginMethodTable.snapshotDate, snapshot))
      .orderBy(desc(usageByLoginMethodTable.uniqueUsers)),
  ]);
  const slim = (rows: Array<{ label: string; uniqueUsers: number }>) =>
    rows.map((r) => ({ label: r.label, uniqueUsers: r.uniqueUsers }));
  res.json({
    devices: slim(devices),
    browsers: slim(browsers),
    loginMethods: slim(loginMethods),
  });
});

router.get("/usage/applist", requireAuth, async (_req, res): Promise<void> => {
  const snapshot = await latestSnapshotDate();
  if (!snapshot) {
    res.json([]);
    return;
  }
  const rows = await db
    .select()
    .from(usageAppListTable)
    .where(eq(usageAppListTable.snapshotDate, snapshot))
    .orderBy(desc(usageAppListTable.studentCount));
  res.json(
    rows.map((r) => ({
      appName: r.appName,
      studentCount: r.studentCount,
      studentPercent: r.studentPercent,
      teacherCount: r.teacherCount,
      teacherPercent: r.teacherPercent,
      activeTimePerUserMinutes: r.activeTimePerUserMinutes,
    })),
  );
});

router.get("/usage/additional-resources", requireAuth, async (_req, res): Promise<void> => {
  const snapshot = await latestSnapshotDate();
  if (!snapshot) {
    res.json([]);
    return;
  }
  const rows = await db
    .select()
    .from(usageAdditionalResourcesTable)
    .where(eq(usageAdditionalResourcesTable.snapshotDate, snapshot))
    .orderBy(desc(usageAdditionalResourcesTable.uniqueUsers));
  res.json(
    rows.map((r) => ({ link: r.link, uniqueUsers: r.uniqueUsers, totalAccesses: r.totalAccesses })),
  );
});

export default router;
