import { describe, it, expect } from "vitest";
import { parseCleverFileName, buildSnapshotFiles } from "./cleverDailyReports";
import { classifyFile, extractSnapshotInfo } from "./importer";

const PART_STUDENTS = [
  "date,sis_id,clever_user_id,clever_school_id,school_name,active,num_logins,num_resources_accessed",
  "2026-07-15,111,u1,s1,School A,True,2,3",
  "2026-07-15,222,u2,s1,School A,False,0,0",
  "2026-07-15,333,u3,s2,School B,True,1,1",
].join("\n");

const PART_TEACHERS = [
  "date,sis_id,clever_user_id,clever_school_id,school_name,active,num_logins,num_resources_accessed",
  "2026-07-15,441,t1,s1,School A,True,4,2",
  "2026-07-15,442,t2,s2,School B,False,0,0",
].join("\n");

const RES_STUDENTS = [
  "date,sis_id,clever_user_id,clever_school_id,school_name,resource_type,resource_name,resource_id,num_access",
  "2026-07-15,111,u1,s1,School A,app,Happy Numbers,r1,1",
  "2026-07-15,111,u1,s1,School A,app,Canvas,r2,2",
  "2026-07-15,333,u3,s2,School B,app,Canvas,r2,1",
  "2026-07-15,333,u3,s2,School B,link,Some Link,r3,1",
].join("\n");

const RES_TEACHERS = [
  "date,sis_id,clever_user_id,clever_school_id,school_name,resource_type,resource_name,resource_id,num_access",
  "2026-07-15,441,t1,s1,School A,app,Canvas,r2,2",
  "2026-07-15,441,t1,s1,School A,link,Some Link,r3,1",
  "2026-07-15,441,t1,s1,School A,link,Other Link,r4,1",
].join("\n");

function build() {
  return buildSnapshotFiles("2026-07-15", [
    {
      info: { date: "2026-07-15", report: "daily-participation", role: "students" },
      content: PART_STUDENTS,
    },
    {
      info: { date: "2026-07-15", report: "daily-participation", role: "teachers" },
      content: PART_TEACHERS,
    },
    {
      info: { date: "2026-07-15", report: "resource-usage", role: "students" },
      content: RES_STUDENTS,
    },
    {
      info: { date: "2026-07-15", report: "resource-usage", role: "teachers" },
      content: RES_TEACHERS,
    },
  ]);
}

describe("parseCleverFileName", () => {
  it("recognizes Clever daily report file names", () => {
    expect(parseCleverFileName("2026-07-15-daily-participation-students.csv")).toEqual({
      date: "2026-07-15",
      report: "daily-participation",
      role: "students",
    });
    expect(parseCleverFileName("2026-07-03-resource-usage-staff.csv")).toEqual({
      date: "2026-07-03",
      report: "resource-usage",
      role: "staff",
    });
  });

  it("rejects other names", () => {
    expect(parseCleverFileName("ExportProperties.csv")).toBeNull();
    expect(parseCleverFileName("2026-07-15-something-else-students.csv")).toBeNull();
    expect(parseCleverFileName("daily-participation-students.csv")).toBeNull();
  });
});

describe("buildSnapshotFiles", () => {
  it("emits an ExportProperties file the importer can key the snapshot on", () => {
    const files = build();
    const props = files.find((f) => classifyFile(f.name) === "exportProperties");
    expect(props).toBeDefined();
    expect(extractSnapshotInfo(props!.content).snapshotDate).toBe("2026-07-15");
  });

  it("aggregates participation into key metrics and daily usage", () => {
    const files = build();
    const metrics = files.find((f) => classifyFile(f.name) === "keyMetrics")!;
    expect(metrics.content).toContain("Unique_students_active,2");
    expect(metrics.content).toContain("Total_student_logins,3");
    expect(metrics.content).toContain("Scoped_students,3");
    expect(metrics.content).toContain("Unique_teachers_active,1");
    expect(metrics.content).toContain("Scoped_teachers,2");

    const dailyStudent = files.find((f) => classifyFile(f.name) === "dailyStudent")!;
    expect(dailyStudent.content).toContain("2026-07-15,2");
    const dailyTeacher = files.find((f) => classifyFile(f.name) === "dailyTeacher")!;
    expect(dailyTeacher.content).toContain("2026-07-15,1");
  });

  it("aggregates app resource usage into UsageByApp and AppList", () => {
    const files = build();
    const byApp = files.find((f) => classifyFile(f.name) === "usageByApp")!;
    // Canvas: u1, u3, t1 = 3 unique users; Happy Numbers: u1 = 1.
    expect(byApp.content).toContain("Canvas,3,5");
    expect(byApp.content).toContain("Happy Numbers,1,5");
    // Non-app resource types are excluded.
    expect(byApp.content).not.toContain("Some Link");

    const appList = files.find((f) => classifyFile(f.name) === "appList")!;
    // Canvas: 2 of 3 students (66.7%), 1 of 2 teachers (50%).
    expect(appList.content).toContain("Canvas,2,66.7,1,50,0");
  });

  it("aggregates active users per school", () => {
    const files = build();
    const bySchool = files.find((f) => classifyFile(f.name) === "usageBySchool")!;
    // School A: u1 + t1 active of 3 scoped; School B: u3 active of 2 scoped.
    expect(bySchool.content).toContain("School A,2,3");
    expect(bySchool.content).toContain("School B,1,2");
  });

  it("aggregates non-app resources into UsageByAdditionalResources", () => {
    const files = build();
    const extras = files.find((f) => classifyFile(f.name) === "additionalResources")!;
    expect(extras).toBeDefined();
    // Some Link: u3 + t1 = 2 unique users; Other Link: t1 = 1.
    expect(extras.content).toContain("Some Link,2");
    expect(extras.content).toContain("Other Link,1");
    // App rows are excluded from the additional-resources file.
    expect(extras.content).not.toContain("Canvas");
  });

  it("tolerates missing files", () => {
    const files = buildSnapshotFiles("2026-07-15", [
      {
        info: { date: "2026-07-15", report: "daily-participation", role: "students" },
        content: PART_STUDENTS,
      },
    ]);
    expect(files.some((f) => classifyFile(f.name) === "exportProperties")).toBe(true);
    expect(files.some((f) => classifyFile(f.name) === "dailyStudent")).toBe(true);
    expect(files.some((f) => classifyFile(f.name) === "dailyTeacher")).toBe(false);
    expect(files.some((f) => classifyFile(f.name) === "usageByApp")).toBe(false);
  });
});
