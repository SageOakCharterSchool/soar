import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { Server } from "http";
import { fakeDb, tables, state, resetFakeDb } from "../test/fakeDb";

vi.mock("drizzle-orm", async () => (await import("../test/fakeDb")).drizzleOrmMock);
vi.mock("@workspace/db", async () => (await import("../test/fakeDb")).dbModuleMock);
vi.mock(
  "connect-pg-simple",
  async () => (await import("../test/fakeDb")).connectPgSimpleMock,
);

import app from "../app";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("No port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

class Client {
  private cookie: string | null = null;

  async request(method: string, path: string, body?: unknown) {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    return { status: res.status, body: (await res.json()) as any };
  }

  get(path: string) {
    return this.request("GET", path);
  }
  post(path: string, body?: unknown) {
    return this.request("POST", path, body);
  }
}

const ADMIN = { email: "admin@sageoak.org", password: "test-admin-pw" };
const STAFF = { email: "staff@sageoak.org", password: "test-staff-pw" };

let adminHash: string;
let staffHash: string;

beforeAll(async () => {
  adminHash = await bcrypt.hash(ADMIN.password, 4);
  staffHash = await bcrypt.hash(STAFF.password, 4);
});

beforeEach(() => {
  resetFakeDb();
  fakeDb.rows(tables.usersTable).push(
    {
      id: 1,
      email: ADMIN.email,
      passwordHash: adminHash,
      displayName: "Administrator",
      role: "admin",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      id: 2,
      email: STAFF.email,
      passwordHash: staffHash,
      displayName: "Staff Member",
      role: "staff",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    },
  );
  state.idCounter = 2;
});

async function loginAs(creds: { email: string; password: string }): Promise<Client> {
  const client = new Client();
  const res = await client.post("/auth/login", creds);
  expect(res.status).toBe(200);
  return client;
}

const EXPORT_PROPS = {
  name: "ExportProperties.csv",
  content: "Property,Value\nExport_date,2026-06-30\nTime_range,Last 30 days\n",
};

describe("POST /api/auth/login", () => {
  it("rejects a malformed body with 400", async () => {
    const res = await new Client().post("/auth/login", { email: "x" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("required");
  });

  it("rejects wrong password with 401 and no session cookie", async () => {
    const client = new Client();
    const res = await client.post("/auth/login", {
      email: ADMIN.email,
      password: "wrong",
    });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid email or password");
    const me = await client.get("/auth/me");
    expect(me.status).toBe(401);
  });

  it("rejects unknown email with 401", async () => {
    const res = await new Client().post("/auth/login", {
      email: "nobody@sageoak.org",
      password: "whatever",
    });
    expect(res.status).toBe(401);
  });

  it("logs in with correct credentials, case-insensitive email, no hash leak", async () => {
    const client = new Client();
    const res = await client.post("/auth/login", {
      email: ADMIN.email.toUpperCase(),
      password: ADMIN.password,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 1,
      email: ADMIN.email,
      displayName: "Administrator",
      role: "admin",
    });
    expect(res.body).not.toHaveProperty("passwordHash");
  });
});

describe("session handling (/api/auth/me, logout)", () => {
  it("returns 401 when not logged in", async () => {
    const res = await new Client().get("/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Not logged in");
  });

  it("keeps the session across requests after login", async () => {
    const client = await loginAs(STAFF);
    const me = await client.get("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: STAFF.email, role: "staff" });
  });

  it("destroys the session on logout", async () => {
    const client = await loginAs(ADMIN);
    const out = await client.post("/auth/logout");
    expect(out.status).toBe(200);
    const me = await client.get("/auth/me");
    expect(me.status).toBe(401);
  });
});

describe("POST /api/uploads", () => {
  it("requires authentication", async () => {
    const res = await new Client().post("/uploads", { files: [EXPORT_PROPS] });
    expect(res.status).toBe(401);
  });

  it("rejects non-admin staff with 403", async () => {
    const client = await loginAs(STAFF);
    const res = await client.post("/uploads", { files: [EXPORT_PROPS] });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Admin access required");
  });

  it("rejects an invalid payload with 400", async () => {
    const client = await loginAs(ADMIN);
    const res = await client.post("/uploads", { nope: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid upload payload");
  });

  it("rejects an empty file list with 400", async () => {
    const client = await loginAs(ADMIN);
    const res = await client.post("/uploads", { files: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("No files");
  });

  it("surfaces a missing ExportProperties.csv as a clean 400 message", async () => {
    const client = await loginAs(ADMIN);
    const res = await client.post("/uploads", {
      files: [{ name: "KeyMetrics.csv", content: "Metric,Value\nUnique students,10\n" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("ExportProperties.csv");
    expect(fakeDb.rows(tables.importLogTable)).toHaveLength(0);
  });

  it("imports a valid batch and records the uploading admin", async () => {
    const client = await loginAs(ADMIN);
    const res = await client.post("/uploads", {
      files: [
        EXPORT_PROPS,
        {
          name: "UsageByApp.csv",
          content: "Application,Unique Users,Scoped Users\nIXL,120,150\n",
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.snapshotDate).toBe("2026-06-30");
    expect(res.body.rowsInserted).toBeGreaterThan(0);
    const logs = fakeDb.rows(tables.importLogTable);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ uploadedBy: 1, snapshotDate: "2026-06-30" });
  });
});

describe("GET /api/uploads/log", () => {
  it("requires admin", async () => {
    expect((await new Client().get("/uploads/log")).status).toBe(401);
    const staff = await loginAs(STAFF);
    expect((await staff.get("/uploads/log")).status).toBe(403);
  });

  it("returns import history with uploader name resolved", async () => {
    const client = await loginAs(ADMIN);
    fakeDb.rows(tables.importLogTable).push({
      id: 10,
      uploadedBy: 1,
      uploadedAt: new Date("2026-07-01T10:00:00Z"),
      snapshotDate: "2026-06-30",
      filesIncluded: ["ExportProperties.csv"],
      rowsInserted: 5,
      rowsUpdated: 0,
    });
    const res = await client.get("/uploads/log");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: 10,
      uploadedByName: "Administrator",
      snapshotDate: "2026-06-30",
      uploadedAt: "2026-07-01T10:00:00.000Z",
    });
  });
});

describe("app rename and delete", () => {
  beforeEach(() => {
    fakeDb.rows(tables.applicationsTable).push(
      { id: 10, name: "VLA", category: "Custom Rostering — VLA", dayOneCritical: false },
      { id: 11, name: "Seesaw", category: null, dayOneCritical: false },
    );
    fakeDb.rows(tables.appTermStatusTable).push(
      { id: 100, applicationId: 10, termId: 1, studentSharingStatus: "not_started", staffSharingStatus: "not_started" },
    );
    fakeDb.rows(tables.appIssuesTable).push(
      { id: 200, applicationId: 10, status: "open", comment: "broken" },
    );
    fakeDb.rows(tables.appUpvotesTable).push({ id: 300, applicationId: 10, userId: 2 });
    fakeDb.rows(tables.appActivityTable).push({
      id: 400,
      applicationId: 10,
      termId: 1,
      eventType: "app_added",
      detail: "Added manually",
      actorId: 1,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    fakeDb.rows(tables.raciRowsTable).push({ id: 500, name: "VLA", applicationId: 10 });
    // Seesaw appears in imported usage data; VLA does not.
    fakeDb.rows(tables.usageByAppTable).push({
      application: "Seesaw",
      uniqueUsers: 10,
      scopedUsers: 20,
      snapshotDate: "2026-06-30",
    });
    state.idCounter = 1000;
  });

  it("requires admin", async () => {
    const staff = await loginAs(STAFF);
    expect((await staff.request("PATCH", "/apps/10", { name: "X" })).status).toBe(403);
    expect((await staff.request("DELETE", "/apps/10")).status).toBe(403);
  });

  it("renames a manually added app and logs activity", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.request("PATCH", "/apps/10", { name: "VLA Program" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applicationId: 10, name: "VLA Program" });
    expect(fakeDb.rows(tables.applicationsTable).find((a: any) => a.id === 10)?.name).toBe(
      "VLA Program",
    );
    // RACI link is by id, so it survives the rename.
    expect(fakeDb.rows(tables.raciRowsTable)[0]?.applicationId).toBe(10);
    const events = fakeDb
      .rows(tables.appActivityTable)
      .filter((e: any) => e.eventType === "app_renamed");
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toContain('"VLA" to "VLA Program"');
  });

  it("rejects renaming to an existing app name (case-insensitive)", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.request("PATCH", "/apps/10", { name: "seesaw" });
    expect(res.status).toBe(409);
  });

  it("rejects renaming apps matched by imported usage data", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.request("PATCH", "/apps/11", { name: "Seesaw Classroom" });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("usage reports");
  });

  it("404s for unknown apps", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.request("PATCH", "/apps/999", { name: "X" })).status).toBe(404);
    expect((await admin.request("DELETE", "/apps/999")).status).toBe(404);
  });

  it("returns rename and remove events from the activity feed", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.request("PATCH", "/apps/10", { name: "VLA Program" })).status).toBe(200);
    expect((await admin.request("DELETE", "/apps/11")).status).toBe(200);
    const res = await admin.get("/rostering/activity");
    expect(res.status).toBe(200);
    const byType = new Map(res.body.map((e: any) => [e.eventType, e]));
    expect(byType.has("app_renamed")).toBe(true);
    expect(byType.has("app_removed")).toBe(true);
    // Removed-app events aren't tied to an application row anymore; they get
    // a stable placeholder name instead of the RACI fallback.
    expect((byType.get("app_removed") as any).appName).toBe("App removed");
  });

  it("deletes an app with related data and unlinks RACI rows", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.request("DELETE", "/apps/10");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applicationId: 10,
      name: "VLA",
      statusRows: 1,
      issues: 1,
      upvotes: 1,
      activityEvents: 1,
      raciRowsUnlinked: 1,
    });
    expect(fakeDb.rows(tables.applicationsTable).some((a: any) => a.id === 10)).toBe(false);
    expect(fakeDb.rows(tables.appTermStatusTable)).toHaveLength(0);
    expect(fakeDb.rows(tables.appIssuesTable)).toHaveLength(0);
    expect(fakeDb.rows(tables.appUpvotesTable)).toHaveLength(0);
    // RACI row is kept but unlinked.
    expect(fakeDb.rows(tables.raciRowsTable)[0]).toMatchObject({ id: 500, applicationId: null });
    // A tombstone activity event survives (not tied to the deleted app).
    const events = fakeDb
      .rows(tables.appActivityTable)
      .filter((e: any) => e.eventType === "app_removed");
    expect(events).toHaveLength(1);
    expect(events[0]?.applicationId).toBeNull();
    expect(events[0]?.detail).toContain('Removed app "VLA"');
    // A restore snapshot is kept so the delete can be undone.
    expect(res.body.deletedAppId).toBeGreaterThan(0);
    const snapshots = fakeDb.rows(tables.deletedAppsTable);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ appName: "VLA", deletedBy: 1 });
  });

  it("restores a deleted app with related data and re-links RACI rows", async () => {
    fakeDb.rows(tables.termsTable).push({ id: 1, name: "2026-27" });
    fakeDb.rows(tables.appIssuesTable).forEach((i: any) => (i.userId = 2));
    const admin = await loginAs(ADMIN);
    const del = await admin.request("DELETE", "/apps/10");
    expect(del.status).toBe(200);
    const res = await admin.post(`/apps/deleted/${del.body.deletedAppId}/restore`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "VLA",
      statusRows: 1,
      issues: 1,
      upvotes: 1,
      raciRowsRelinked: 1,
    });
    const newId = res.body.applicationId;
    const app = fakeDb.rows(tables.applicationsTable).find((a: any) => a.id === newId);
    expect(app).toMatchObject({ name: "VLA", category: "Custom Rostering — VLA" });
    expect(fakeDb.rows(tables.appTermStatusTable)).toHaveLength(1);
    expect(fakeDb.rows(tables.appTermStatusTable)[0]).toMatchObject({
      applicationId: newId,
      termId: 1,
    });
    expect(fakeDb.rows(tables.appIssuesTable)[0]).toMatchObject({
      applicationId: newId,
      comment: "broken",
    });
    expect(fakeDb.rows(tables.appUpvotesTable)[0]).toMatchObject({
      applicationId: newId,
      userId: 2,
    });
    // The RACI row unlinked by the delete is re-linked to the restored app.
    expect(fakeDb.rows(tables.raciRowsTable)[0]).toMatchObject({
      id: 500,
      applicationId: newId,
    });
    // Restore is logged and the snapshot is consumed.
    const restoredEvents = fakeDb
      .rows(tables.appActivityTable)
      .filter((e: any) => e.eventType === "app_restored");
    expect(restoredEvents).toHaveLength(1);
    expect(restoredEvents[0]?.detail).toContain('Restored app "VLA"');
    expect(fakeDb.rows(tables.deletedAppsTable)).toHaveLength(0);
  });

  it("does not re-link RACI rows that were linked elsewhere after the delete", async () => {
    const admin = await loginAs(ADMIN);
    const del = await admin.request("DELETE", "/apps/10");
    expect(del.status).toBe(200);
    // An admin links the freed RACI row to another app before the restore.
    fakeDb.rows(tables.raciRowsTable)[0]!.applicationId = 11;
    const res = await admin.post(`/apps/deleted/${del.body.deletedAppId}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.raciRowsRelinked).toBe(0);
    expect(fakeDb.rows(tables.raciRowsTable)[0]?.applicationId).toBe(11);
  });

  it("re-links RACI rows with a single conditional update (no select-then-update race)", async () => {
    const admin = await loginAs(ADMIN);
    const del = await admin.request("DELETE", "/apps/10");
    expect(del.status).toBe(200);
    // Capture the WHERE condition of every raciRows UPDATE issued by the
    // restore. The `application_id IS NULL` guard must live inside the UPDATE
    // itself — a separate select-then-update would let a concurrent admin's
    // newer link be overwritten between the read and the write.
    const captured: any[] = [];
    const original = fakeDb.update.bind(fakeDb);
    const spy = vi.spyOn(fakeDb, "update").mockImplementation(((table: any) => {
      const chain = original(table);
      if (table?.__label !== "raciRows") return chain;
      return {
        set: (vals: any) => ({
          where: (cond: any) => {
            captured.push(cond);
            return chain.set(vals).where(cond);
          },
        }),
      };
    }) as any);
    const res = await admin.post(`/apps/deleted/${del.body.deletedAppId}/restore`);
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.raciRowsRelinked).toBe(1);
    expect(captured.length).toBeGreaterThan(0);
    const flatten = (c: any): any[] => (c?.type === "and" ? c.conds.flatMap(flatten) : [c]);
    for (const cond of captured) {
      const parts = flatten(cond);
      expect(
        parts.some((p) => p.type === "isNull" && p.col?.name === "applicationId"),
      ).toBe(true);
    }
  });

  it("rejects restoring when an app with the same name exists again", async () => {
    const admin = await loginAs(ADMIN);
    const del = await admin.request("DELETE", "/apps/10");
    fakeDb.rows(tables.applicationsTable).push({
      id: 12,
      name: "vla",
      category: null,
      dayOneCritical: false,
    });
    const res = await admin.post(`/apps/deleted/${del.body.deletedAppId}/restore`);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("already exists");
    // Snapshot is kept so the conflict can be resolved and retried.
    expect(fakeDb.rows(tables.deletedAppsTable)).toHaveLength(1);
  });

  it("requires admin to restore and 404s for unknown snapshots", async () => {
    const staff = await loginAs(STAFF);
    expect((await staff.post("/apps/deleted/1/restore")).status).toBe(403);
    const admin = await loginAs(ADMIN);
    expect((await admin.post("/apps/deleted/999/restore")).status).toBe(404);
  });
});

describe("key read endpoints", () => {
  it("requires auth on usage endpoints", async () => {
    const anon = new Client();
    expect((await anon.get("/usage/summary")).status).toBe(401);
    expect((await anon.get("/usage/by-app")).status).toBe(401);
    expect((await anon.get("/usage/daily")).status).toBe(401);
  });

  it("reports hasData: false when no metrics exist", async () => {
    const client = await loginAs(STAFF);
    const res = await client.get("/usage/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasData: false });
  });

  it("returns the latest snapshot summary with adoption percentages", async () => {
    fakeDb.rows(tables.usageKeyMetricsTable).push(
      {
        snapshotDate: "2026-05-31",
        timeRange: "Last 30 days",
        uniqueStudents: 100,
        scopedStudents: 200,
        totalStudentLogins: 500,
        uniqueTeachers: 10,
        scopedTeachers: 20,
        totalTeacherLogins: 50,
      },
      {
        snapshotDate: "2026-06-30",
        timeRange: "Last 30 days",
        uniqueStudents: 150,
        scopedStudents: 200,
        totalStudentLogins: 700,
        uniqueTeachers: 15,
        scopedTeachers: 20,
        totalTeacherLogins: 75,
      },
    );
    const client = await loginAs(STAFF);
    const res = await client.get("/usage/summary");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      hasData: true,
      snapshotDate: "2026-06-30",
      uniqueStudents: 150,
      studentAdoptionPct: 75,
      teacherAdoptionPct: 75,
    });
  });

  it("returns by-app rows only for the latest snapshot, sorted by users", async () => {
    fakeDb.rows(tables.usageByAppTable).push(
      { application: "Old", uniqueUsers: 999, scopedUsers: 1000, snapshotDate: "2026-05-31" },
      { application: "IXL", uniqueUsers: 120, scopedUsers: 150, snapshotDate: "2026-06-30" },
      { application: "Seesaw", uniqueUsers: 130, scopedUsers: 150, snapshotDate: "2026-06-30" },
    );
    const client = await loginAs(STAFF);
    const res = await client.get("/usage/by-app");
    expect(res.status).toBe(200);
    expect(res.body.map((r: { application: string }) => r.application)).toEqual([
      "Seesaw",
      "IXL",
    ]);
    expect(res.body[0].adoptionPct).toBeCloseTo(86.7);
  });

  it("merges student and teacher daily usage with date filtering", async () => {
    fakeDb.rows(tables.usageDailyStudentTable).push(
      { date: "2026-06-01", activeUsers: 100 },
      { date: "2026-06-02", activeUsers: 110 },
      { date: "2026-05-01", activeUsers: 90 },
    );
    fakeDb.rows(tables.usageDailyTeacherTable).push(
      { date: "2026-06-01", activeUsers: 9 },
      { date: "2026-06-03", activeUsers: 12 },
    );
    const client = await loginAs(STAFF);
    const res = await client.request(
      "GET",
      "/usage/daily?startDate=2026-06-01&endDate=2026-06-30",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { date: "2026-06-01", studentUsers: 100, teacherUsers: 9 },
      { date: "2026-06-02", studentUsers: 110, teacherUsers: null },
      { date: "2026-06-03", studentUsers: null, teacherUsers: 12 },
    ]);
  });

  it("requires auth on additional-resources history", async () => {
    const anon = new Client();
    expect((await anon.get("/usage/additional-resources/history")).status).toBe(401);
  });

  it("returns empty history when there is no resource data", async () => {
    const client = await loginAs(STAFF);
    const res = await client.get("/usage/additional-resources/history");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ snapshotDates: [], resources: [] });
  });

  it("returns per-resource series across snapshots, sorted by latest users", async () => {
    fakeDb.rows(tables.usageAdditionalResourcesTable).push(
      { link: "Library", uniqueUsers: 5, totalAccesses: 8, snapshotDate: "2026-06-28" },
      { link: "Library", uniqueUsers: 7, totalAccesses: 11, snapshotDate: "2026-06-29" },
      { link: "Library", uniqueUsers: 9, totalAccesses: 14, snapshotDate: "2026-06-30" },
      { link: "Portal", uniqueUsers: 20, totalAccesses: 30, snapshotDate: "2026-06-29" },
      { link: "Portal", uniqueUsers: 25, totalAccesses: 40, snapshotDate: "2026-06-30" },
    );
    const client = await loginAs(STAFF);
    const res = await client.get("/usage/additional-resources/history");
    expect(res.status).toBe(200);
    expect(res.body.snapshotDates).toEqual(["2026-06-28", "2026-06-29", "2026-06-30"]);
    expect(res.body.resources.map((r: { link: string }) => r.link)).toEqual([
      "Portal",
      "Library",
    ]);
    expect(res.body.resources[0].points).toEqual([
      { snapshotDate: "2026-06-29", uniqueUsers: 20, totalAccesses: 30 },
      { snapshotDate: "2026-06-30", uniqueUsers: 25, totalAccesses: 40 },
    ]);
    expect(res.body.resources[1].points).toHaveLength(3);
  });

  it("respects the limit query on history snapshots", async () => {
    fakeDb.rows(tables.usageAdditionalResourcesTable).push(
      { link: "Library", uniqueUsers: 5, totalAccesses: 8, snapshotDate: "2026-06-28" },
      { link: "Library", uniqueUsers: 7, totalAccesses: 11, snapshotDate: "2026-06-29" },
      { link: "Library", uniqueUsers: 9, totalAccesses: 14, snapshotDate: "2026-06-30" },
    );
    const client = await loginAs(STAFF);
    const res = await client.get("/usage/additional-resources/history?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.snapshotDates).toEqual(["2026-06-29", "2026-06-30"]);
    expect(res.body.resources[0].points).toHaveLength(2);
  });
});
