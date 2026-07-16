import Papa from "papaparse";
import type { UploadedFile } from "./importer";

/**
 * Adapter for Clever's real Reports SFTP layout.
 *
 * Clever publishes raw per-user daily reports rather than the aggregated
 * snapshot batches the importer expects. The layout is:
 *
 *   /daily-participation/YYYY-MM-DD-daily-participation-{students|teachers|staff}.csv
 *     columns: date, sis_id|staff_id, clever_user_id, clever_school_id,
 *              school_name, active, num_logins, num_resources_accessed
 *   /resource-usage/YYYY-MM-DD-resource-usage-{students|teachers|staff}.csv
 *     columns: date, sis_id|staff_id, clever_user_id, clever_school_id,
 *              school_name, resource_type, resource_name, resource_id, num_access
 *
 * This module recognizes those file names and aggregates one day's raw rows
 * into the snapshot CSVs the shared import pipeline already understands
 * (ExportProperties, KeyMetrics, UsageByApp, UsageBySchool, AppList,
 * DailyStudentUsage, DailyTeacherUsage), keyed by the report date.
 */

export type CleverReport = "daily-participation" | "resource-usage";
export type CleverRole = "students" | "teachers" | "staff";

export interface CleverFileInfo {
  date: string;
  report: CleverReport;
  role: CleverRole;
}

const CLEVER_NAME_RE =
  /^(\d{4}-\d{2}-\d{2})-(daily-participation|resource-usage)-(students|teachers|staff)\.csv$/i;

export function parseCleverFileName(name: string): CleverFileInfo | null {
  const m = name.match(CLEVER_NAME_RE);
  if (!m) return null;
  return {
    date: m[1]!,
    report: m[2]!.toLowerCase() as CleverReport,
    role: m[3]!.toLowerCase() as CleverRole,
  };
}

export interface CleverRawFile {
  info: CleverFileInfo;
  content: string;
}

type Row = Record<string, string>;

