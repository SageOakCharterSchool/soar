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

  it("rejects staff users", async () => {
    const client = await loginAs(STAFF);
    const res = await client.get("/settings");
    expect(res.status).toBe(403);
  });

  it("returns full defaults when nothing is stored", async () => {
    const client = await loginAs(ADMIN);
    const res = await client.get("/settings");
    expect(res.status).toBe(200);
    expect(res.body.staleOpenDays).toBe(7);
    expect(res.body.sharingStatusOptions.map((o: any) => o.value)).toEqual([
      "not_started",
      "in_progress",
      "complete",
      "needs_review",
    ]);
    expect(res.body.raciValueOptions.map((o: any) => o.value)).toEqual([
      "R",
      "A",
      "C",
      "I",
      "N/A",
    ]);
    expect(res.body.syncSchedule).toEqual({ enabled: true, time: "02:00" });
    expect(res.body.branding).toEqual({
      appName: "Sage Oak",
      logoDataUrl: null,
      accentColor: null,
    });
    expect(res.body.notifications).toEqual({
      syncFailureBannerEnabled: true,
      alertOnSyncWarnings: false,
      recipients: [],
    });
  });

  it("returns the stored threshold", async () => {
    fakeDb.rows(tables.appSettingsTable).push({
      key: "staleOpenDays",
      value: "14",
      updatedAt: new Date(),
    });
    const client = await loginAs(ADMIN);
    const res = await client.get("/settings");
    expect(res.body.staleOpenDays).toBe(14);
  });

  it("falls back to the default when the stored value is invalid", async () => {
    fakeDb.rows(tables.appSettingsTable).push(
      { key: "staleOpenDays", value: "not-a-number", updatedAt: new Date() },
      { key: "syncSchedule", value: "{broken json", updatedAt: new Date() },
      { key: "branding", value: JSON.stringify({ accentColor: "purple" }), updatedAt: new Date() },
    );
    const client = await loginAs(ADMIN);
    const res = await client.get("/settings");
    expect(res.body.staleOpenDays).toBe(7);
    expect(res.body.syncSchedule).toEqual({ enabled: true, time: "02:00" });
    expect(res.body.branding.accentColor).toBeNull();
  });
});

