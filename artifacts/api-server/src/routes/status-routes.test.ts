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
  patch(path: string, body?: unknown) {
    return this.request("PATCH", path, body);
  }
  delete(path: string) {
    return this.request("DELETE", path);
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
      tags: [],
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      id: 2,
      email: STAFF.email,
      passwordHash: staffHash,
      displayName: "Staff Member",
      role: "staff",
      tags: ["IT"],
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

function seedTerm(overrides: Record<string, unknown> = {}) {
  const term = {
    id: ++state.idCounter,
    label: "2026-27 Regular",
    schoolYear: "2026-27",
    termType: "regular",
    startDate: "2026-08-14",
    endDate: "2027-06-11",
    sortOrder: 2,
    isCurrent: true,
    ...overrides,
  };
  fakeDb.rows(tables.termsTable).push(term);
  return term;
}

function seedApp(name: string, category: string | null = "Math") {
  const app = { id: ++state.idCounter, name, category, dayOneCritical: false, createdAt: new Date() };
  fakeDb.rows(tables.applicationsTable).push(app);
  return app;
}

function seedStatus(applicationId: number, termId: number, overrides: Record<string, unknown> = {}) {
  const row = {
    id: ++state.idCounter,
    applicationId,
    termId,
    studentSharingStatus: "not_started",
    staffSharingStatus: "not_started",
    syncMethod: null,
    lastSyncedAt: null,
    owner: null,
    notes: null,
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    updatedBy: null,
    ...overrides,
  };
  fakeDb.rows(tables.appTermStatusTable).push(row);
  return row;
}

describe("GET /api/terms", () => {
  it("requires authentication", async () => {
    expect((await new Client().get("/terms")).status).toBe(401);
  });

  it("returns terms sorted by sortOrder", async () => {
    seedTerm({ label: "Later", sortOrder: 5, isCurrent: false });
    seedTerm({ label: "Earlier", sortOrder: 1 });
    const client = await loginAs(STAFF);
    const res = await client.get("/terms");
    expect(res.status).toBe(200);
    expect(res.body.map((t: { label: string }) => t.label)).toEqual(["Earlier", "Later"]);
  });
});

describe("POST /api/terms", () => {
  const NEW_TERM = {
    label: "2027-28 Regular",
    schoolYear: "2027-28",
    termType: "regular",
    startDate: "2027-08-13",
    endDate: "2028-06-09",
    sortOrder: 9,
  };

  it("requires admin", async () => {
    expect((await new Client().post("/terms", NEW_TERM)).status).toBe(401);
    const staff = await loginAs(STAFF);
    const res = await staff.post("/terms", NEW_TERM);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Admin access required");
  });

  it("rejects an invalid body with 400", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.post("/terms", { label: "no year" })).status).toBe(400);
  });

  it("creates a term and unsets other current terms when isCurrent is true", async () => {
    const existing = seedTerm({ isCurrent: true });
    const admin = await loginAs(ADMIN);
    const res = await admin.post("/terms", { ...NEW_TERM, isCurrent: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ label: NEW_TERM.label, isCurrent: true });
    const old = fakeDb.rows(tables.termsTable).find((t) => t.id === existing.id);
    expect(old!.isCurrent).toBe(false);
  });
});

describe("PATCH /api/terms/:id", () => {
  it("rejects a non-numeric id", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.patch("/terms/abc", { label: "x" })).status).toBe(400);
  });

  it("returns 404 for an unknown term", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.patch("/terms/999", { label: "x" })).status).toBe(404);
  });

  it("refuses to un-set the current term", async () => {
    const term = seedTerm();
    const admin = await loginAs(ADMIN);
    const res = await admin.patch(`/terms/${term.id}`, { isCurrent: false });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("another term");
  });

  it("makes a term current and unsets the previous one", async () => {
    const current = seedTerm({ isCurrent: true, sortOrder: 1, label: "Old" });
    const next = seedTerm({ isCurrent: false, sortOrder: 2, label: "New" });
    const admin = await loginAs(ADMIN);
    const res = await admin.patch(`/terms/${next.id}`, { isCurrent: true });
    expect(res.status).toBe(200);
    expect(res.body.isCurrent).toBe(true);
    const old = fakeDb.rows(tables.termsTable).find((t) => t.id === current.id);
    expect(old!.isCurrent).toBe(false);
  });
});

