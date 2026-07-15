import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  date,
  doublePrecision,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const usageKeyMetricsTable = pgTable("usage_key_metrics", {
  snapshotDate: date("snapshot_date", { mode: "string" }).primaryKey(),
  timeRange: text("time_range"),
  uniqueStudents: integer("unique_students"),
  scopedStudents: integer("scoped_students"),
  totalStudentLogins: integer("total_student_logins"),
  uniqueTeachers: integer("unique_teachers"),
  scopedTeachers: integer("scoped_teachers"),
  totalTeacherLogins: integer("total_teacher_logins"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usageByAppTable = pgTable(
  "usage_by_app",
  {
    id: serial("id").primaryKey(),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    application: text("application").notNull(),
    uniqueUsers: integer("unique_users").notNull().default(0),
    scopedUsers: integer("scoped_users").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_by_app_idx").on(t.snapshotDate, t.application)],
);

export const usageBySchoolTable = pgTable(
  "usage_by_school",
  {
    id: serial("id").primaryKey(),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    school: text("school").notNull(),
    uniqueUsers: integer("unique_users").notNull().default(0),
    scopedUsers: integer("scoped_users").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_by_school_idx").on(t.snapshotDate, t.school)],
);

export const usageByDeviceTable = pgTable(
  "usage_by_device",
  {
    id: serial("id").primaryKey(),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    label: text("label").notNull(),
    uniqueUsers: integer("unique_users").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_by_device_idx").on(t.snapshotDate, t.label)],
);

export const usageByBrowserTable = pgTable(
  "usage_by_browser",
  {
    id: serial("id").primaryKey(),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    label: text("label").notNull(),
    uniqueUsers: integer("unique_users").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_by_browser_idx").on(t.snapshotDate, t.label)],
);

export const usageByLoginMethodTable = pgTable(
  "usage_by_login_method",
  {
    id: serial("id").primaryKey(),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    label: text("label").notNull(),
    uniqueUsers: integer("unique_users").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_by_login_method_idx").on(t.snapshotDate, t.label)],
);

export const usageAdditionalResourcesTable = pgTable(
  "usage_additional_resources",
  {
    id: serial("id").primaryKey(),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    link: text("link").notNull(),
    uniqueUsers: integer("unique_users").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_additional_resources_idx").on(t.snapshotDate, t.link)],
);

export const usageAppListTable = pgTable(
  "usage_applist",
  {
    id: serial("id").primaryKey(),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    appName: text("app_name").notNull(),
    studentCount: integer("student_count").notNull().default(0),
    studentPercent: doublePrecision("student_percent").notNull().default(0),
    teacherCount: integer("teacher_count").notNull().default(0),
    teacherPercent: doublePrecision("teacher_percent").notNull().default(0),
    activeTimePerUserMinutes: doublePrecision("active_time_per_user_minutes")
      .notNull()
      .default(0),
  },
  (t) => [uniqueIndex("usage_applist_idx").on(t.snapshotDate, t.appName)],
);

export const usageDailyStudentTable = pgTable("usage_daily_student", {
  date: date("date", { mode: "string" }).primaryKey(),
  activeUsers: integer("active_users").notNull().default(0),
});

export const usageDailyTeacherTable = pgTable("usage_daily_teacher", {
  date: date("date", { mode: "string" }).primaryKey(),
  activeUsers: integer("active_users").notNull().default(0),
});

export const importLogTable = pgTable("import_log", {
  id: serial("id").primaryKey(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  uploadedBy: integer("uploaded_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
  filesIncluded: text("files_included").array().notNull(),
  rowsInserted: integer("rows_inserted").notNull().default(0),
  rowsUpdated: integer("rows_updated").notNull().default(0),
});

export type UsageKeyMetrics = typeof usageKeyMetricsTable.$inferSelect;
export type ImportLogEntry = typeof importLogTable.$inferSelect;