describe("GET /settings/public", () => {
  it("requires authentication", async () => {
    const res = await new Client().get("/settings/public");
    expect(res.status).toBe(401);
  });

  it("returns only the safe subset to staff users", async () => {
    fakeDb.rows(tables.appSettingsTable).push({
      key: "notifications",
      value: JSON.stringify({
        syncFailureBannerEnabled: false,
        alertOnSyncWarnings: true,
        recipients: ["admin@sageoak.org"],
      }),
      updatedAt: new Date(),
    });
    const client = await loginAs(STAFF);
    const res = await client.get("/settings/public");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "branding",
      "raciValueOptions",
      "sharingStatusOptions",
      "staleOpenDays",
      "syncFailureBannerEnabled",
    ]);
    expect(res.body.syncFailureBannerEnabled).toBe(false);
    expect(res.body.staleOpenDays).toBe(7);
    expect(res.body.branding.appName).toBe("Sage Oak");
    // Admin-only data must never leak here.
    expect(res.body.notifications).toBeUndefined();
    expect(res.body.syncSchedule).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("admin@sageoak.org");
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

  it("lets admins persist a new threshold and returns the full settings object", async () => {
    const client = await loginAs(ADMIN);
    const res = await client.put("/settings", { staleOpenDays: 21 });
    expect(res.status).toBe(200);
    expect(res.body.staleOpenDays).toBe(21);
    expect(res.body.branding.appName).toBe("Sage Oak");
    const read = await client.get("/settings");
    expect(read.body.staleOpenDays).toBe(21);
  });

  it("updates an existing stored threshold instead of duplicating it", async () => {
    const client = await loginAs(ADMIN);
    await client.put("/settings", { staleOpenDays: 3 });
    await client.put("/settings", { staleOpenDays: 30 });
    expect(fakeDb.rows(tables.appSettingsTable)).toHaveLength(1);
    const read = await client.get("/settings");
    expect(read.body.staleOpenDays).toBe(30);
  });

  it.each([0, -5, 366, 1.5, "abc", null])(
    "rejects invalid value %p",
    async (value) => {
      const client = await loginAs(ADMIN);
      const res = await client.put("/settings", { staleOpenDays: value });
      expect(res.status).toBe(400);
    },
  );

  it("persists edited sharing status options", async () => {
    const client = await loginAs(ADMIN);
    const options = [
      { value: "not_started", label: "Not begun", active: true },
      { value: "done", label: "Done", active: true },
      { value: "in_progress", label: "In progress", active: false },
    ];
    const res = await client.put("/settings", { sharingStatusOptions: options });
    expect(res.status).toBe(200);
    expect(res.body.sharingStatusOptions).toEqual(options);
    const read = await client.get("/settings");
    expect(read.body.sharingStatusOptions).toEqual(options);
  });

  it.each<[unknown[], string]>([
    [[], "empty list"],
    [[{ value: "a", label: "A" }], "missing active flag"],
    [
      [
        { value: "a", label: "A", active: true },
        { value: "A", label: "Dup", active: true },
      ],
      "duplicate values",
    ],
    [[{ value: "a", label: "A", active: false }], "no active options"],
    [[{ value: "", label: "A", active: true }], "blank value"],
  ])("rejects invalid option lists (%#: %s)", async (options) => {
    const client = await loginAs(ADMIN);
    const res = await client.put("/settings", { sharingStatusOptions: options });
    expect(res.status).toBe(400);
    const raci = await client.put("/settings", { raciValueOptions: options });
    expect(raci.status).toBe(400);
  });

  it("persists a sync schedule and rejects bad times", async () => {
    const client = await loginAs(ADMIN);
    const ok = await client.put("/settings", {
      syncSchedule: { enabled: false, time: "23:45" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.syncSchedule).toEqual({ enabled: false, time: "23:45" });
    for (const time of ["24:00", "9:5", "abc", ""]) {
      const bad = await client.put("/settings", {
        syncSchedule: { enabled: true, time },
      });
      expect(bad.status).toBe(400);
    }
  });

  it("persists branding and validates its fields", async () => {
    const client = await loginAs(ADMIN);
    const logo = `data:image/png;base64,${"A".repeat(100)}`;
    const ok = await client.put("/settings", {
      branding: { appName: "  Oak Portal  ", logoDataUrl: logo, accentColor: "#4a7c67" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.branding).toEqual({
      appName: "Oak Portal",
      logoDataUrl: logo,
      accentColor: "#4a7c67",
    });

    expect(
      (
        await client.put("/settings", {
          branding: { appName: "", logoDataUrl: null, accentColor: null },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.put("/settings", {
          branding: { appName: "X", logoDataUrl: null, accentColor: "purple" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.put("/settings", {
          branding: { appName: "X", logoDataUrl: "not-a-data-url", accentColor: null },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.put("/settings", {
          branding: {
            appName: "X",
            logoDataUrl: `data:image/png;base64,${"A".repeat(400_001)}`,
            accentColor: null,
          },
        })
      ).status,
    ).toBe(400);
  });

  it("persists notification settings and validates recipients", async () => {
    const client = await loginAs(ADMIN);
    const ok = await client.put("/settings", {
      notifications: {
        syncFailureBannerEnabled: false,
        alertOnSyncWarnings: true,
        recipients: ["ops@sageoak.org", " admin@sageoak.org "],
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.notifications).toEqual({
      syncFailureBannerEnabled: false,
      alertOnSyncWarnings: true,
      recipients: ["ops@sageoak.org", "admin@sageoak.org"],
    });

    const badEmail = await client.put("/settings", {
      notifications: {
        syncFailureBannerEnabled: true,
        alertOnSyncWarnings: false,
        recipients: ["not-an-email"],
      },
    });
    expect(badEmail.status).toBe(400);

    const malformed = await client.put("/settings", {
      notifications: { syncFailureBannerEnabled: "yes" },
    });
    expect(malformed.status).toBe(400);
  });

  it("applies multiple sections in one request and leaves others untouched", async () => {
    const client = await loginAs(ADMIN);
    const res = await client.put("/settings", {
      staleOpenDays: 10,
      syncSchedule: { enabled: true, time: "04:30" },
    });
    expect(res.status).toBe(200);
    expect(res.body.staleOpenDays).toBe(10);
    expect(res.body.syncSchedule).toEqual({ enabled: true, time: "04:30" });
    expect(res.body.branding.appName).toBe("Sage Oak");
    // A 400 on one section must not partially apply another.
    const bad = await client.put("/settings", {
      staleOpenDays: 20,
      syncSchedule: { enabled: true, time: "bad" },
    });
    expect(bad.status).toBe(400);
    const read = await client.get("/settings");
    expect(read.body.staleOpenDays).toBe(10);
  });
});