describe("POST /api/terms/:id/copy-statuses", () => {
  it("returns 404 when either term is missing", async () => {
    const term = seedTerm();
    const admin = await loginAs(ADMIN);
    const res = await admin.post(`/terms/${term.id}/copy-statuses`, { sourceTermId: 999 });
    expect(res.status).toBe(404);
  });

  it("copies only statuses for apps the target term does not already cover", async () => {
    const source = seedTerm({ label: "Source", isCurrent: false, sortOrder: 1 });
    const target = seedTerm({ label: "Target", sortOrder: 2 });
    const appA = seedApp("AppA");
    const appB = seedApp("AppB");
    seedStatus(appA.id, source.id, { studentSharingStatus: "complete", owner: "Dana" });
    seedStatus(appB.id, source.id, { studentSharingStatus: "in_progress" });
    seedStatus(appA.id, target.id);
    const admin = await loginAs(ADMIN);
    const res = await admin.post(`/terms/${target.id}/copy-statuses`, {
      sourceTermId: source.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Copied 1 status rows from Source");
    const targetRows = fakeDb
      .rows(tables.appTermStatusTable)
      .filter((r) => r.termId === target.id);
    expect(targetRows).toHaveLength(2);
    const copied = targetRows.find((r) => r.applicationId === appB.id);
    expect(copied).toMatchObject({ studentSharingStatus: "in_progress" });
  });
});

describe("GET /api/users", () => {
  it("requires admin", async () => {
    expect((await new Client().get("/users")).status).toBe(401);
    const staff = await loginAs(STAFF);
    expect((await staff.get("/users")).status).toBe(403);
  });

  it("lists users sorted by email without password hashes", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.get("/users");
    expect(res.status).toBe(200);
    expect(res.body.map((u: { email: string }) => u.email)).toEqual([
      ADMIN.email,
      STAFF.email,
    ]);
    for (const u of res.body) {
      expect(u).not.toHaveProperty("passwordHash");
      expect(typeof u.createdAt).toBe("string");
    }
  });
});

describe("GET /api/users/options", () => {
  it("requires a signed-in user", async () => {
    expect((await new Client().get("/users/options")).status).toBe(401);
  });

  it("lets staff list user options sorted by display name, without emails or hashes", async () => {
    const staff = await loginAs(STAFF);
    const res = await staff.get("/users/options");
    expect(res.status).toBe(200);
    expect(res.body.map((u: { displayName: string }) => u.displayName)).toEqual([
      "Administrator",
      "Staff Member",
    ]);
    for (const u of res.body) {
      expect(Object.keys(u).sort()).toEqual(["displayName", "id", "role", "tags"]);
      expect(Array.isArray(u.tags)).toBe(true);
    }
    const staffOption = res.body.find(
      (u: { displayName: string }) => u.displayName === "Staff Member",
    );
    expect(staffOption.tags).toEqual(["IT"]);
  });

  it("lets an admin update a user's tags", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.patch("/users/1", { tags: ["IT", "Ops"] });
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(["IT", "Ops"]);
    const options = await admin.get("/users/options");
    const updated = options.body.find((u: { id: number }) => u.id === 1);
    expect(updated.tags).toEqual(["IT", "Ops"]);
  });
});

describe("POST /api/users", () => {
  const NEW_USER = {
    email: "New.Person@sageoak.org",
    password: "a-strong-password",
    displayName: "New Person",
    role: "staff",
  };

  it("rejects an invalid body with 400", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.post("/users", { email: "x" })).status).toBe(400);
  });

  it("rejects a duplicate email", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.post("/users", { ...NEW_USER, email: ADMIN.email });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("already exists");
  });

  it("creates a user with lowercased email and hashed password", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.post("/users", NEW_USER);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: "new.person@sageoak.org",
      displayName: "New Person",
      role: "staff",
    });
    expect(res.body).not.toHaveProperty("passwordHash");
    const stored = fakeDb
      .rows(tables.usersTable)
      .find((u) => u.email === "new.person@sageoak.org");
    expect(stored).toBeDefined();
    expect(stored!.passwordHash).not.toBe(NEW_USER.password);
    expect(await bcrypt.compare(NEW_USER.password, stored!.passwordHash as string)).toBe(
      true,
    );
  });
});

describe("PATCH /api/users/:id", () => {
  it("requires admin", async () => {
    const staff = await loginAs(STAFF);
    expect((await staff.patch("/users/2", { displayName: "X" })).status).toBe(403);
  });

  it("rejects an empty update", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.patch("/users/2", {});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("No changes provided");
  });

  it("returns 404 for an unknown user", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.patch("/users/999", { displayName: "X" })).status).toBe(404);
  });

  it("updates display name and role", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.patch("/users/2", { displayName: "Renamed", role: "admin" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 2, displayName: "Renamed", role: "admin" });
  });
});

describe("DELETE /api/users/:id", () => {
  it("prevents deleting your own account", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.delete("/users/1");
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("You cannot delete your own account");
  });

  it("returns 404 for an unknown user", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.delete("/users/999")).status).toBe(404);
  });

  it("deletes another user", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.delete("/users/2");
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("User deleted");
    expect(fakeDb.rows(tables.usersTable).find((u) => u.id === 2)).toBeUndefined();
  });
});

