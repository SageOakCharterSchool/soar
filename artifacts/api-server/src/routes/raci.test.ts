import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { Server } from "http";
import { fakeDb, tables, resetFakeDb } from "../test/fakeDb";

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
    const contentType = res.headers.get("content-type") ?? "";
    const parsed = contentType.includes("application/json")
      ? await res.json()
      : await res.text();
    return { status: res.status, body: parsed as any, headers: res.headers };
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
  put(path: string, body?: unknown) {
    return this.request("PUT", path, body);
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

async function loginAdmin(): Promise<Client> {
  const c = new Client();
  const res = await c.post("/auth/login", ADMIN);
  expect(res.status).toBe(200);
  return c;
}

async function loginStaff(): Promise<Client> {
  const c = new Client();
  const res = await c.post("/auth/login", STAFF);
  expect(res.status).toBe(200);
  return c;
}

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
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  );
  fakeDb.rows(tables.applicationsTable).push({
    id: 50,
    name: "Zoom",
    category: "Communication",
  });
  fakeDb.rows(tables.raciTeamsTable).push(
    { id: 10, name: "IT Leads", sortOrder: 0 },
    { id: 11, name: "Software Squad", sortOrder: 1 },
  );
  fakeDb.rows(tables.raciMembersTable).push(
    { id: 20, teamId: 10, name: "Brad", userId: null, sortOrder: 0 },
    { id: 21, teamId: 10, name: "Ash", userId: null, sortOrder: 1 },
    { id: 22, teamId: 11, name: "Katie", userId: null, sortOrder: 0 },
  );
  fakeDb.rows(tables.raciRowsTable).push(
    {
      id: 30,
      teamId: 10,
      category: "BUDGET",
      name: "Approve purchases",
      sortOrder: 0,
      applicationId: null,
    },
    {
      id: 31,
      teamId: 10,
      category: "ROSTERING",
      name: "Zoom",
      sortOrder: 1,
      applicationId: 50,
    },
  );
  fakeDb.rows(tables.raciAssignmentsTable).push(
    { id: 40, rowId: 30, memberId: 20, value: "A" },
    { id: 41, rowId: 30, memberId: 21, value: "C" },
    { id: 42, rowId: 31, memberId: 21, value: "R" },
  );
});

describe("GET /raci", () => {
  it("requires auth", async () => {
    const res = await new Client().get("/raci");
    expect(res.status).toBe(401);
  });

  it("returns teams with members, rows, app links, and assignments", async () => {
    const c = await loginStaff();
    const res = await c.get("/raci");
    expect(res.status).toBe(200);
    expect(res.body.teams).toHaveLength(2);
    const [leads, squad] = res.body.teams;
    expect(leads.name).toBe("IT Leads");
    expect(leads.members.map((m: any) => m.name)).toEqual(["Brad", "Ash"]);
    expect(leads.rows).toHaveLength(2);
    const budget = leads.rows[0];
    expect(budget.category).toBe("BUDGET");
    expect(budget.assignments).toEqual(
      expect.arrayContaining([
        { memberId: 20, value: "A" },
        { memberId: 21, value: "C" },
      ]),
    );
    const zoom = leads.rows[1];
    expect(zoom.applicationId).toBe(50);
    expect(zoom.appName).toBe("Zoom");
    expect(squad.rows).toHaveLength(0);
  });
});