function parseRows(content: string): Row[] {
  const result = Papa.parse<Row>(content.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  return result.data;
}

function isActive(row: Row): boolean {
  return /^true$/i.test((row["active"] ?? "").trim());
}

function toCount(value: string | undefined): number {
  const n = Number((value ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

function pct(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

/**
 * Aggregate one day's raw Clever report files into the snapshot CSV batch
 * the import pipeline expects. Missing files are tolerated — only the
 * sections that have source data are emitted.
 */
export function buildSnapshotFiles(date: string, files: CleverRawFile[]): UploadedFile[] {
  const out: UploadedFile[] = [
    {
      name: `${date}-ExportProperties.csv`,
      content: Papa.unparse({
        fields: ["Property", "Value"],
        data: [
          ["Export_date", date],
          ["Time_range", "Daily"],
        ],
      }),
    },
  ];

  const participation = new Map<CleverRole, Row[]>();
  const resources = new Map<CleverRole, Row[]>();
  for (const f of files) {
    const target = f.info.report === "daily-participation" ? participation : resources;
    target.set(f.info.role, parseRows(f.content));
  }

  const students = participation.get("students");
  const teachers = participation.get("teachers");

  // --- Key metrics + daily active users from participation ---
  if (students || teachers) {
    const metrics: Array<[string, number]> = [];
    if (students) {
      const active = students.filter(isActive);
      metrics.push(
        ["Unique_students_active", active.length],
        ["Total_student_logins", students.reduce((s, r) => s + toCount(r["num_logins"]), 0)],
        ["Scoped_students", students.length],
      );
      out.push({
        name: `${date}-DailyStudentUsage.csv`,
        content: Papa.unparse({
          fields: ["Date", "Active_users"],
          data: [[date, String(active.length)]],
        }),
      });
    }
    if (teachers) {
      const active = teachers.filter(isActive);
      metrics.push(
        ["Unique_teachers_active", active.length],
        ["Total_teacher_logins", teachers.reduce((s, r) => s + toCount(r["num_logins"]), 0)],
        ["Scoped_teachers", teachers.length],
      );
      out.push({
        name: `${date}-DailyTeacherUsage.csv`,
        content: Papa.unparse({
          fields: ["Date", "Active_users"],
          data: [[date, String(active.length)]],
        }),
      });
    }
    out.push({
      name: `${date}-KeyMetrics.csv`,
      content: Papa.unparse({
        fields: ["Metric", "Value"],
        data: metrics.map(([m, v]) => [m, String(v)]),
      }),
    });

    // --- Usage by school (active users per school across roles) ---
    const bySchool = new Map<string, { active: Set<string>; scoped: number }>();
    for (const rows of participation.values()) {
      for (const row of rows) {
        const school = (row["school_name"] ?? "").trim();
        if (!school) continue;
        let entry = bySchool.get(school);
        if (!entry) {
          entry = { active: new Set(), scoped: 0 };
          bySchool.set(school, entry);
        }
        entry.scoped += 1;
        if (isActive(row)) entry.active.add(row["clever_user_id"] ?? "");
      }
    }
    if (bySchool.size > 0) {
      out.push({
        name: `${date}-UsageBySchool.csv`,
        content: Papa.unparse({
          fields: ["School", "Unique_users", "Scoped_users"],
          data: [...bySchool.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([school, e]) => [school, String(e.active.size), String(e.scoped)]),
        }),
      });
    }
  }

  // --- Usage by app + app list from resource usage ---
  const scopedStudents = students?.length ?? 0;
  const scopedTeachers = teachers?.length ?? 0;
  interface AppAgg {
    all: Set<string>;
    students: Set<string>;
    teachers: Set<string>;
  }
  const apps = new Map<string, AppAgg>();
  for (const [role, rows] of resources) {
    for (const row of rows) {
      if ((row["resource_type"] ?? "").trim().toLowerCase() !== "app") continue;
      const app = (row["resource_name"] ?? "").trim();
      const user = (row["clever_user_id"] ?? "").trim();
      if (!app || !user) continue;
      let agg = apps.get(app);
      if (!agg) {
        agg = { all: new Set(), students: new Set(), teachers: new Set() };
        apps.set(app, agg);
      }
      agg.all.add(user);
      if (role === "students") agg.students.add(user);
      if (role === "teachers") agg.teachers.add(user);
    }
  }
  if (apps.size > 0) {
    const sorted = [...apps.entries()].sort((a, b) => b[1].all.size - a[1].all.size);
    const scopedTotal = scopedStudents + scopedTeachers;
    out.push({
      name: `${date}-UsageByApp.csv`,
      content: Papa.unparse({
        fields: ["Application", "Unique_users", "Scoped_users"],
        data: sorted.map(([app, agg]) => [app, String(agg.all.size), String(scopedTotal)]),
      }),
    });
    out.push({
      name: `${date}-AppList.csv`,
      content: Papa.unparse({
        fields: [
          "App_name",
          "Student_count",
          "Student_percent",
          "Teacher_count",
          "Teacher_percent",
          "Active_time_per_user_minutes",
        ],
        data: sorted.map(([app, agg]) => [
          app,
          String(agg.students.size),
          String(pct(agg.students.size, scopedStudents)),
          String(agg.teachers.size),
          String(pct(agg.teachers.size, scopedTeachers)),
          "0",
        ]),
      }),
    });
  }

  // --- Additional resources (non-app resource types, e.g. links) ---
  const extras = new Map<string, { users: Set<string>; totalAccesses: number }>();
  for (const rows of resources.values()) {
    for (const row of rows) {
      const type = (row["resource_type"] ?? "").trim().toLowerCase();
      if (!type || type === "app") continue;
      const name = (row["resource_name"] ?? "").trim();
      const user = (row["clever_user_id"] ?? "").trim();
      if (!name || !user) continue;
      let entry = extras.get(name);
      if (!entry) {
        entry = { users: new Set(), totalAccesses: 0 };
        extras.set(name, entry);
      }
      entry.users.add(user);
      entry.totalAccesses += toCount(row["num_access"]);
    }
  }
  if (extras.size > 0) {
    out.push({
      name: `${date}-UsageByAdditionalResources.csv`,
      content: Papa.unparse({
        fields: ["Resource", "Unique_users", "Total_accesses"],
        data: [...extras.entries()]
          .sort((a, b) => b[1].users.size - a[1].users.size || a[0].localeCompare(b[0]))
          .map(([name, e]) => [name, String(e.users.size), String(e.totalAccesses)]),
      }),
    });
  }

  return out;
}