describe("GET /api/rostering/board", () => {
  it("requires authentication", async () => {
    expect((await new Client().get("/rostering/board?termId=1")).status).toBe(401);
  });

  it("requires a numeric termId", async () => {
    const client = await loginAs(STAFF);
    const res = await client.get("/rostering/board");
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("termId");
  });

  it("returns board rows with upvote and open-issue counts, sorted by app name", async () => {
    const term = seedTerm();
    const other = seedTerm({ label: "Other", isCurrent: false, sortOrder: 9 });
    const zebra = seedApp("Zebra");
    const alpha = seedApp("Alpha");
    seedStatus(zebra.id, term.id, { studentSharingStatus: "complete" });
    seedStatus(alpha.id, term.id, { updatedBy: 1 });
    seedStatus(alpha.id, other.id);
    fakeDb.rows(tables.appUpvotesTable).push(
      { id: ++state.idCounter, applicationId: alpha.id, userId: 1, createdAt: new Date() },
      { id: ++state.idCounter, applicationId: alpha.id, userId: 2, createdAt: new Date() },
    );
    fakeDb.rows(tables.appIssuesTable).push(
      {
        id: ++state.idCounter,
        applicationId: alpha.id,
        userId: 2,
        comment: "broken",
        status: "open",
        createdAt: new Date(),
      },
      {
        id: ++state.idCounter,
        applicationId: alpha.id,
        userId: 2,
        comment: "fixed already",
        status: "resolved",
        createdAt: new Date(),
      },
    );

    const client = await loginAs(STAFF);
    const res = await client.get(`/rostering/board?termId=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((r: { appName: string }) => r.appName)).toEqual(["Alpha", "Zebra"]);
    const alphaRow = res.body[0];
    expect(alphaRow).toMatchObject({
      applicationId: alpha.id,
      upvoteCount: 2,
      upvotedByMe: true,
      openIssueCount: 1,
      updatedByName: "Administrator",
    });
    expect(typeof alphaRow.updatedAt).toBe("string");
    const zebraRow = res.body[1];
    expect(zebraRow).toMatchObject({
      studentSharingStatus: "complete",
      upvoteCount: 0,
      upvotedByMe: false,
      openIssueCount: 0,
      updatedByName: null,
    });
  });
  it("includes the day-one critical flag on board rows", async () => {
    const term = seedTerm();
    const critical = seedApp("Critical App");
    critical.dayOneCritical = true;
    const normal = seedApp("Normal App");
    seedStatus(critical.id, term.id);
    seedStatus(normal.id, term.id);

    const client = await loginAs(STAFF);
    const res = await client.get(`/rostering/board?termId=${term.id}`);
    expect(res.status).toBe(200);
    const byName = new Map(res.body.map((r: { appName: string }) => [r.appName, r]));
    expect(byName.get("Critical App")).toMatchObject({ dayOneCritical: true });
    expect(byName.get("Normal App")).toMatchObject({ dayOneCritical: false });
  });
});

describe("POST /api/apps (manual app creation)", () => {
  it("requires admin", async () => {
    const term = seedTerm();
    const body = { name: "VLA", termId: term.id };
    expect((await new Client().post("/apps", body)).status).toBe(401);
    const staff = await loginAs(STAFF);
    expect((await staff.post("/apps", body)).status).toBe(403);
  });

  it("rejects an invalid body", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.post("/apps", {})).status).toBe(400);
    expect((await admin.post("/apps", { name: "", termId: 1 })).status).toBe(400);
    expect((await admin.post("/apps", { name: "   ", termId: seedTerm().id })).status).toBe(400);
  });

  it("returns 404 for an unknown term", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.post("/apps", { name: "VLA", termId: 99999 });
    expect(res.status).toBe(404);
  });

  it("rejects duplicate names case-insensitively with 409", async () => {
    const term = seedTerm();
    seedApp("Zoom");
    const admin = await loginAs(ADMIN);
    const res = await admin.post("/apps", { name: "  zoom ", termId: term.id });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("Zoom");
  });

  it("rejects an inactive sharing status option", async () => {
    const term = seedTerm();
    const admin = await loginAs(ADMIN);
    const res = await admin.post("/apps", {
      name: "VLA",
      termId: term.id,
      studentSharingStatus: "definitely_not_a_status",
    });
    expect(res.status).toBe(400);
  });

  it("creates the app, its status row for the term, and an activity event", async () => {
    const term = seedTerm();
    const admin = await loginAs(ADMIN);
    const res = await admin.post("/apps", {
      name: "VLA",
      termId: term.id,
      category: "Custom Rostering — VLA",
      owner: "Administrator",
      notes: "Sections and enrollments handled by custom rostering",
      studentSharingStatus: "in_progress",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "VLA", category: "Custom Rostering — VLA" });

    const app = fakeDb
      .rows(tables.applicationsTable)
      .find((a) => a.name === "VLA");
    expect(app).toBeTruthy();
    const status = fakeDb
      .rows(tables.appTermStatusTable)
      .find((s) => s.applicationId === app!.id && s.termId === term.id);
    expect(status).toMatchObject({
      studentSharingStatus: "in_progress",
      staffSharingStatus: "not_started",
      owner: "Administrator",
    });
    const activity = fakeDb
      .rows(tables.appActivityTable)
      .find((e) => e.applicationId === app!.id);
    expect(activity).toMatchObject({ eventType: "app_added" });
    expect(activity!.detail).toContain("Added manually");

    // The new app appears on the board for that term.
    const board = await admin.get(`/rostering/board?termId=${term.id}`);
    expect(board.status).toBe(200);
    expect(board.body.some((r: any) => r.appName === "VLA")).toBe(true);
  });
});

describe("PATCH /api/apps/:id/day-one-critical", () => {
  it("requires admin", async () => {
    const app = seedApp("Alpha");
    expect(
      (await new Client().patch(`/apps/${app.id}/day-one-critical`, { dayOneCritical: true })).status,
    ).toBe(401);
    const staff = await loginAs(STAFF);
    const res = await staff.patch(`/apps/${app.id}/day-one-critical`, { dayOneCritical: true });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid body", async () => {
    const app = seedApp("Alpha");
    const admin = await loginAs(ADMIN);
    expect((await admin.patch(`/apps/${app.id}/day-one-critical`, {})).status).toBe(400);
    expect(
      (await admin.patch(`/apps/${app.id}/day-one-critical`, { dayOneCritical: "yes" })).status,
    ).toBe(400);
  });

  it("returns 404 for an unknown app", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.patch("/apps/99999/day-one-critical", { dayOneCritical: true });
    expect(res.status).toBe(404);
  });

  it("flags and unflags an app", async () => {
    const app = seedApp("Alpha");
    const admin = await loginAs(ADMIN);
    const on = await admin.patch(`/apps/${app.id}/day-one-critical`, { dayOneCritical: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ applicationId: app.id, dayOneCritical: true });
    expect(
      fakeDb.rows(tables.applicationsTable).find((a) => a.id === app.id)?.dayOneCritical,
    ).toBe(true);
    const off = await admin.patch(`/apps/${app.id}/day-one-critical`, { dayOneCritical: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ applicationId: app.id, dayOneCritical: false });
  });
});

describe("GET /api/rostering/summary", () => {
  it("requires a termId", async () => {
    const client = await loginAs(STAFF);
    expect((await client.get("/rostering/summary")).status).toBe(400);
  });

  it("counts statuses per bucket for the requested term only", async () => {
    const term = seedTerm();
    const other = seedTerm({ label: "Other", isCurrent: false, sortOrder: 9 });
    const apps = ["A", "B", "C", "D"].map((n) => seedApp(n));
    seedStatus(apps[0]!.id, term.id, { studentSharingStatus: "complete" });
    seedStatus(apps[1]!.id, term.id, { studentSharingStatus: "complete" });
    seedStatus(apps[2]!.id, term.id, { studentSharingStatus: "in_progress" });
    seedStatus(apps[3]!.id, term.id, { studentSharingStatus: "needs_review" });
    seedStatus(apps[0]!.id, other.id, { studentSharingStatus: "not_started" });
    const client = await loginAs(STAFF);
    const res = await client.get(`/rostering/summary?termId=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      notStarted: 0,
      inProgress: 1,
      complete: 2,
      needsReview: 1,
      total: 4,
    });
  });
});

