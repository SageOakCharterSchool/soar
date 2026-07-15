import { describe, it, expect, beforeEach, vi } from "vitest";

type Cond =
  | { type: "eq"; col: { name: string }; val: unknown }
  | { type: "and"; conds: Cond[] };

const { fakeDb, tables, state } = vi.hoisted(() => {
  type HCond =
    | { type: "eq"; col: { name: string }; val: unknown }
    | { type: "and"; conds: HCond[] };

  function matches(row: Record<string, unknown>, cond: HCond | undefined): boolean {
    if (!cond) return true;
    if (cond.type === "eq") return row[cond.col.name] === cond.val;
    return cond.conds.every((c) => matches(row, c));
  }

  function makeTable(label: string) {
    return new Proxy(
      { __label: label },
      {
        get(_target, prop: string) {
          if (prop === "__label") return label;
          return { name: prop, table: label };
        },
      },
    );
  }

  const state = { idCounter: 0 };

  class FakeDb {
    store = new Map<object, Record<string, unknown>[]>();

    rows(table: object): Record<string, unknown>[] {
      if (!this.store.has(table)) this.store.set(table, []);
      return this.store.get(table)!;
    }

    select() {
      const self = this;
      return {
        from(table: object) {
          const all = self.rows(table);
          return {
            where(cond: HCond) {
              return Promise.resolve(all.filter((r) => matches(r, cond)));
            },
            then(
              resolve: (rows: Record<string, unknown>[]) => void,
              reject?: (e: unknown) => void,
            ) {
              return Promise.resolve([...all]).then(resolve, reject);
            },
          };
        },
      };
    }

    insert(table: object) {
      const self = this;
      return {
        values: async (vals: Record<string, unknown> | Record<string, unknown>[]) => {
          const list = Array.isArray(vals) ? vals : [vals];
          for (const v of list) {
            self.rows(table).push({ id: ++state.idCounter, ...v });
          }
        },
      };
    }

    update(table: object) {
      const self = this;
      return {
        set: (vals: Record<string, unknown>) => ({
          where: async (cond: HCond) => {
            for (const row of self.rows(table)) {
              if (matches(row, cond)) Object.assign(row, vals);
            }
          },
        }),
      };
    }
  }

  const fakeDb = new FakeDb();

  const tables = {
    applicationsTable: makeTable("applications"),
    appTermStatusTable: makeTable("appTermStatus"),
    termsTable: makeTable("terms"),
    usageKeyMetricsTable: makeTable("usageKeyMetrics"),
    usageByAppTable: makeTable("usageByApp"),
    usageBySchoolTable: makeTable("usageBySchool"),
    usageByDeviceTable: makeTable("usageByDevice"),
    usageByBrowserTable: makeTable("usageByBrowser"),
    usageByLoginMethodTable: makeTable("usageByLoginMethod"),
    usageAdditionalResourcesTable: makeTable("usageAdditionalResources"),
    usageAppListTable: makeTable("usageAppList"),
    usageDailyStudentTable: makeTable("usageDailyStudent"),
    usageDailyTeacherTable: makeTable("usageDailyTeacher"),
    importLogTable: makeTable("importLog"),
  };

  return { fakeDb, tables, state };
});

vi.mock("drizzle-orm", () => ({
  eq: (col: { name: string }, val: unknown): Cond => ({ type: "eq", col, val }),
  and: (...conds: Cond[]): Cond => ({ type: "and", conds }),
}));

vi.mock("@workspace/db", () => ({
  db: fakeDb,
  ...tables,
}));

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
  fakeDb.store.clear();
  state.idCounter = 0;
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
