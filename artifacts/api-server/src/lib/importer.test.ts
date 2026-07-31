import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeDb, tables, resetFakeDb } from "../test/fakeDb";

vi.mock("drizzle-orm", async () => (await import("../test/fakeDb")).drizzleOrmMock);
vi.mock("@workspace/db", async () => (await import("../test/fakeDb")).dbModuleMock);

import { classifyFile, normalizeDate, runImport } from "./importer";
import type { ImportOutcome } from "./importer";

const EXPORT_PROPS = {
  name: "ExportProperties.csv",
  content: "Property,Value\nExport_date,2026-06-30\nTime_range,Last 30 days\n",
};

function ok(result: ImportOutcome | { error: string }): ImportOutcome {
  expect(result).not.toHaveProperty("error");
  return result as ImportOutcome;
}

beforeEach(() => {
  resetFakeDb();
});

describe("classifyFile", () => {
  it("classifies all known Clever export file names", () => {
    expect(classifyFile("ExportProperties.csv")).toBe("exportProperties");
    expect(classifyFile("KeyMetrics.csv")).toBe("keyMetrics");
    expect(classifyFile("UsageByApp.csv")).toBe("usageByApp");
    expect(classifyFile("UsageBySchool.csv")).toBe("usageBySchool");
    expect(classifyFile("UsageByDevice.csv")).toBe("usageByDevice");
    expect(classifyFile("UsageByBrowser.csv")).toBe("usageByBrowser");
    expect(classifyFile("UsageByLoginMethod.csv")).toBe("usageByLoginMethod");
    expect(classifyFile("UsageByAdditionalResources.csv")).toBe("additionalResources");
    expect(classifyFile("DailyStudentUsage.csv")).toBe("dailyStudent");
    expect(classifyFile("DailyTeacherUsage.csv")).toBe("dailyTeacher");
    expect(classifyFile("AppList.csv")).toBe("appList");
    expect(classifyFile("UserCounts.csv")).toBe("userCounts");
  });

  it("tolerates prefixes, separators, and case differences", () => {
    expect(classifyFile("2026-06 export - key_metrics.CSV")).toBe("keyMetrics");
    expect(classifyFile("Usage By App (June).csv")).toBe("usageByApp");
    expect(classifyFile("daily-student-usage_v2.csv")).toBe("dailyStudent");
    expect(classifyFile("EXPORT_PROPERTIES.csv")).toBe("exportProperties");
  });

  it("returns null for unknown files", () => {
    expect(classifyFile("notes.txt")).toBeNull();
    expect(classifyFile("RandomReport.csv")).toBeNull();
  });
});

describe("normalizeDate", () => {
  it("normalizes ISO and US date formats", () => {
    expect(normalizeDate("2026-06-30")).toBe("2026-06-30");
    expect(normalizeDate("2026-6-3")).toBe("2026-06-03");
    expect(normalizeDate("6/30/2026")).toBe("2026-06-30");
    expect(normalizeDate("06-30-2026")).toBe("2026-06-30");
    expect(normalizeDate(" 2026-06-30 12:00:00 ")).toBe("2026-06-30");
  });

  it("returns null for empty or garbage values", () => {
    expect(normalizeDate(undefined)).toBeNull();
    expect(normalizeDate("")).toBeNull();
    expect(normalizeDate("not a date")).toBeNull();
  });
});