describe("GET /api/rostering/activity", () => {
  it("requires authentication", async () => {
    expect((await new Client().get("/rostering/activity")).status).toBe(401);
  });

  it("rejects a non-numeric termId", async () => {
    const client = await loginAs(STAFF);
    expect((await client.get("/rostering/activity?termId=abc")).status).toBe(400);
  });

  it("returns newest-first events with app and actor names, keeping null-term events", async () => {
    const term = seedTerm();
    const other = seedTerm({ label: "Other", isCurrent: false, sortOrder: 9 });
    const app1 = seedApp("IXL");
    fakeDb.rows(tables.appActivityTable).push(
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: term.id,
        eventType: "status_change",
        detail: "older",
        actorId: 1,
        createdAt: new Date("2026-07-01T09:00:00Z"),
      },
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: null,
        eventType: "issue_reported",
        detail: "no term",
        actorId: null,
        createdAt: new Date("2026-07-02T09:00:00Z"),
      },
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: other.id,
        eventType: "status_change",
        detail: "other term",
        actorId: 1,
        createdAt: new Date("2026-07-03T09:00:00Z"),
      },
    );
    const client = await loginAs(STAFF);
    const res = await client.get(`/rostering/activity?termId=${term.id}`);
    expect(res.status).toBe(200);
    expect(res.body.map((e: { detail: string }) => e.detail)).toEqual(["no term", "older"]);
    expect(res.body[1]).toMatchObject({
      appName: "IXL",
      actorName: "Administrator",
      eventType: "status_change",
      createdAt: "2026-07-01T09:00:00.000Z",
    });
    expect(res.body[0].actorName).toBeNull();
  });

  it("respects the limit parameter", async () => {
    const app1 = seedApp("IXL");
    for (let i = 0; i < 5; i++) {
      fakeDb.rows(tables.appActivityTable).push({
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: null,
        eventType: "status_change",
        detail: `event ${i}`,
        actorId: null,
        createdAt: new Date(Date.UTC(2026, 6, 1, i)),
      });
    }
    const client = await loginAs(STAFF);
    const res = await client.get("/rostering/activity?limit=2");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].detail).toBe("event 4");
  });
});

