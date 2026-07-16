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

  it("reports the total matching rows in X-Total-Count regardless of pagination", async () => {
    seedArchive();
    seedArchive();
    seedArchive();
    const admin = await loginAs(ADMIN);
    const res = await admin.getRaw("/rostering/activity/archive?limit=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("3");
  });

  it("X-Total-Count respects filters and is set on CSV responses", async () => {
    seedArchive({ appName: "Zoom" });
    seedArchive({ appName: "Zoom" });
    seedArchive({ appName: "Other" });
    const admin = await loginAs(ADMIN);
    const res = await admin.getRaw(
      "/rostering/activity/archive?format=csv&appName=zoom&limit=1",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
  });

  it("filters by search across app name, actor, and detail", async () => {
    const byApp = seedArchive({ appName: "Zoom", detail: "Enabled" });
    const byActor = seedArchive({ actorName: "Zoomer Admin", detail: "Other" });
    const byDetail = seedArchive({ detail: "Set up zoom rooms" });
    seedArchive({ appName: "Canva", actorName: "Jane", detail: "Nothing here" });
    const admin = await loginAs(ADMIN);
    const res = await admin.getJson("/rostering/activity/archive?search=zoom");
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.id).sort()).toEqual(
      [byApp.id, byActor.id, byDetail.id].sort(),
    );
  });

  it("filters by appName case-insensitively (exact match)", async () => {
    const zoom = seedArchive({ appName: "Zoom" });
    seedArchive({ appName: "Zoom Phone" });
    const admin = await loginAs(ADMIN);
    const res = await admin.getJson("/rostering/activity/archive?appName=zoom");
    expect(res.body.map((r: any) => r.id)).toEqual([zoom.id]);
  });

  it("filters by from/to date range", async () => {
    seedArchive({ createdAt: new Date("2022-01-01T12:00:00Z") });
    const mid = seedArchive({ createdAt: new Date("2023-06-15T12:00:00Z") });
    seedArchive({ createdAt: new Date("2024-12-01T12:00:00Z") });
    const admin = await loginAs(ADMIN);
    const res = await admin.getJson(
      "/rostering/activity/archive?from=2023-01-01&to=2023-12-31",
    );
    expect(res.body.map((r: any) => r.id)).toEqual([mid.id]);
  });

  it("to as a bare date includes the whole day", async () => {
    const lateInDay = seedArchive({ createdAt: new Date("2023-06-15T23:30:00Z") });
    const admin = await loginAs(ADMIN);
    const res = await admin.getJson("/rostering/activity/archive?to=2023-06-15");
    expect(res.body.map((r: any) => r.id)).toEqual([lateInDay.id]);
  });

  it("rejects invalid dates", async () => {
    const admin = await loginAs(ADMIN);
    const res = await admin.getJson("/rostering/activity/archive?from=not-a-date");
    expect(res.status).toBe(400);
  });

  it("supports offset pagination", async () => {
    const a = seedArchive({ createdAt: yearsAgo(4) });
    const b = seedArchive({ createdAt: yearsAgo(3) });
    const c = seedArchive({ createdAt: yearsAgo(2) });
    const admin = await loginAs(ADMIN);
    const res = await admin.getJson("/rostering/activity/archive?limit=2&offset=1");
    expect(res.body.map((r: any) => r.id)).toEqual([b.id, a.id]);
    void c;
  });

  it("applies filters to CSV export too", async () => {
    seedArchive({ appName: "Zoom", detail: "Match me" });
    seedArchive({ appName: "Canva", detail: "Not me" });
    const admin = await loginAs(ADMIN);
    const res = await admin.getRaw("/rostering/activity/archive?format=csv&search=zoom");
    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Zoom");
  });

  // Splits raw CSV text into records, respecting quoted fields that contain
  // newlines. A naive split("\n") would corrupt multiline records, which is
  // exactly the regression this guards against.
  function splitCsvRecords(text: string): string[] {
    const records: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '"') {
        inQuotes = !inQuotes;
        current += ch;
      } else if (ch === "\n" && !inQuotes) {
        records.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.length > 0) records.push(current);
    return records;
  }

  it("paged CSV export reassembles to exactly the full set, in order, with multiline and quoted details", async () => {
    // Seed 3 pages' worth (limit=10, 25 rows) with awkward detail values and
    // deliberate createdAt ties so ordering must fall back to id desc.
    const seeded: ReturnType<typeof seedArchive>[] = [];
    for (let i = 0; i < 25; i++) {
      seeded.push(
        seedArchive({
          // Adjacent pairs share a timestamp to force id-desc tiebreaks.
          createdAt: new Date(Date.UTC(2023, 0, 1 + Math.floor(i / 2))),
          detail:
            i % 3 === 0
              ? `Line one for row ${i}\nline "two", with comma\nline three`
              : i % 3 === 1
                ? `Plain detail ${i}`
                : `Has "quotes" and, commas ${i}`,
          appName: `App ${i}`,
        }),
      );
    }

    const admin = await loginAs(ADMIN);

    // Full export in one request = source of truth.
    const full = await admin.getRaw("/rostering/activity/archive?format=csv&limit=1000");
    expect(full.status).toBe(200);
    const fullRecords = splitCsvRecords(full.text);
    const header = fullRecords[0]!;
    expect(header).toBe("app,event_type,detail,actor,occurred_at,archived_at");
    expect(fullRecords).toHaveLength(1 + seeded.length);

    // Page through with limit/offset and concatenate the data records.
    const pageSize = 10;
    const paged: string[] = [];
    for (let offset = 0; offset < seeded.length; offset += pageSize) {
      const page = await admin.getRaw(
        `/rostering/activity/archive?format=csv&limit=${pageSize}&offset=${offset}`,
      );
      expect(page.status).toBe(200);
      expect(page.headers.get("x-total-count")).toBe(String(seeded.length));
      const records = splitCsvRecords(page.text);
      expect(records[0]).toBe(header);
      expect(records.length).toBeLessThanOrEqual(1 + pageSize);
      paged.push(...records.slice(1));
    }

    // Concatenated pages must equal the full export exactly: no dropped,
    // duplicated, or reordered rows.
    expect(paged).toEqual(fullRecords.slice(1));

    // And the full export must contain every seeded row exactly once, in
    // createdAt desc / id desc order.
    const expectedOrder = [...seeded]
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id,
      )
      .map((r) => r.appName);
    const exportedApps = fullRecords.slice(1).map((rec) => rec.split(",")[0]!);
    expect(exportedApps).toEqual(expectedOrder);

    // Multiline details survive quoting: raw text has more newlines than
    // records, and quoted embedded newlines are present.
    expect(full.text).toContain('"Line one for row 0\nline ""two"", with comma\nline three"');
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