describe("runImport rejection", () => {
  it("rejects a batch without ExportProperties.csv", async () => {
    const result = await runImport(
      [{ name: "KeyMetrics.csv", content: "Metric,Value\nUnique students,100\n" }],
      1,
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("ExportProperties.csv");
    expect(fakeDb.rows(tables.importLogTable)).toHaveLength(0);
  });

  it("rejects when ExportProperties has no usable Export_date", async () => {
    const result = await runImport(
      [{ name: "ExportProperties.csv", content: "Property,Value\nSomething,else\n" }],
      1,
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Export_date");
  });
});

describe("tolerant header parsing", () => {
  it("parses key metrics with varied header case, spacing, and BOM", async () => {
    const result = ok(
      await runImport(
        [
          EXPORT_PROPS,
          {
            name: "KeyMetrics.csv",
            content:
              "\uFEFF Metric , Value \nUnique Students,\"1,234\"\nTotal Student Logins,5678\nUnique Teachers,90\nTotal Teacher Logins,321\n",
          },
        ],
        1,
      ),
    );
    expect(result.snapshotDate).toBe("2026-06-30");
    const [metrics] = fakeDb.rows(tables.usageKeyMetricsTable);
    expect(metrics).toMatchObject({
      snapshotDate: "2026-06-30",
      uniqueStudents: 1234,
      totalStudentLogins: 5678,
      uniqueTeachers: 90,
      totalTeacherLogins: 321,
      timeRange: "Last 30 days",
    });
  });

  it("parses usage-by-app with renamed columns (App Name / Users)", async () => {
    ok(
      await runImport(
        [
          EXPORT_PROPS,
          {
            name: "UsageByApp.csv",
            content: "App Name,Unique Users,Scoped Users\nIXL,120,150\nSeesaw,80,150\n",
          },
        ],
        1,
      ),
    );
    const rows = fakeDb.rows(tables.usageByAppTable);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      application: "IXL",
      uniqueUsers: 120,
      scopedUsers: 150,
      snapshotDate: "2026-06-30",
    });
  });

  it("skips blank rows and rows without a label", async () => {
    ok(
      await runImport(
        [
          EXPORT_PROPS,
          {
            name: "UsageByDevice.csv",
            content: "Device Type,Unique Users\nChromebook,200\n,50\n\niPad,30\n",
          },
        ],
        1,
      ),
    );
    const rows = fakeDb.rows(tables.usageByDeviceTable);
    expect(rows.map((r) => r.label)).toEqual(["Chromebook", "iPad"]);
  });

  it("warns and skips unrecognized files without failing the import", async () => {
    const result = ok(
      await runImport([EXPORT_PROPS, { name: "Mystery.csv", content: "a,b\n1,2\n" }], 1),
    );
    expect(result.warnings.some((w) => w.includes("Mystery.csv"))).toBe(true);
    expect(result.filesProcessed).toEqual(["ExportProperties.csv"]);
  });

  it("warns when a daily file has no usable date/user columns", async () => {
    const result = ok(
      await runImport(
        [
          EXPORT_PROPS,
          { name: "DailyStudentUsage.csv", content: "Foo,Bar\nx,y\n" },
        ],
        1,
      ),
    );
    expect(result.warnings.some((w) => w.includes("DailyStudentUsage"))).toBe(true);
    expect(fakeDb.rows(tables.usageDailyStudentTable)).toHaveLength(0);
  });

  it("stores total accesses alongside unique users for additional resources", async () => {
    await runImport(
      [
        EXPORT_PROPS,
        {
          name: "UsageByAdditionalResources.csv",
          content:
            "Resource,Unique_users,Total_accesses\nSome Link,2,9\nOther Link,1,1\n",
        },
      ],
      1,
    );
    const rows = fakeDb.rows(tables.usageAdditionalResourcesTable);
    expect(rows).toHaveLength(2);
    const someLink = rows.find((r) => r.link === "Some Link")!;
    expect(someLink.uniqueUsers).toBe(2);
    expect(someLink.totalAccesses).toBe(9);
    const otherLink = rows.find((r) => r.link === "Other Link")!;
    expect(otherLink.totalAccesses).toBe(1);
  });

  it("defaults total accesses to 0 when the column is missing", async () => {
    await runImport(
      [
        EXPORT_PROPS,
        {
          name: "UsageByAdditionalResources.csv",
          content: "Resource,Unique_users\nSome Link,2\n",
        },
      ],
      1,
    );
    const rows = fakeDb.rows(tables.usageAdditionalResourcesTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalAccesses).toBe(0);
  });
});

