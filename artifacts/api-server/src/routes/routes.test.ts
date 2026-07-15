import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { Server } from "http";

type Col = { name: string; table: string };
type Cond =
  | { type: "eq"; col: Col; val: unknown }
  | { type: "gte"; col: Col; val: unknown }
  | { type: "lte"; col: Col; val: unknown }
  | { type: "and"; conds: Cond[] };

const { fakeDb, tables, state } = vi.hoisted(() => {
  type HCol = { name: string; table: string };
  type HCond =
    | { type: "eq"; col: HCol; val: unknown }
    | { type: "gte"; col: HCol; val: unknown }
    | { type: "lte"; col: HCol; val: unknown }
    | { type: "and"; conds: HCond[] };
  type Row = Record<string, unknown>;

  function matches(row: Row, cond: HCond | undefined): boolean {
    if (!cond) return true;
    if (cond.type === "and") return cond.conds.every((c) => matches(row, c));
    const v = row[cond.col.name] as string | number;
    const val = cond.val as string | number;
    if (cond.type === "eq") return v === val;
    if (cond.type === "gte") return v >= val;
    return v <= val;
  }

  function makeTable(label: string) {
    return new Proxy(
      { __label: label },
      {
        get(_target, prop: string) {
          if (prop === "__label") return label;
          return { name: prop, table: label };
        },
      },
    );
  }

  const state = { idCounter: 0 };

  type OrderSpec = { col: HCol; dir: "asc" | "desc" };

  class Query implements PromiseLike<Row[]> {
    constructor(
      private db: FakeDb,
      private table: object,
      private fields?: Record<string, HCol>,
    ) {}

    private cond?: HCond;
    private order: OrderSpec[] = [];
    private max?: number;
    private join?: { table: object; on: { left: HCol; right: HCol } };

    where(cond: HCond | undefined) {
      this.cond = cond;
      return this;
    }
    orderBy(...specs: OrderSpec[]) {
      this.order = specs;
      return this;
    }
    limit(n: number) {
      this.max = n;
      return this;
    }
    leftJoin(table: object, on: { type: "eq"; col: HCol; val: HCol }) {
      this.join = { table, on: { left: on.col, right: on.val } };
      return this;
    }

    private run(): Row[] {
      const label = (this.table as { __label: string }).__label;
      let rows: { byTable: Record<string, Row | null>; base: Row }[] = this.db
        .rows(this.table)
        .map((r) => ({ base: r, byTable: { [label]: r } }));
      if (this.join) {
        const joinLabel = (this.join.table as { __label: string }).__label;
        const joinRows = this.db.rows(this.join.table);
        const { left, right } = this.join.on;
        rows = rows.map((r) => {
          const leftVal =
            left.table === label ? r.base[left.name] : undefined;
          const match =
            joinRows.find((jr) =>
              left.table === label
                ? jr[right.name] === leftVal
                : jr[left.name] === r.base[right.name],
            ) ?? null;
          return { ...r, byTable: { ...r.byTable, [joinLabel]: match } };
        });
      }
      rows = rows.filter((r) => matches(r.base, this.cond));
      for (const spec of [...this.order].reverse()) {
        rows.sort((a, b) => {
          const av = a.base[spec.col.name] as string | number;
          const bv = b.base[spec.col.name] as string | number;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return spec.dir === "desc" ? -cmp : cmp;
        });
      }
      if (this.max != null) rows = rows.slice(0, this.max);
      return rows.map((r) => {
        if (!this.fields) return r.base;
        const out: Row = {};
        for (const [key, col] of Object.entries(this.fields)) {
          const src = r.byTable[col.table];
          out[key] = src ? src[col.name] : null;
        }
        return out;
      });
    }

    then<T1 = Row[], T2 = never>(
      resolve?: ((rows: Row[]) => T1 | PromiseLike<T1>) | null,
      reject?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
  }

  class FakeDb {
    store = new Map<object, Row[]>();

    rows(table: object): Row[] {
      if (!this.store.has(table)) this.store.set(table, []);
      return this.store.get(table)!;
    }

    select(fields?: Record<string, HCol>) {
      const self = this;
      return {
        from(table: object) {
          return new Query(self, table, fields);
        },
      };
    }

    insert(table: object) {
      const self = this;
      return {
        values: (vals: Row | Row[]) => {
          const list = Array.isArray(vals) ? vals : [vals];
          const apply = () =>
            list.map((v) => {
              const row: Row = { id: ++state.idCounter, ...v };
              self.rows(table).push(row);
              return row;
            });
          return {
            then<T1, T2>(
              resolve?: ((rows: Row[]) => T1 | PromiseLike<T1>) | null,
              reject?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
            ) {
              return Promise.resolve(apply()).then(resolve, reject);
            },
            returning: async (fields?: Record<string, HCol>) => {
              const rows = apply();
              if (!fields) return rows;
              return rows.map((row) => {
                const out: Row = {};
                for (const [key, col] of Object.entries(fields)) {
                  out[key] = row[col.name];
                }
                return out;
              });
            },
          };
        },
      };
    }

    update(table: object) {
      const self = this;
      return {
        set: (vals: Row) => ({
          where: async (cond: HCond) => {
            for (const row of self.rows(table)) {
              if (matches(row, cond)) Object.assign(row, vals);
            }
          },
        }),
      };
    }

    async execute() {
      return { rows: [] };
    }
  }

  const fakeDb = new FakeDb();

  const tables = {
    usersTable: makeTable("users"),
    termsTable: makeTable("terms"),
    applicationsTable: makeTable("applications"),
    appTermStatusTable: makeTable("appTermStatus"),
    appActivityTable: makeTable("appActivity"),
    appUpvotesTable: makeTable("appUpvotes"),
    appIssuesTable: makeTable("appIssues"),
    pageLastSeenTable: makeTable("pageLastSeen"),
    usageKeyMetricsTable: makeTable("usageKeyMetrics"),
    usageByAppTable: makeTable("usageByApp"),
    usageBySchoolTable: makeTable("usageBySchool"),
    usageByDeviceTable: makeTable("usageByDevice"),
    usageByBrowserTable: makeTable("usageByBrowser"),
    usageByLoginMethodTable: makeTable("usageByLoginMethod"),
    usageAdditionalResourcesTable: makeTable("usageAdditionalResources"),
    usageAppListTable: makeTable("usageAppList"),
    usageDailyStudentTable: makeTable("usageDailyStudent"),
    usageDailyTeacherTable: makeTable("usageDailyTeacher"),
    importLogTable: makeTable("importLog"),
    feedbackTable: makeTable("feedback"),
  };

  return { fakeDb, tables, state };
});

vi.mock("drizzle-orm", () => ({
  eq: (col: Col, val: unknown): Cond => ({ type: "eq", col, val }),
  gte: (col: Col, val: unknown): Cond => ({ type: "gte", col, val }),
  lte: (col: Col, val: unknown): Cond => ({ type: "lte", col, val }),
  and: (...conds: Cond[]): Cond => ({ type: "and", conds }),
  asc: (col: Col) => ({ col, dir: "asc" }),
  desc: (col: Col) => ({ col, dir: "desc" }),
  sql: () => ({}),
}));

vi.mock("@workspace/db", () => ({
  db: fakeDb,
  ...tables,
}));

// Replace the Postgres-backed session store with express-session's in-memory
// store so no database connection is needed. express-session itself (cookie
// handling, session persistence across requests) stays fully real.
vi.mock("connect-pg-simple", () => ({
  default: (session: { MemoryStore: new () => object }) =>
    class extends session.MemoryStore {
      constructor(_opts: unknown) {
        super();
      }
    },
}));

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
  fakeDb.store.clear();
  state.idCounter = 0;
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
});
