import Papa from "papaparse";
import { and, eq } from "drizzle-orm";
import {
  db,
  applicationsTable,
  appTermStatusTable,
  termsTable,
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
  importLogTable,
  appActivityTable,
} from "@workspace/db";

export interface UploadedFile {
  name: string;
  content: string;
}

export interface ImportOutcome {
  snapshotDate: string;
  filesProcessed: string[];
  rowsInserted: number;
  rowsUpdated: number;
  warnings: string[];
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type Row = Record<string, string>;

function parseCsv(content: string): { rows: Row[]; headers: string[] } {
  const result = Papa.parse<Record<string, string>>(content.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const headers = result.meta.fields ?? [];
  const rows = result.data.map((raw) => {
    const row: Row = {};
    for (const [k, v] of Object.entries(raw)) {
      row[normalizeKey(k)] = typeof v === "string" ? v.trim() : "";
    }
    return row;
  });
  return { rows, headers };
}

function pick(row: Row, candidates: string[]): string | undefined {
  for (const c of candidates) {
    const v = row[c];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function findHeader(headers: string[], candidates: string[]): string | undefined {
  const normalized = headers.map(normalizeKey);
  for (const c of candidates) {
    const idx = normalized.findIndex((h) => h === c || h.includes(c));
    if (idx >= 0) return normalized[idx];
  }
  return undefined;
}

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value.replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toFloat(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value.replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function normalizeDate(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  let m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  }
  m = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) {
    return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  const d = new Date(trimmed);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return null;
}

const FILE_KINDS: Record<string, string> = {
  exportproperties: "exportProperties",
  keymetrics: "keyMetrics",
  usagebyapp: "usageByApp",
  usagebyschool: "usageBySchool",
  usagebydevice: "usageByDevice",
  usagebybrowser: "usageByBrowser",
  usagebyloginmethod: "usageByLoginMethod",
  usagebyadditionalresources: "additionalResources",
  dailystudentusage: "dailyStudent",
  dailyteacherusage: "dailyTeacher",
  applist: "appList",
  usercounts: "userCounts",
};

export function classifyFile(name: string): string | null {
  const norm = normalizeKey(name.replace(/\.csv$/i, ""));
  for (const [key, kind] of Object.entries(FILE_KINDS)) {
    if (norm.includes(key)) return kind;
  }
  return null;
}

interface Counter {
  inserted: number;
  updated: number;
}

async function upsertSnapshotRows<T extends { snapshotDate: string }>(
  table:
    | typeof usageByAppTable
    | typeof usageBySchoolTable
    | typeof usageByDeviceTable
    | typeof usageByBrowserTable
    | typeof usageByLoginMethodTable
    | typeof usageAdditionalResourcesTable
    | typeof usageAppListTable,
  keyColumn: string,
  snapshotDate: string,
  rows: Array<Record<string, unknown> & T>,
  counter: Counter,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = table as any;
  const existing = await db.select().from(t).where(eq(t.snapshotDate, snapshotDate));
  const existingKeys = new Set(existing.map((r: Record<string, unknown>) => String(r[keyColumn])));
  for (const row of rows) {
    const key = String((row as Record<string, unknown>)[keyColumn]);
    if (existingKeys.has(key)) {
      const { snapshotDate: _sd, ...rest } = row as Record<string, unknown>;
      delete rest[keyColumn];
      await db
        .update(t)
        .set(rest)
        .where(and(eq(t.snapshotDate, snapshotDate), eq(t[keyColumn], key)));
      counter.updated += 1;
    } else {
      await db.insert(t).values(row);
      counter.inserted += 1;
    }
  }
}

async function upsertDailyRows(
  table: typeof usageDailyStudentTable | typeof usageDailyTeacherTable,
  rows: Array<{ date: string; activeUsers: number }>,
  counter: Counter,
  warnings: string[],
  label: string,
): Promise<void> {
  const existing = await db.select().from(table);
  const byDate = new Map(existing.map((r) => [r.date, r.activeUsers]));
  for (const row of rows) {
    const prev = byDate.get(row.date);
    if (prev === undefined) {
      await db.insert(table).values(row);
      counter.inserted += 1;
    } else if (prev !== row.activeUsers) {
      await db.update(table).set({ activeUsers: row.activeUsers }).where(eq(table.date, row.date));
      counter.updated += 1;
      warnings.push(
        `${label}: corrected value for ${row.date} (${prev} -> ${row.activeUsers})`,
      );
    }
  }
}

export async function runImport(
  files: UploadedFile[],
  uploadedBy: number,
): Promise<ImportOutcome | { error: string }> {
  const byKind = new Map<string, UploadedFile>();
  const unrecognized: string[] = [];
  for (const f of files) {
    const kind = classifyFile(f.name);
    if (kind) byKind.set(kind, f);
    else unrecognized.push(f.name);
  }

  const exportProps = byKind.get("exportProperties");
  if (!exportProps) {
    return {
      error:
        "ExportProperties.csv is required in every upload batch — it provides the Export_date that keys the snapshot. Please include it and re-upload.",
    };
  }

  const warnings: string[] = [];
  if (unrecognized.length > 0) {
    warnings.push(`Unrecognized files skipped: ${unrecognized.join(", ")}`);
  }

  const propsParsed = parseCsv(exportProps.content);
  let snapshotDate: string | null = null;
  let timeRange: string | null = null;
  for (const row of propsParsed.rows) {
    const prop = pick(row, ["property", "name", "key"]);
    const value = pick(row, ["value"]);
    if (prop && value) {
      const p = normalizeKey(prop);
      if (p.includes("exportdate") || p.includes("date")) snapshotDate = normalizeDate(value);
      if (p.includes("timerange") || p.includes("range")) timeRange = value;
    }
  }
  if (!snapshotDate) {
    for (const row of propsParsed.rows) {
      snapshotDate =
        normalizeDate(pick(row, ["exportdate", "date", "exporteddate"])) ?? snapshotDate;
      timeRange = pick(row, ["timerange", "range"]) ?? timeRange;
    }
  }
  if (!snapshotDate) {
    return {
      error:
        "Could not find an Export_date value in ExportProperties.csv. Expected a column or property named Export_date with a date value.",
    };
  }

  const counter: Counter = { inserted: 0, updated: 0 };
  const filesProcessed: string[] = [exportProps.name];

  // --- Key metrics (KeyMetrics.csv + usercounts) ---
  const metrics: Record<string, number | null> = {};
  const keyMetricsFile = byKind.get("keyMetrics");
  if (keyMetricsFile) {
    const { rows } = parseCsv(keyMetricsFile.content);
    const kv = new Map<string, string>();
    for (const row of rows) {
      const metric = pick(row, ["metric", "name", "key"]);
      const value = pick(row, ["value", "count"]);
      if (metric && value !== undefined) kv.set(normalizeKey(metric), value);
    }
    if (kv.size > 0) {
      const get = (frag: string) => {
        for (const [k, v] of kv) if (k.includes(frag)) return v;
        return undefined;
      };
      metrics.uniqueStudents = toInt(get("uniquestudent"));
      metrics.totalStudentLogins = toInt(get("studentlogin") ?? get("totalstudent"));
      metrics.uniqueTeachers = toInt(get("uniqueteacher"));
      metrics.totalTeacherLogins = toInt(get("teacherlogin") ?? get("totalteacher"));
      metrics.scopedStudents = toInt(get("scopedstudent"));
      metrics.scopedTeachers = toInt(get("scopedteacher"));
    } else if (rows.length > 0) {
      const row = rows[0]!;
      metrics.uniqueStudents = toInt(pick(row, ["uniquestudents", "uniquestudent"]));
      metrics.totalStudentLogins = toInt(pick(row, ["totalstudentlogins", "studentlogins"]));
      metrics.uniqueTeachers = toInt(pick(row, ["uniqueteachers", "uniqueteacher"]));
      metrics.totalTeacherLogins = toInt(pick(row, ["totalteacherlogins", "teacherlogins"]));
      metrics.scopedStudents = toInt(pick(row, ["scopedstudents"]));
      metrics.scopedTeachers = toInt(pick(row, ["scopedteachers"]));
    }
    filesProcessed.push(keyMetricsFile.name);
  } else {
    warnings.push("KeyMetrics.csv not included — KPI cards keep their previous values.");
  }

  const userCountsFile = byKind.get("userCounts");
  if (userCountsFile) {
    const { rows } = parseCsv(userCountsFile.content);
    for (const row of rows) {
      const type = normalizeKey(pick(row, ["usertype", "type", "role"]) ?? "");
      const count = toInt(pick(row, ["count", "users", "totalusers", "numberofusers"]));
      if (count === null) continue;
      if (type.includes("student") && metrics.scopedStudents == null)
        metrics.scopedStudents = count;
      if ((type.includes("teacher") || type.includes("staff")) && metrics.scopedTeachers == null)
        metrics.scopedTeachers = count;
    }
    filesProcessed.push(userCountsFile.name);
  }

  const hasMetricValues = Object.values(metrics).some((v) => v != null);
  if (hasMetricValues || timeRange) {
    const [existing] = await db
      .select()
      .from(usageKeyMetricsTable)
      .where(eq(usageKeyMetricsTable.snapshotDate, snapshotDate));
    const values = { snapshotDate, timeRange, ...metrics };
    if (existing) {
      await db
        .update(usageKeyMetricsTable)
        .set({ ...metrics, timeRange, updatedAt: new Date() })
        .where(eq(usageKeyMetricsTable.snapshotDate, snapshotDate));
      counter.updated += 1;
    } else {
      await db.insert(usageKeyMetricsTable).values(values);
      counter.inserted += 1;
    }
  }

  // --- Usage by app ---
  const appNames = new Set<string>();
  const byAppFile = byKind.get("usageByApp");
  if (byAppFile) {
    const { rows } = parseCsv(byAppFile.content);
    const parsed = rows
      .map((row) => ({
        snapshotDate,
        application: pick(row, ["application", "appname", "app", "name"]) ?? "",
        uniqueUsers: toInt(pick(row, ["uniqueusers", "uniquestudents", "users"])) ?? 0,
        scopedUsers: toInt(pick(row, ["scopedusers", "totalusers", "scoped"])) ?? 0,
      }))
      .filter((r) => r.application !== "");
    parsed.forEach((r) => appNames.add(r.application));
    await upsertSnapshotRows(usageByAppTable, "application", snapshotDate, parsed, counter);
    filesProcessed.push(byAppFile.name);
  }

  // --- Usage by school ---
  const bySchoolFile = byKind.get("usageBySchool");
  if (bySchoolFile) {
    const { rows } = parseCsv(bySchoolFile.content);
    const parsed = rows
      .map((row) => ({
        snapshotDate,
        school: pick(row, ["school", "schoolname", "name"]) ?? "",
        uniqueUsers: toInt(pick(row, ["uniqueusers", "users"])) ?? 0,
        scopedUsers: toInt(pick(row, ["scopedusers", "totalusers"])) ?? 0,
      }))
      .filter((r) => r.school !== "");
    await upsertSnapshotRows(usageBySchoolTable, "school", snapshotDate, parsed, counter);
    filesProcessed.push(bySchoolFile.name);
  }

  // --- Mix tables ---
  const mixSpecs: Array<{
    kind: string;
    table:
      | typeof usageByDeviceTable
      | typeof usageByBrowserTable
      | typeof usageByLoginMethodTable;
    labelCandidates: string[];
  }> = [
    { kind: "usageByDevice", table: usageByDeviceTable, labelCandidates: ["devicetype", "device", "label", "name"] },
    { kind: "usageByBrowser", table: usageByBrowserTable, labelCandidates: ["browser", "label", "name"] },
    { kind: "usageByLoginMethod", table: usageByLoginMethodTable, labelCandidates: ["loginmethod", "method", "label", "name"] },
  ];
  for (const spec of mixSpecs) {
    const file = byKind.get(spec.kind);
    if (!file) continue;
    const { rows } = parseCsv(file.content);
    const parsed = rows
      .map((row) => ({
        snapshotDate,
        label: pick(row, spec.labelCandidates) ?? "",
        uniqueUsers: toInt(pick(row, ["uniqueusers", "users", "count"])) ?? 0,
      }))
      .filter((r) => r.label !== "");
    await upsertSnapshotRows(spec.table, "label", snapshotDate, parsed, counter);
    filesProcessed.push(file.name);
  }

  // --- Additional resources ---
  const resourcesFile = byKind.get("additionalResources");
  if (resourcesFile) {
    const { rows } = parseCsv(resourcesFile.content);
    const parsed = rows
      .map((row) => ({
        snapshotDate,
        link: pick(row, ["link", "resource", "url", "name"]) ?? "",
        uniqueUsers: toInt(pick(row, ["uniqueusers", "users", "count"])) ?? 0,
      }))
      .filter((r) => r.link !== "");
    await upsertSnapshotRows(
      usageAdditionalResourcesTable,
      "link",
      snapshotDate,
      parsed,
      counter,
    );
    filesProcessed.push(resourcesFile.name);
  }

  // --- App list (engagement detail) ---
  const appListFile = byKind.get("appList");
  if (appListFile) {
    const { rows } = parseCsv(appListFile.content);
    const parsed = rows
      .map((row) => ({
        snapshotDate,
        appName: pick(row, ["appname", "application", "app", "name"]) ?? "",
        studentCount: toInt(pick(row, ["studentcount", "students", "studentusers"])) ?? 0,
        studentPercent:
          toFloat(pick(row, ["studentpercent", "ofstudents", "percentstudents", "studentspercent", "pctstudents"])) ?? 0,
        teacherCount: toInt(pick(row, ["teachercount", "teachers", "teacherusers"])) ?? 0,
        teacherPercent:
          toFloat(pick(row, ["teacherpercent", "ofteachers", "percentteachers", "teacherspercent", "pctteachers"])) ?? 0,
        activeTimePerUserMinutes:
          toFloat(
            pick(row, [
              "activetimeperuserminutes",
              "activetimeperuser",
              "activetime",
              "minutesperuser",
            ]),
          ) ?? 0,
      }))
      .filter((r) => r.appName !== "");
    parsed.forEach((r) => appNames.add(r.appName));
    await upsertSnapshotRows(usageAppListTable, "appName", snapshotDate, parsed, counter);
    filesProcessed.push(appListFile.name);
  }

  // --- Daily usage ---
  const dailySpecs = [
    { kind: "dailyStudent", table: usageDailyStudentTable, label: "DailyStudentUsage" },
    { kind: "dailyTeacher", table: usageDailyTeacherTable, label: "DailyTeacherUsage" },
  ] as const;
  for (const spec of dailySpecs) {
    const file = byKind.get(spec.kind);
    if (!file) continue;
    const { rows } = parseCsv(file.content);
    const parsed: Array<{ date: string; activeUsers: number }> = [];
    for (const row of rows) {
      const date = normalizeDate(pick(row, ["date", "day"]));
      const users = toInt(
        pick(row, ["activeusers", "uniqueusers", "users", "logins", "uniquelogins", "count"]),
      );
      if (date && users !== null) parsed.push({ date, activeUsers: users });
    }
    if (parsed.length === 0 && rows.length > 0) {
      warnings.push(`${spec.label}: no usable date/user columns found; file skipped.`);
    }
    await upsertDailyRows(spec.table, parsed, counter, warnings, spec.label);
    filesProcessed.push(file.name);
  }

  // --- Seed applications + not_started status rows for the current term ---
  if (appNames.size > 0) {
    const existingApps = await db.select().from(applicationsTable);
    const known = new Set(existingApps.map((a) => a.name));
    const newNames = [...appNames].filter((n) => !known.has(n));
    let insertedApps: Array<{ id: number; name: string }> = [];
    if (newNames.length > 0) {
      insertedApps = await db
        .insert(applicationsTable)
        .values(newNames.map((name) => ({ name })))
        .returning({ id: applicationsTable.id, name: applicationsTable.name });
    }
    const [currentTerm] = await db
      .select()
      .from(termsTable)
      .where(eq(termsTable.isCurrent, true));
    if (insertedApps.length > 0) {
      await db.insert(appActivityTable).values(
        insertedApps.map((a) => ({
          applicationId: a.id,
          termId: currentTerm?.id ?? null,
          eventType: "app_added" as const,
          detail: "Added automatically from a usage upload",
          actorId: uploadedBy,
        })),
      );
    }
    if (currentTerm) {
      const allApps = await db.select().from(applicationsTable);
      const statuses = await db
        .select()
        .from(appTermStatusTable)
        .where(eq(appTermStatusTable.termId, currentTerm.id));
      const covered = new Set(statuses.map((s) => s.applicationId));
      const missing = allApps.filter((a) => !covered.has(a.id));
      if (missing.length > 0) {
        await db.insert(appTermStatusTable).values(
          missing.map((a) => ({ applicationId: a.id, termId: currentTerm.id })),
        );
      }
    }
  }

  await db.insert(importLogTable).values({
    uploadedBy,
    snapshotDate,
    filesIncluded: files.map((f) => f.name),
    rowsInserted: counter.inserted,
    rowsUpdated: counter.updated,
  });

  return {
    snapshotDate,
    filesProcessed,
    rowsInserted: counter.inserted,
    rowsUpdated: counter.updated,
    warnings,
  };
}