describe("snapshot replacement (upsert by snapshot date)", () => {
  it("re-importing the same snapshot date updates rows instead of duplicating", async () => {
    const first = ok(
      await runImport(
        [
          EXPORT_PROPS,
          {
            name: "UsageByApp.csv",
            content: "Application,Unique Users,Scoped Users\nIXL,120,150\n",
          },
        ],
        1,
      ),
    );
    expect(first.rowsInserted).toBeGreaterThan(0);

    const second = ok(
      await runImport(
        [
          EXPORT_PROPS,
          {
            name: "UsageByApp.csv",
            content: "Application,Unique Users,Scoped Users\nIXL,125,150\nSeesaw,60,150\n",
          },
        ],
        1,
      ),
    );
    const rows = fakeDb.rows(tables.usageByAppTable);
    expect(rows).toHaveLength(2);
    const ixl = rows.find((r) => r.application === "IXL")!;
    expect(ixl.uniqueUsers).toBe(125);
    expect(second.rowsUpdated).toBeGreaterThan(0);
  });

  it("keeps rows from a different snapshot date (never-delete history)", async () => {
    await runImport(
      [
        EXPORT_PROPS,
        {
          name: "UsageByApp.csv",
          content: "Application,Unique Users,Scoped Users\nIXL,120,150\n",
        },
      ],
      1,
    );
    await runImport(
      [
        {
          name: "ExportProperties.csv",
          content: "Property,Value\nExport_date,2026-07-31\n",
        },
        {
          name: "UsageByApp.csv",
          content: "Application,Unique Users,Scoped Users\nIXL,140,160\n",
        },
      ],
      1,
    );
    const rows = fakeDb.rows(tables.usageByAppTable);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.snapshotDate).sort()).toEqual(["2026-06-30", "2026-07-31"]);
  });
});

describe("daily usage upsert-by-date corrections", () => {
  const daily = (content: string) => [
    EXPORT_PROPS,
    { name: "DailyStudentUsage.csv", content },
  ];

  it("inserts new dates and normalizes date formats", async () => {
    const result = ok(
      await runImport(daily("Date,Active Users\n6/1/2026,100\n2026-06-02,110\n"), 1),
    );
    const rows = fakeDb.rows(tables.usageDailyStudentTable);
    expect(rows.map((r) => r.date)).toEqual(["2026-06-01", "2026-06-02"]);
    expect(result.rowsInserted).toBeGreaterThanOrEqual(2);
  });

  it("corrects a changed value for an existing date and records a warning", async () => {
    await runImport(daily("Date,Active Users\n2026-06-01,100\n"), 1);
    const result = ok(await runImport(daily("Date,Active Users\n2026-06-01,105\n"), 1));
    const rows = fakeDb.rows(tables.usageDailyStudentTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.activeUsers).toBe(105);
    expect(
      result.warnings.some((w) => w.includes("2026-06-01") && w.includes("100 -> 105")),
    ).toBe(true);
  });

  it("leaves unchanged dates alone (no update, no warning)", async () => {
    await runImport(daily("Date,Active Users\n2026-06-01,100\n"), 1);
    const result = ok(await runImport(daily("Date,Active Users\n2026-06-01,100\n"), 1));
    const rows = fakeDb.rows(tables.usageDailyStudentTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.activeUsers).toBe(100);
    expect(result.warnings.filter((w) => w.includes("2026-06-01"))).toHaveLength(0);
  });
});

