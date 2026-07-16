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
import { getRaciPeopleByApp } from "./raciPeople";

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
    return { status: res.status, body: parsed as any };
  }

  get(path: string) {
    return this.request("GET", path);
  }
  post(path: string, body?: unknown) {
    return this.request("POST", path, body);
  }
}

const STAFF = { email: "staff@sageoak.org", password: "test-staff-pw" };
let staffHash: string;

beforeAll(async () => {
  staffHash = await bcrypt.hash(STAFF.password, 4);
});

async function loginStaff(): Promise<Client> {
  const c = new Client();
  const res = await c.post("/auth/login", STAFF);
  expect(res.status).toBe(200);
  return c;
}

beforeEach(() => {
  resetFakeDb();
  fakeDb.rows(tables.usersTable).push({
    id: 1,
    email: STAFF.email,
    passwordHash: staffHash,
    displayName: "Staff Member",
    role: "staff",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  // Three apps, each with its own RACI owners.
  fakeDb.rows(tables.applicationsTable).push(
    { id: 50, name: "Zoom", category: "Communication" },
    { id: 51, name: "Canva", category: "Design" },
    { id: 52, name: "Kahoot", category: "Games" },
  );
  fakeDb.rows(tables.raciTeamsTable).push({ id: 10, name: "IT Leads", sortOrder: 0 });
  fakeDb.rows(tables.raciMembersTable).push(
    { id: 20, teamId: 10, name: "Brad", userId: null, sortOrder: 0 },
    { id: 21, teamId: 10, name: "Ash", userId: null, sortOrder: 1 },
    { id: 22, teamId: 10, name: "Katie", userId: null, sortOrder: 2 },
  );
  fakeDb.rows(tables.raciRowsTable).push(
    { id: 30, teamId: 10, category: "ROSTERING", name: "Zoom", sortOrder: 0, applicationId: 50 },
    { id: 31, teamId: 10, category: "ROSTERING", name: "Canva", sortOrder: 1, applicationId: 51 },
    { id: 32, teamId: 10, category: "ROSTERING", name: "Kahoot", sortOrder: 2, applicationId: 52 },
  );
  fakeDb.rows(tables.raciAssignmentsTable).push(
    // Zoom: Brad accountable, Ash responsible.
    { id: 40, rowId: 30, memberId: 20, value: "A" },
    { id: 41, rowId: 30, memberId: 21, value: "R" },
    // Canva: Katie responsible, Brad N/A (must be excluded).
    { id: 42, rowId: 31, memberId: 22, value: "R" },
    { id: 43, rowId: 31, memberId: 20, value: "N/A" },
    // Kahoot: Ash accountable — outside the requested subset in tests below.
    { id: 44, rowId: 32, memberId: 21, value: "A" },
  );
});

describe("getRaciPeopleByApp filtering", () => {
  it("returns owners only for the requested apps", async () => {
    const map = await getRaciPeopleByApp([50, 51]);
    expect([...map.keys()].sort()).toEqual([50, 51]);
    expect(map.get(50)).toEqual([
      { name: "Brad", value: "A" },
      { name: "Ash", value: "R" },
    ]);
    expect(map.get(51)).toEqual([{ name: "Katie", value: "R" }]);
    // App outside the requested list gets none.
    expect(map.has(52)).toBe(false);
  });

  it("does not mix owners between apps for a single-app request", async () => {
    const map = await getRaciPeopleByApp([52]);
    expect([...map.keys()]).toEqual([52]);
    expect(map.get(52)).toEqual([{ name: "Ash", value: "A" }]);
  });

  it("returns an empty map for an empty id list", async () => {
    const map = await getRaciPeopleByApp([]);
    expect(map.size).toBe(0);
  });

  it("returns all apps when no filter is supplied", async () => {
    const map = await getRaciPeopleByApp();
    expect([...map.keys()].sort()).toEqual([50, 51, 52]);
  });
});

describe("GET /issues raci arrays", () => {
  it("includes the correct raci people per app", async () => {
    fakeDb.rows(tables.appIssuesTable).push(
      {
        id: 60,
        applicationId: 50,
        userId: 1,
        comment: "Zoom is down",
        status: "open",
        createdAt: new Date("2026-07-01T00:00:00Z"),
        resolvedAt: null,
      },
      {
        id: 61,
        applicationId: 51,
        userId: 1,
        comment: "Canva login broken",
        status: "open",
        createdAt: new Date("2026-07-02T00:00:00Z"),
        resolvedAt: null,
      },
    );
    const c = await loginStaff();
    const res = await c.get("/issues");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const zoom = res.body.find((i: any) => i.applicationId === 50);
    const canva = res.body.find((i: any) => i.applicationId === 51);
    expect(zoom.raci).toEqual([
      { name: "Brad", value: "A" },
      { name: "Ash", value: "R" },
    ]);
    expect(canva.raci).toEqual([{ name: "Katie", value: "R" }]);
    // Kahoot's owner never bleeds into other apps' issues.
    expect(zoom.raci).not.toContainEqual({ name: "Ash", value: "A" });
    expect(canva.raci).not.toContainEqual({ name: "Ash", value: "A" });
  });

  it("returns an empty raci array for an app with no RACI assignments", async () => {
    fakeDb.rows(tables.applicationsTable).push({
      id: 53,
      name: "Padlet",
      category: "Other",
    });
    fakeDb.rows(tables.appIssuesTable).push({
      id: 62,
      applicationId: 53,
      userId: 1,
      comment: "Padlet issue",
      status: "open",
      createdAt: new Date("2026-07-03T00:00:00Z"),
      resolvedAt: null,
    });
    const c = await loginStaff();
    const res = await c.get("/issues");
    expect(res.status).toBe(200);
    const padlet = res.body.find((i: any) => i.applicationId === 53);
    expect(padlet.raci).toEqual([]);
  });
});
