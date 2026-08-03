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
  delete(path: string) {
    return this.request("DELETE", path);
  }
}

const ADMIN = { email: "admin@sageoak.org", password: "test-admin-pw" };
const ADMIN2 = { email: "admin2@sageoak.org", password: "test-admin2-pw" };
const STAFF = { email: "staff@sageoak.org", password: "test-staff-pw" };

let adminHash: string;
let admin2Hash: string;
let staffHash: string;

beforeAll(async () => {
  adminHash = await bcrypt.hash(ADMIN.password, 4);
  admin2Hash = await bcrypt.hash(ADMIN2.password, 4);
  staffHash = await bcrypt.hash(STAFF.password, 4);
});

function seedUsers({ secondAdmin = false }: { secondAdmin?: boolean } = {}) {
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
  if (secondAdmin) {
    fakeDb.rows(tables.usersTable).push({
      id: 3,
      email: ADMIN2.email,
      passwordHash: admin2Hash,
      displayName: "Second Admin",
      role: "admin",
      tags: [],
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });
  }
  state.idCounter = 10;
}

beforeEach(() => {
  resetFakeDb();
});

async function loginAs(creds: { email: string; password: string }): Promise<Client> {
  const client = new Client();
  const res = await client.post("/auth/login", creds);
  expect(res.status).toBe(200);
  return client;
}

describe("DELETE /api/auth/account", () => {
  it("requires authentication", async () => {
    seedUsers();
    const client = new Client();
    const res = await client.delete("/auth/account");
    expect(res.status).toBe(401);
  });

  it("lets a staff user delete their own account and ends the session", async () => {
    seedUsers();
    const client = await loginAs(STAFF);
    const res = await client.delete("/auth/account");
    expect(res.status).toBe(200);

    // User row is gone.
    const users = fakeDb.rows(tables.usersTable);
    expect(users.find((u: any) => u.email === STAFF.email)).toBeUndefined();

    // Session is dead: /auth/me now says not logged in.
    const me = await client.get("/auth/me");
    expect(me.status).toBe(401);
  });

  it("records an account_self_deleted activity event with the user's name", async () => {
    seedUsers();
    const client = await loginAs(STAFF);
    const res = await client.delete("/auth/account");
    expect(res.status).toBe(200);

    const events = fakeDb
      .rows(tables.appActivityTable)
      .filter((e: any) => e.eventType === "account_self_deleted");
    expect(events).toHaveLength(1);
    expect(events[0].detail).toContain("Staff Member");
    expect(events[0].detail).toContain(STAFF.email);
  });

  it("blocks the last remaining admin from deleting their own account", async () => {
    seedUsers();
    const client = await loginAs(ADMIN);
    const res = await client.delete("/auth/account");
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/only admin/i);

    // Account still exists and session still works.
    const users = fakeDb.rows(tables.usersTable);
    expect(users.find((u: any) => u.email === ADMIN.email)).toBeDefined();
    const me = await client.get("/auth/me");
    expect(me.status).toBe(200);
  });

  it("lets an admin delete their own account when another admin exists", async () => {
    seedUsers({ secondAdmin: true });
    const client = await loginAs(ADMIN);
    const res = await client.delete("/auth/account");
    expect(res.status).toBe(200);

    const users = fakeDb.rows(tables.usersTable);
    expect(users.find((u: any) => u.email === ADMIN.email)).toBeUndefined();
    expect(users.find((u: any) => u.email === ADMIN2.email)).toBeDefined();
  });
});