describe("rostering last-seen", () => {
  it("requires authentication", async () => {
    expect((await new Client().get("/rostering/last-seen")).status).toBe(401);
    expect((await new Client().post("/rostering/last-seen")).status).toBe(401);
  });

  it("starts null, records a visit, and returns the previous visit on re-post", async () => {
    const client = await loginAs(STAFF);
    const first = await client.get("/rostering/last-seen");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ lastSeenAt: null });

    const mark = await client.post("/rostering/last-seen");
    expect(mark.status).toBe(200);
    expect(mark.body.lastSeenAt).toBeNull();

    const after = await client.get("/rostering/last-seen");
    expect(after.status).toBe(200);
    expect(typeof after.body.lastSeenAt).toBe("string");

    const again = await client.post("/rostering/last-seen");
    expect(again.status).toBe(200);
    expect(again.body.lastSeenAt).toBe(after.body.lastSeenAt);
    expect(
      fakeDb.rows(tables.pageLastSeenTable).filter((r) => r.userId === 2),
    ).toHaveLength(1);
  });
});

describe("GET /api/rostering/unseen-count", () => {
  it("requires authentication", async () => {
    expect((await new Client().get("/rostering/unseen-count")).status).toBe(401);
  });

  it("counts all activity when the user has never visited", async () => {
    const app1 = seedApp("IXL");
    fakeDb.rows(tables.appActivityTable).push(
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: null,
        eventType: "status_change",
        detail: "one",
        actorId: null,
        createdAt: new Date("2026-07-01T09:00:00Z"),
      },
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: null,
        eventType: "status_change",
        detail: "two",
        actorId: null,
        createdAt: new Date("2026-07-02T09:00:00Z"),
      },
    );
    const client = await loginAs(STAFF);
    const res = await client.get("/rostering/unseen-count");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2 });
  });

  it("counts only activity newer than the last visit and resets after marking seen", async () => {
    const app1 = seedApp("IXL");
    fakeDb.rows(tables.appActivityTable).push({
      id: ++state.idCounter,
      applicationId: app1.id,
      termId: null,
      eventType: "status_change",
      detail: "old",
      actorId: null,
      createdAt: new Date("2026-07-01T09:00:00Z"),
    });
    const client = await loginAs(STAFF);
    await client.post("/rostering/last-seen");

    const cleared = await client.get("/rostering/unseen-count");
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ count: 0 });

    fakeDb.rows(tables.appActivityTable).push({
      id: ++state.idCounter,
      applicationId: app1.id,
      termId: null,
      eventType: "status_change",
      detail: "new",
      actorId: null,
      createdAt: new Date(Date.now() + 60_000),
    });
    const after = await client.get("/rostering/unseen-count");
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ count: 1 });
  });
});

