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
import { pruneOldActivity, retentionCutoff } from "../lib/activityRetention";

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
    return res;
  }

  async getJson(path: string) {
    const res = await this.request("GET", path);
    return { status: res.status, body: (await res.json()) as any };
  }
  async getRaw(path: string) {
    const res = await this.request("GET", path);
    return { status: res.status, text: await res.text(), headers: res.headers };
  }
  async post(path: string, body?: unknown) {
    const res = await this.request("POST", path, body);
    return { status: res.status, body: (await res.json()) as any };
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

function seedApp(name: string) {
  const app = { id: ++state.idCounter, name, category: null, createdAt: new Date() };
  fakeDb.rows(tables.applicationsTable).push(app);
  return app;
}

function seedActivity(applicationId: number, createdAt: Date, detail = "Something changed") {
  const row = {
    id: ++state.idCounter,
    applicationId,
    termId: null,
    eventType: "status_change",
    detail,
    actorId: 1,
    createdAt,
  };
  fakeDb.rows(tables.appActivityTable).push(row);
  return row;
}

function yearsAgo(n: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d;
}

describe("pruneOldActivity archiving", () => {
  it("copies old rows to the archive before deleting them", async () => {
    const app1 = seedApp("Old App");
    const oldRow = seedActivity(app1.id, yearsAgo(2), "Two years old");
    const freshRow = seedActivity(app1.id, new Date(), "Fresh");

    const count = await pruneOldActivity();
    expect(count).toBe(1);

    const remaining = fakeDb.rows(tables.appActivityTable);
    expect(remaining.map((r) => r.id)).toEqual([freshRow.id]);

    const archived = fakeDb.rows(tables.appActivityArchiveTable);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      originalId: oldRow.id,
      applicationId: app1.id,
      appName: "Old App",
      detail: "Two years old",
      actorName: "Administrator",
    });
    expect(archived[0]!.archivedAt).toBeInstanceOf(Date);
  });

  it("does nothing when no rows are older than the cutoff", async () => {
    const app1 = seedApp("App");
    seedActivity(app1.id, new Date());
    expect(await pruneOldActivity()).toBe(0);
    expect(fakeDb.rows(tables.appActivityArchiveTable)).toHaveLength(0);
    expect(fakeDb.rows(tables.appActivityTable)).toHaveLength(1);
  });

  it("does not duplicate archive rows when run twice over the same data", async () => {
    const app1 = seedApp("App");
    const oldRow = seedActivity(app1.id, yearsAgo(3));
    await pruneOldActivity();
    // Simulate a re-run where the delete failed the first time.
    fakeDb.rows(tables.appActivityTable).push({ ...oldRow });
    await pruneOldActivity();
    expect(fakeDb.rows(tables.appActivityArchiveTable)).toHaveLength(1);
  });

  it("cutoff is 12 months before now", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    expect(retentionCutoff(now).toISOString()).toBe("2025-07-16T12:00:00.000Z");
  });
});

describe("GET /api/rostering/activity/archive", () => {
  function seedArchive(overrides: Record<string, unknown> = {}) {
    const row = {
      id: ++state.idCounter,
      originalId: state.idCounter + 1000,
      applicationId: 99,
      appName: "Archived App",
      termId: null,
      eventType: "status_change",
      detail: "Old change",
      actorId: null,
      actorName: "Someone",
      createdAt: yearsAgo(2),
      archivedAt: new Date(),
      ...overrides,
    };
    fakeDb.rows(tables.appActivityArchiveTable).push(row);
    return row;
  }

  it("requires login", async () => {
    const res = await new Client().getJson("/rostering/activity/archive");
    expect(res.status).toBe(401);
  });

  it("is admin-only", async () => {
    const staff = await loginAs(STAFF);
    const res = await staff.getJson("/rostering/activity/archive");
    expect(res.status).toBe(403);
  });

  it("returns archived events newest first", async () => {
    const older = seedArchive({ createdAt: yearsAgo(3), detail: "Older" });
    const newer = seedArchive({ createdAt: yearsAgo(2), detail: "Newer" });
    const admin = await loginAs(ADMIN);
    const res = await admin.getJson("/rostering/activity/archive");
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.id)).toEqual([newer.id, older.id]);
    expect(res.body[0]).toMatchObject({
      appName: "Archived App",
      detail: "Newer",
      actorName: "Someone",
    });
    expect(typeof res.body[0].createdAt).toBe("string");
    expect(typeof res.body[0].archivedAt).toBe("string");
  });

  it("respects the limit parameter", async () => {
    seedArchive();
    seedArchive();
    seedArchive();
    const admin = await loginAs(ADMIN);
    const res = await admin.getJson("/rostering/activity/archive?limit=2");
    expect(res.body).toHaveLength(2);
  });

  it("exports CSV with format=csv", async () => {
    seedArchive({ detail: 'Has "quotes", and commas' });
    const admin = await loginAs(ADMIN);
    const res = await admin.getRaw("/rostering/activity/archive?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("activity-archive.csv");
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toBe("app,event_type,detail,actor,occurred_at,archived_at");
    expect(lines[1]).toContain('"Has ""quotes"", and commas"');
  });
});