describe("side effects", () => {
  it("seeds new applications from usage files", async () => {
    await runImport(
      [
        EXPORT_PROPS,
        {
          name: "UsageByApp.csv",
          content: "Application,Unique Users,Scoped Users\nIXL,120,150\n",
        },
      ],
      1,
    );
    const apps = fakeDb.rows(tables.applicationsTable);
    expect(apps.map((a) => a.name)).toEqual(["IXL"]);
  });

  it("re-links orphaned RACI rows to newly created applications by name", async () => {
    fakeDb.rows(tables.raciRowsTable).push(
      { id: 1, name: " ixl ", applicationId: null },
      { id: 2, name: "Domain DNS", applicationId: null },
      { id: 3, name: "Seesaw", applicationId: 999 },
    );
    await runImport(
      [
        EXPORT_PROPS,
        {
          name: "UsageByApp.csv",
          content: "Application,Unique Users,Scoped Users\nIXL,120,150\nSeesaw,80,150\n",
        },
      ],
      1,
    );
    const apps = fakeDb.rows(tables.applicationsTable);
    const ixlApp = apps.find((a) => a.name === "IXL")!;
    const rows = fakeDb.rows(tables.raciRowsTable);
    expect(rows.find((r) => r.name === " ixl ")!.applicationId).toBe(ixlApp.id);
    expect(rows.find((r) => r.name === "Domain DNS")!.applicationId).toBeNull();
    // Already-linked rows are never re-pointed.
    expect(rows.find((r) => r.name === "Seesaw")!.applicationId).toBe(999);
  });

  it("re-links rows whose names differ only by punctuation or symbols", async () => {
    fakeDb.rows(tables.raciRowsTable).push(
      { id: 1, name: "Khan Academy ", applicationId: null },
      { id: 2, name: "See-Saw!", applicationId: null },
    );
    await runImport(
      [
        EXPORT_PROPS,
        {
          name: "UsageByApp.csv",
          content:
            "Application,Unique Users,Scoped Users\nKhan Academy®,120,150\nSeesaw,80,150\n",
        },
      ],
      1,
    );
    const apps = fakeDb.rows(tables.applicationsTable);
    const khan = apps.find((a) => a.name === "Khan Academy®")!;
    const seesaw = apps.find((a) => a.name === "Seesaw")!;
    const rows = fakeDb.rows(tables.raciRowsTable);
    expect(rows.find((r) => r.id === 1)!.applicationId).toBe(khan.id);
    expect(rows.find((r) => r.id === 2)!.applicationId).toBe(seesaw.id);
  });

  it("does not fuzzy-link when two new apps collide on the normalized name", async () => {
    fakeDb.rows(tables.raciRowsTable).push({ id: 1, name: "see saw", applicationId: null });
    const result = ok(
      await runImport(
        [
          EXPORT_PROPS,
          {
            name: "UsageByApp.csv",
            content:
              "Application,Unique Users,Scoped Users\nSee-Saw,120,150\nSeesaw,80,150\n",
          },
        ],
        1,
      ),
    );
    const rows = fakeDb.rows(tables.raciRowsTable);
    expect(rows.find((r) => r.id === 1)!.applicationId).toBeNull();
    expect(result.warnings.some((w) => w.includes('"see saw"'))).toBe(true);
  });

  it("warns about unlinked rows without assignments when the import added new apps", async () => {
    fakeDb.rows(tables.raciRowsTable).push({
      id: 1,
      name: "Totally Different Name",
      applicationId: null,
    });
    const result = ok(
      await runImport(
        [
          EXPORT_PROPS,
          {
            name: "UsageByApp.csv",
            content: "Application,Unique Users,Scoped Users\nIXL,120,150\n",
          },
        ],
        1,
      ),
    );
    const warning = result.warnings.find((w) => w.includes("could not be matched"));
    expect(warning).toBeDefined();
    expect(warning).toContain('"Totally Different Name"');
  });

  it("warns about RACI rows with assignments but no linked application", async () => {
    fakeDb.rows(tables.raciRowsTable).push(
      { id: 1, name: "Old App Name", applicationId: null },
      { id: 2, name: "Unassigned Row", applicationId: null },
      { id: 3, name: "Linked Row", applicationId: 5 },
    );
    fakeDb.rows(tables.raciAssignmentsTable).push(
      { id: 1, rowId: 1, memberId: 1, value: "A" },
      { id: 2, rowId: 3, memberId: 1, value: "R" },
    );
    const result = ok(await runImport([EXPORT_PROPS], 1));
    const warning = result.warnings.find((w) => w.includes("RACI"));
    expect(warning).toBeDefined();
    expect(warning).toContain('"Old App Name"');
    expect(warning).not.toContain('"Unassigned Row"');
    expect(warning).not.toContain('"Linked Row"');
  });

  it("does not warn when an import re-links the only orphaned RACI row", async () => {
    fakeDb.rows(tables.raciRowsTable).push({ id: 1, name: "IXL", applicationId: null });
    fakeDb.rows(tables.raciAssignmentsTable).push({
      id: 1,
      rowId: 1,
      memberId: 1,
      value: "A",
    });
    const result = ok(
      await runImport(
        [
          EXPORT_PROPS,
          {
            name: "UsageByApp.csv",
            content: "Application,Unique Users,Scoped Users\nIXL,120,150\n",
          },
        ],
        1,
      ),
    );
    expect(result.warnings.find((w) => w.includes("RACI"))).toBeUndefined();
  });

  it("does not warn about orphaned rows that have no assignments", async () => {
    fakeDb.rows(tables.raciRowsTable).push({ id: 1, name: "No People", applicationId: null });
    const result = ok(await runImport([EXPORT_PROPS], 1));
    expect(result.warnings.find((w) => w.includes("RACI"))).toBeUndefined();
  });

  it("writes an import log entry on success", async () => {
    await runImport([EXPORT_PROPS], 7);
    const logs = fakeDb.rows(tables.importLogTable);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      uploadedBy: 7,
      snapshotDate: "2026-06-30",
      filesIncluded: ["ExportProperties.csv"],
    });
  });
});