describe("issues last-seen and unseen-count", () => {
  it("requires authentication", async () => {
    expect((await new Client().get("/issues/last-seen")).status).toBe(401);
    expect((await new Client().post("/issues/last-seen")).status).toBe(401);
    expect((await new Client().get("/issues/unseen-count")).status).toBe(401);
  });

  it("starts null, records a visit, and returns the previous visit on re-post", async () => {
    const client = await loginAs(STAFF);
    const first = await client.get("/issues/last-seen");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ lastSeenAt: null });

    const mark = await client.post("/issues/last-seen");
    expect(mark.status).toBe(200);
    expect(mark.body.lastSeenAt).toBeNull();

    const after = await client.get("/issues/last-seen");
    expect(after.status).toBe(200);
    expect(typeof after.body.lastSeenAt).toBe("string");

    const again = await client.post("/issues/last-seen");
    expect(again.status).toBe(200);
    expect(again.body.lastSeenAt).toBe(after.body.lastSeenAt);
  });

  it("counts only issue events, ignoring other activity types", async () => {
    const app1 = seedApp("IXL");
    fakeDb.rows(tables.appActivityTable).push(
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: null,
        eventType: "issue_reported",
        detail: "Issue reported: broken login",
        actorId: null,
        createdAt: new Date("2026-07-01T09:00:00Z"),
      },
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: null,
        eventType: "issue_resolved",
        detail: "Issue resolved: broken login",
        actorId: null,
        createdAt: new Date("2026-07-02T09:00:00Z"),
      },
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: null,
        eventType: "status_change",
        detail: "not an issue event",
        actorId: null,
        createdAt: new Date("2026-07-03T09:00:00Z"),
      },
    );
    const client = await loginAs(STAFF);
    const res = await client.get("/issues/unseen-count");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2 });
  });

  it("counts only issue events newer than the last visit and resets after marking seen", async () => {
    const app1 = seedApp("IXL");
    fakeDb.rows(tables.appActivityTable).push({
      id: ++state.idCounter,
      applicationId: app1.id,
      termId: null,
      eventType: "issue_reported",
      detail: "old issue",
      actorId: null,
      createdAt: new Date("2026-07-01T09:00:00Z"),
    });
    const client = await loginAs(STAFF);
    await client.post("/issues/last-seen");

    const cleared = await client.get("/issues/unseen-count");
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ count: 0 });

    fakeDb.rows(tables.appActivityTable).push({
      id: ++state.idCounter,
      applicationId: app1.id,
      termId: null,
      eventType: "issue_resolved",
      detail: "new resolution",
      actorId: null,
      createdAt: new Date(Date.now() + 60_000),
    });
    const after = await client.get("/issues/unseen-count");
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ count: 1 });
  });

  it("keeps rostering and issues last-seen independent", async () => {
    const client = await loginAs(STAFF);
    await client.post("/rostering/last-seen");
    const issues = await client.get("/issues/last-seen");
    expect(issues.status).toBe(200);
    expect(issues.body).toEqual({ lastSeenAt: null });
  });
});

describe("PATCH /api/rostering/status/:id", () => {
  it("requires admin", async () => {
    const staff = await loginAs(STAFF);
    const res = await staff.patch("/rostering/status/1", {
      studentSharingStatus: "complete",
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid body with 400", async () => {
    const term = seedTerm();
    const app1 = seedApp("IXL");
    const status = seedStatus(app1.id, term.id);
    const admin = await loginAs(ADMIN);
    const res = await admin.patch(`/rostering/status/${status.id}`, {
      studentSharingStatus: "bogus",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown status row", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.patch("/rostering/status/999", {
      studentSharingStatus: "complete",
    });
    expect(res.status).toBe(404);
  });

  it("updates the row, records an activity event, and returns the updater name", async () => {
    const term = seedTerm();
    const app1 = seedApp("IXL");
    const status = seedStatus(app1.id, term.id);
    const admin = await loginAs(ADMIN);
    const res = await admin.patch(`/rostering/status/${status.id}`, {
      studentSharingStatus: "complete",
      owner: "Dana",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: status.id,
      studentSharingStatus: "complete",
      owner: "Dana",
      updatedByName: "Administrator",
    });
    expect(typeof res.body.updatedAt).toBe("string");
    const events = fakeDb.rows(tables.appActivityTable);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      applicationId: app1.id,
      termId: term.id,
      eventType: "status_change",
      actorId: 1,
    });
    expect(events[0]!.detail).toContain("Not started → Complete");
    expect(events[0]!.detail).toContain("Owner set to Dana");
  });

  it("does not record an activity event when nothing changed", async () => {
    const term = seedTerm();
    const app1 = seedApp("IXL");
    const status = seedStatus(app1.id, term.id);
    const admin = await loginAs(ADMIN);
    const res = await admin.patch(`/rostering/status/${status.id}`, {
      studentSharingStatus: "not_started",
    });
    expect(res.status).toBe(200);
    expect(fakeDb.rows(tables.appActivityTable)).toHaveLength(0);
  });

  it("accepts a custom status defined in settings", async () => {
    fakeDb.rows(tables.appSettingsTable).push({
      key: "sharingStatusOptions",
      value: JSON.stringify([
        { value: "not_started", label: "Not started", active: true },
        { value: "waiting_on_vendor", label: "Waiting on vendor", active: true },
      ]),
      updatedAt: new Date(),
    });
    const term = seedTerm();
    const app1 = seedApp("IXL");
    const status = seedStatus(app1.id, term.id);
    const admin = await loginAs(ADMIN);
    const res = await admin.patch(`/rostering/status/${status.id}`, {
      studentSharingStatus: "waiting_on_vendor",
    });
    expect(res.status).toBe(200);
    expect(res.body.studentSharingStatus).toBe("waiting_on_vendor");
  });

  it("rejects a status that has been deactivated in settings", async () => {
    fakeDb.rows(tables.appSettingsTable).push({
      key: "sharingStatusOptions",
      value: JSON.stringify([
        { value: "not_started", label: "Not started", active: true },
        { value: "complete", label: "Complete", active: false },
      ]),
      updatedAt: new Date(),
    });
    const term = seedTerm();
    const app1 = seedApp("IXL");
    const status = seedStatus(app1.id, term.id);
    const admin = await loginAs(ADMIN);
    const res = await admin.patch(`/rostering/status/${status.id}`, {
      studentSharingStatus: "complete",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/apps/:id/upvote", () => {
  it("requires authentication", async () => {
    expect((await new Client().post("/apps/1/upvote")).status).toBe(401);
  });

  it("returns 404 for an unknown app", async () => {
    const client = await loginAs(STAFF);
    expect((await client.post("/apps/999/upvote")).status).toBe(404);
  });

  it("toggles the upvote on and off with counts", async () => {
    const app1 = seedApp("IXL");
    fakeDb.rows(tables.appUpvotesTable).push({
      id: ++state.idCounter,
      applicationId: app1.id,
      userId: 1,
      createdAt: new Date(),
    });
    const client = await loginAs(STAFF);
    const on = await client.post(`/apps/${app1.id}/upvote`);
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ applicationId: app1.id, upvoted: true, upvoteCount: 2 });
    const off = await client.post(`/apps/${app1.id}/upvote`);
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ applicationId: app1.id, upvoted: false, upvoteCount: 1 });
  });
});