describe("row management", () => {
  it("rejects writes from staff", async () => {
    const c = await loginStaff();
    const res = await c.post("/raci/rows", { teamId: 10, name: "New task" });
    expect(res.status).toBe(403);
  });

  it("creates a row, auto-links matching app, and logs activity", async () => {
    const c = await loginAdmin();
    const res = await c.post("/raci/rows", {
      teamId: 11,
      name: "zoom",
      category: "ROSTERING",
    });
    expect(res.status).toBe(200);
    expect(res.body.teamId).toBe(11);
    expect(res.body.applicationId).toBe(50);
    expect(res.body.sortOrder).toBe(1);
    const activity = fakeDb.rows(tables.appActivityTable);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.eventType).toBe("raci_change");
    expect(String(activity[0]!.detail)).toContain("zoom");
  });

  it("rejects rows for unknown teams", async () => {
    const c = await loginAdmin();
    const res = await c.post("/raci/rows", { teamId: 999, name: "X" });
    expect(res.status).toBe(400);
  });

  it("renames and recategorizes a row", async () => {
    const c = await loginAdmin();
    const res = await c.patch("/raci/rows/30", {
      name: "Approve all purchases",
      category: "FINANCE",
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Approve all purchases");
    expect(res.body.category).toBe("FINANCE");
    expect(res.body.assignments).toHaveLength(2);
  });

  it("renames a row when expectedName matches the stored name", async () => {
    const c = await loginAdmin();
    const res = await c.patch("/raci/rows/30", {
      name: "Approve all purchases",
      expectedName: "Approve purchases",
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Approve all purchases");
  });

  it("409s without overwriting when another admin renamed the row first", async () => {
    const c = await loginAdmin();
    // Stored name is "Approve purchases", but this client last saw another.
    const res = await c.patch("/raci/rows/30", {
      name: "My rename",
      expectedName: "Approve invoices",
    });
    expect(res.status).toBe(409);
    expect(res.body.currentName).toBe("Approve purchases");
    // Stored name untouched, no activity logged.
    expect(
      fakeDb.rows(tables.raciRowsTable).find((r) => r.id === 30)!.name,
    ).toBe("Approve purchases");
    expect(fakeDb.rows(tables.appActivityTable)).toHaveLength(0);
  });

  it("ignores expectedName when the name is not being changed", async () => {
    const c = await loginAdmin();
    const res = await c.patch("/raci/rows/30", {
      category: "FINANCE",
      expectedName: "Stale name",
    });
    expect(res.status).toBe(200);
    expect(res.body.category).toBe("FINANCE");
  });

  it("unlinks an application", async () => {
    const c = await loginAdmin();
    const res = await c.patch("/raci/rows/31", { applicationId: null });
    expect(res.status).toBe(200);
    expect(res.body.applicationId).toBeNull();
    expect(res.body.appName).toBeNull();
  });

  it("404s on missing rows and deletes rows with their assignments", async () => {
    const c = await loginAdmin();
    expect((await c.patch("/raci/rows/999", { name: "X" })).status).toBe(404);
    const del = await c.delete("/raci/rows/30");
    expect(del.status).toBe(200);
    expect(fakeDb.rows(tables.raciRowsTable).map((r) => r.id)).toEqual([31]);
    expect(
      fakeDb.rows(tables.raciAssignmentsTable).filter((a) => a.rowId === 30),
    ).toHaveLength(0);
  });
});

describe("member management", () => {
  it("adds a member and rejects duplicates", async () => {
    const c = await loginAdmin();
    const res = await c.post("/raci/members", { teamId: 10, name: "Jordan" });
    expect(res.status).toBe(200);
    expect(res.body.sortOrder).toBe(2);
    const dup = await c.post("/raci/members", { teamId: 10, name: "  brad " });
    expect(dup.status).toBe(400);
  });

  it("renames a member", async () => {
    const c = await loginAdmin();
    const res = await c.patch("/raci/members/20", { name: "Bradley" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Bradley");
  });

  it("renames a member when expectedName matches the stored name", async () => {
    const c = await loginAdmin();
    const res = await c.patch("/raci/members/20", {
      name: "Bradley",
      expectedName: "Brad",
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Bradley");
  });

  it("409s without overwriting when another admin renamed the member first", async () => {
    const c = await loginAdmin();
    const res = await c.patch("/raci/members/20", {
      name: "My rename",
      expectedName: "Bradley",
    });
    expect(res.status).toBe(409);
    expect(res.body.currentName).toBe("Brad");
    expect(
      fakeDb.rows(tables.raciMembersTable).find((m) => m.id === 20)!.name,
    ).toBe("Brad");
    expect(fakeDb.rows(tables.appActivityTable)).toHaveLength(0);
  });

  it("deletes a member along with their assignments", async () => {
    const c = await loginAdmin();
    const res = await c.delete("/raci/members/21");
    expect(res.status).toBe(200);
    expect(
      fakeDb.rows(tables.raciAssignmentsTable).filter((a) => a.memberId === 21),
    ).toHaveLength(0);
  });
});

describe("PUT /raci/cells", () => {
  it("sets, updates, and clears a cell", async () => {
    const c = await loginAdmin();
    let res = await c.put("/raci/cells", { rowId: 31, memberId: 20, value: "I" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rowId: 31, memberId: 20, value: "I" });

    res = await c.put("/raci/cells", { rowId: 31, memberId: 20, value: "A" });
    expect(res.body.value).toBe("A");

    res = await c.put("/raci/cells", { rowId: 31, memberId: 20, value: null });
    expect(res.body.value).toBeNull();
    expect(
      fakeDb
        .rows(tables.raciAssignmentsTable)
        .filter((a) => a.rowId === 31 && a.memberId === 20),
    ).toHaveLength(0);
    // Three changes → three activity entries.
    expect(fakeDb.rows(tables.appActivityTable)).toHaveLength(3);
  });

  it("accepts writes when expectedValue matches the stored value", async () => {
    const c = await loginAdmin();
    // Cell (30, 20) currently holds "A".
    const res = await c.put("/raci/cells", {
      rowId: 30,
      memberId: 20,
      value: "R",
      expectedValue: "A",
    });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe("R");

    // Empty cell: expectedValue null matches.
    const empty = await c.put("/raci/cells", {
      rowId: 31,
      memberId: 20,
      value: "I",
      expectedValue: null,
    });
    expect(empty.status).toBe(200);
  });

  it("409s without overwriting when another admin changed the cell first", async () => {
    const c = await loginAdmin();
    // Cell (30, 20) holds "A", but this client last saw "C" — concurrent edit.
    const res = await c.put("/raci/cells", {
      rowId: 30,
      memberId: 20,
      value: "R",
      expectedValue: "C",
    });
    expect(res.status).toBe(409);
    expect(res.body.currentValue).toBe("A");
    // The stored value is untouched and no activity was logged.
    expect(
      fakeDb
        .rows(tables.raciAssignmentsTable)
        .find((a) => a.rowId === 30 && a.memberId === 20)!.value,
    ).toBe("A");
    expect(fakeDb.rows(tables.appActivityTable)).toHaveLength(0);

    // Expecting a value where the cell is empty also conflicts.
    const emptyConflict = await c.put("/raci/cells", {
      rowId: 31,
      memberId: 20,
      value: "R",
      expectedValue: "I",
    });
    expect(emptyConflict.status).toBe(409);
    expect(emptyConflict.body.currentValue).toBeNull();
  });

  it("still allows writes without expectedValue (backwards compatible)", async () => {
    const c = await loginAdmin();
    const res = await c.put("/raci/cells", { rowId: 30, memberId: 20, value: "I" });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe("I");
  });

  it("rejects members from another team and invalid values", async () => {
    const c = await loginAdmin();
    const wrongTeam = await c.put("/raci/cells", {
      rowId: 30,
      memberId: 22,
      value: "R",
    });
    expect(wrongTeam.status).toBe(404);
    const badValue = await c.put("/raci/cells", {
      rowId: 30,
      memberId: 20,
      value: "X",
    });
    expect(badValue.status).toBe(400);
  });
});

describe("POST /raci/teams/:id/rename-category", () => {
  it("renames all rows in the category", async () => {
    const c = await loginAdmin();
    const res = await c.post("/raci/teams/10/rename-category", {
      from: "BUDGET",
      to: "FINANCE",
    });
    expect(res.status).toBe(200);
    expect(
      fakeDb.rows(tables.raciRowsTable).find((r) => r.id === 30)!.category,
    ).toBe("FINANCE");
  });

  it("409s when the category no longer exists (renamed by another admin)", async () => {
    const c = await loginAdmin();
    const res = await c.post("/raci/teams/10/rename-category", {
      from: "NOPE",
      to: "X",
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("another admin");
    // No rows were touched and nothing was logged.
    expect(
      fakeDb.rows(tables.raciRowsTable).find((r) => r.id === 30)!.category,
    ).toBe("BUDGET");
    expect(fakeDb.rows(tables.appActivityTable)).toHaveLength(0);
  });
});

describe("GET /raci/teams/:id/export", () => {
  it("returns CSV for the team", async () => {
    const c = await loginStaff();
    const res = await c.get("/raci/teams/10/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = String(res.body).trim().split("\n");
    expect(lines[0]).toBe("Category,Decision or Task,Brad,Ash");
    expect(lines[1]).toBe("BUDGET,Approve purchases,A,C");
    expect(lines[2]).toBe("ROSTERING,Zoom,,R");
  });

  it("404s for unknown teams", async () => {
    const c = await loginStaff();
    const res = await c.get("/raci/teams/999/export");
    expect(res.status).toBe(404);
  });
});

describe("rostering board RACI people", () => {
  it("surfaces linked RACI people on board rows", async () => {
    fakeDb.rows(tables.termsTable).push({ id: 70, name: "Fall", isCurrent: true });
    fakeDb.rows(tables.appTermStatusTable).push({
      id: 71,
      applicationId: 50,
      termId: 70,
      studentSharingStatus: "not_started",
      staffSharingStatus: "not_started",
      updatedAt: new Date(),
    });
    const c = await loginStaff();
    const res = await c.get("/rostering/board?termId=70");
    expect(res.status).toBe(200);
    const zoom = res.body.find((r: any) => r.applicationId === 50);
    expect(zoom.raci).toEqual([{ name: "Ash", value: "R" }]);
  });
});
