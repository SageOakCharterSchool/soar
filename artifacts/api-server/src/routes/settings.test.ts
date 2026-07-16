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
    return { status: res.status, body: (await res.json()) as any };
  }

  get(path: string) {
    return this.request("GET", path);
  }
  post(path: string, body?: unknown) {
    return this.request("POST", path, body);
  }
  put(path: string, body?: unknown) {
    return this.request("PUT", path, body);
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
      createdAt: new Date(),
    },
    {
      id: 2,
      email: STAFF.email,
      passwordHash: staffHash,
      displayName: "Staff Member",
      role: "staff",
      createdAt: new Date(),
    },
  );
});

async function loginAs(creds: { email: string; password: string }) {
  const client = new Client();
  const res = await client.post("/auth/login", creds);
  expect(res.status).toBe(200);
  return client;
}

describe("GET /settings", () => {
  it("requires authentication", async () => {
    const res = await new Client().get("/settings");
    expect(res.status).toBe(401);
  });

  it("returns the default stale-open threshold when nothing is stored", async () => {
    const client = await loginAs(STAFF);
    const res = await client.get("/settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ staleOpenDays: 7 });
  });

  it("returns the stored threshold", async () => {
    fakeDb.rows(tables.appSettingsTable).push({
      key: "staleOpenDays",
      value: "14",
      updatedAt: new Date(),
    });
    const client = await loginAs(STAFF);
    const res = await client.get("/settings");
    expect(res.body).toEqual({ staleOpenDays: 14 });
  });

  it("falls back to the default when the stored value is invalid", async () => {
    fakeDb.rows(tables.appSettingsTable).push({
      key: "staleOpenDays",
      value: "not-a-number",
      updatedAt: new Date(),
    });
    const client = await loginAs(STAFF);
    const res = await client.get("/settings");
    expect(res.body).toEqual({ staleOpenDays: 7 });
  });
});

describe("PUT /settings", () => {
  it("rejects staff users", async () => {
    const client = await loginAs(STAFF);
    const res = await client.put("/settings", { staleOpenDays: 10 });
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await new Client().put("/settings", { staleOpenDays: 10 });
    expect(res.status).toBe(401);
  });

  it("lets admins persist a new threshold", async () => {
    const client = await loginAs(ADMIN);
    const res = await client.put("/settings", { staleOpenDays: 21 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ staleOpenDays: 21 });
    const read = await client.get("/settings");
    expect(read.body).toEqual({ staleOpenDays: 21 });
  });

  it("updates an existing stored threshold instead of duplicating it", async () => {
    const client = await loginAs(ADMIN);
    await client.put("/settings", { staleOpenDays: 3 });
    await client.put("/settings", { staleOpenDays: 30 });
    expect(fakeDb.rows(tables.appSettingsTable)).toHaveLength(1);
    const read = await client.get("/settings");
    expect(read.body).toEqual({ staleOpenDays: 30 });
  });

  it.each([0, -5, 366, 1.5, "abc", null])(
    "rejects invalid value %p",
    async (value) => {
      const client = await loginAs(ADMIN);
      const res = await client.put("/settings", { staleOpenDays: value });
      expect(res.status).toBe(400);
    },
  );
});