describe("POST /api/apps/:id/issues", () => {
  it("rejects a missing comment", async () => {
    const app1 = seedApp("IXL");
    const client = await loginAs(STAFF);
    const res = await client.post(`/apps/${app1.id}/issues`, {});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("A comment is required");
  });

  it("returns 404 for an unknown app", async () => {
    const client = await loginAs(STAFF);
    expect((await client.post("/apps/999/issues", { comment: "x" })).status).toBe(404);
  });

  it("creates the issue and logs activity against the current term", async () => {
    const term = seedTerm({ isCurrent: true });
    const app1 = seedApp("IXL");
    const client = await loginAs(STAFF);
    const res = await client.post(`/apps/${app1.id}/issues`, {
      comment: "Roster sync is failing",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      applicationId: app1.id,
      appName: "IXL",
      userId: 2,
      reporterName: "Staff Member",
      comment: "Roster sync is failing",
      status: "open",
    });
    expect(typeof res.body.createdAt).toBe("string");
    const events = fakeDb.rows(tables.appActivityTable);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      applicationId: app1.id,
      termId: term.id,
      eventType: "issue_reported",
      actorId: 2,
    });
  });
});

describe("GET /api/issues", () => {
  it("requires authentication", async () => {
    expect((await new Client().get("/issues")).status).toBe(401);
  });

  it("lists issues newest first and filters by status", async () => {
    const app1 = seedApp("IXL");
    fakeDb.rows(tables.appIssuesTable).push(
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        userId: 2,
        comment: "old open",
        status: "open",
        createdAt: new Date("2026-07-01T00:00:00Z"),
      },
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        userId: 1,
        comment: "resolved one",
        status: "resolved",
        createdAt: new Date("2026-07-02T00:00:00Z"),
      },
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        userId: 2,
        comment: "new open",
        status: "open",
        createdAt: new Date("2026-07-03T00:00:00Z"),
      },
    );
    const client = await loginAs(STAFF);
    const all = await client.get("/issues");
    expect(all.status).toBe(200);
    expect(all.body.map((i: { comment: string }) => i.comment)).toEqual([
      "new open",
      "resolved one",
      "old open",
    ]);
    expect(all.body[0]).toMatchObject({
      appName: "IXL",
      reporterName: "Staff Member",
      status: "open",
    });
    const open = await client.get("/issues?status=open");
    expect(open.body.map((i: { comment: string }) => i.comment)).toEqual([
      "new open",
      "old open",
    ]);
    const resolved = await client.get("/issues?status=resolved");
    expect(resolved.body.map((i: { comment: string }) => i.comment)).toEqual([
      "resolved one",
    ]);
  });

  it("includes RACI people for the app, sorted A then R, skipping N/A", async () => {
    const app1 = seedApp("IXL");
    fakeDb.rows(tables.appIssuesTable).push({
      id: ++state.idCounter,
      applicationId: app1.id,
      userId: 2,
      comment: "who owns this?",
      status: "open",
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    fakeDb.rows(tables.raciTeamsTable).push({ id: 10, name: "IT", sortOrder: 0 });
    fakeDb.rows(tables.raciMembersTable).push(
      { id: 20, teamId: 10, name: "Brad", userId: null, sortOrder: 0 },
      { id: 21, teamId: 10, name: "Ash", userId: null, sortOrder: 1 },
      { id: 22, teamId: 10, name: "Katie", userId: null, sortOrder: 2 },
    );
    fakeDb.rows(tables.raciRowsTable).push({
      id: 30,
      teamId: 10,
      category: "ROSTERING",
      name: "IXL",
      sortOrder: 0,
      applicationId: app1.id,
    });
    fakeDb.rows(tables.raciAssignmentsTable).push(
      { id: 40, rowId: 30, memberId: 20, value: "R" },
      { id: 41, rowId: 30, memberId: 21, value: "A" },
      { id: 42, rowId: 30, memberId: 22, value: "N/A" },
    );
    const client = await loginAs(STAFF);
    const res = await client.get("/issues");
    expect(res.status).toBe(200);
    expect(res.body[0].raci).toEqual([
      { name: "Ash", value: "A" },
      { name: "Brad", value: "R" },
    ]);
  });
});

describe("PATCH /api/issues/:id", () => {
  function seedIssue(applicationId: number, overrides: Record<string, unknown> = {}) {
    const issue = {
      id: ++state.idCounter,
      applicationId,
      userId: 2,
      comment: "Something broke",
      status: "open",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      ...overrides,
    };
    fakeDb.rows(tables.appIssuesTable).push(issue);
    return issue;
  }

  it("requires admin", async () => {
    const app1 = seedApp("IXL");
    const issue = seedIssue(app1.id);
    const staff = await loginAs(STAFF);
    expect((await staff.patch(`/issues/${issue.id}`, { status: "resolved" })).status).toBe(
      403,
    );
  });

  it("rejects an invalid status", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.patch("/issues/1", { status: "nope" })).status).toBe(400);
  });

  it("returns 404 for an unknown issue", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.patch("/issues/999", { status: "resolved" })).status).toBe(404);
  });

  it("resolves an issue, logs activity, and returns the full shape", async () => {
    const term = seedTerm({ isCurrent: true });
    const app1 = seedApp("IXL");
    const issue = seedIssue(app1.id);
    const admin = await loginAs(ADMIN);
    const res = await admin.patch(`/issues/${issue.id}`, { status: "resolved" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: issue.id,
      applicationId: app1.id,
      appName: "IXL",
      userId: 2,
      reporterName: "Staff Member",
      comment: "Something broke",
      status: "resolved",
    });
    expect(typeof res.body.resolvedAt).toBe("string");
    const events = fakeDb.rows(tables.appActivityTable);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      applicationId: app1.id,
      termId: term.id,
      eventType: "issue_resolved",
      actorId: 1,
    });
    expect(events[0]!.detail).toContain("Issue resolved");
  });

  it("does not log activity when reopening or re-resolving", async () => {
    const app1 = seedApp("IXL");
    const issue = seedIssue(app1.id, { status: "resolved" });
    const admin = await loginAs(ADMIN);
    const res = await admin.patch(`/issues/${issue.id}`, { status: "open" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("open");
    expect(res.body.resolvedAt).toBeNull();
    expect(fakeDb.rows(tables.appActivityTable)).toHaveLength(0);
  });
});

describe("DELETE /api/issues/:id", () => {
  function seedIssue(applicationId: number, overrides: Record<string, unknown> = {}) {
    const issue = {
      id: ++state.idCounter,
      applicationId,
      userId: 2,
      comment: "UI check: new-marker issue",
      status: "open",
      createdAt: new Date("2026-07-01T00:00:00Z"),
      ...overrides,
    };
    fakeDb.rows(tables.appIssuesTable).push(issue);
    return issue;
  }

  it("requires admin", async () => {
    const app1 = seedApp("IXL");
    const issue = seedIssue(app1.id);
    const staff = await loginAs(STAFF);
    expect((await staff.delete(`/issues/${issue.id}`)).status).toBe(403);
  });

  it("returns 404 for an unknown issue", async () => {
    const admin = await loginAs(ADMIN);
    expect((await admin.delete("/issues/999")).status).toBe(404);
  });

  it("deletes the issue and its activity events, leaving unrelated rows", async () => {
    const app1 = seedApp("IXL");
    const issue = seedIssue(app1.id);
    fakeDb.rows(tables.appActivityTable).push(
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: null,
        eventType: "issue_reported",
        detail: "Issue reported: UI check: new-marker issue",
        actorId: 2,
        createdAt: new Date("2026-07-01T00:00:01Z"),
      },
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: null,
        eventType: "issue_resolved",
        detail: "Issue resolved: UI check: new-marker issue",
        actorId: 1,
        createdAt: new Date("2026-07-01T00:00:02Z"),
      },
      {
        id: ++state.idCounter,
        applicationId: app1.id,
        termId: null,
        eventType: "issue_reported",
        detail: "Issue reported: Something else broke",
        actorId: 2,
        createdAt: new Date("2026-07-01T00:00:03Z"),
      },
    );
    const admin = await loginAs(ADMIN);
    const res = await admin.delete(`/issues/${issue.id}`);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Issue deleted");
    expect(fakeDb.rows(tables.appIssuesTable)).toHaveLength(0);
    const events = fakeDb.rows(tables.appActivityTable);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toBe("Issue reported: Something else broke");
  });
});
