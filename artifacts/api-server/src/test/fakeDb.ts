/**
 * Shared in-memory fake of the drizzle-backed `@workspace/db` module for
 * integration tests. It supports the superset of query features the routes
 * and importer rely on: eq/ne/gte/lte/isNull/and/or conditions, orderBy,
 * limit, inner/left joins, groupBy with sql`count`/`sum` aggregates,
 * insert().values().returning()/onConflictDoUpdate, update, delete.
 *
 * Usage in a test file:
 *
 *   import { fakeDb, tables, state } from "../test/fakeDb";
 *   vi.mock("drizzle-orm", async () => (await import("../test/fakeDb")).drizzleOrmMock);
 *   vi.mock("@workspace/db", async () => (await import("../test/fakeDb")).dbModuleMock);
 *
 * Adding a new schema table only requires adding one `makeTable` entry to
 * `tables` below.
 */

export type Col = { name: string; table: string };
export type SqlMarker = { __sql: string; vals: unknown[] };
export type Cond =
  | { type: "eq"; col: Col; val: unknown }
  | { type: "ne"; col: Col; val: unknown }
  | { type: "gte"; col: Col; val: unknown }
  | { type: "gt"; col: Col; val: unknown }
  | { type: "lte"; col: Col; val: unknown }
  | { type: "lt"; col: Col; val: unknown }
  | { type: "isNull"; col: Col }
  | { type: "inArray"; col: Col; vals: unknown[] }
  | { type: "ilike"; col: Col; val: string }
  | { type: "and"; conds: Cond[] }
  | { type: "or"; conds: Cond[] };

export type Row = Record<string, unknown>;

function isCol(v: unknown): v is Col {
  return (
    typeof v === "object" &&
    v !== null &&
    "name" in v &&
    "table" in v &&
    typeof (v as Col).name === "string"
  );
}

export function makeTable(label: string) {
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

type RowCtx = { base: Row; byTable: Record<string, Row | null> };

function resolve(ctx: RowCtx, col: Col): unknown {
  const src = ctx.byTable[col.table];
  if (src !== undefined) return src ? src[col.name] : null;
  return ctx.base[col.name];
}

function matches(ctx: RowCtx, cond: Cond | undefined): boolean {
  if (!cond) return true;
  if (cond.type === "and") return cond.conds.every((c) => matches(ctx, c));
  if (cond.type === "or") return cond.conds.some((c) => matches(ctx, c));
  if (cond.type === "isNull") return resolve(ctx, cond.col) == null;
  if (cond.type === "inArray") return cond.vals.includes(resolve(ctx, cond.col));
  if (cond.type === "ilike") {
    const target = resolve(ctx, cond.col);
    if (target == null) return false;
    // Convert a SQL LIKE pattern (with \ escapes) to a regex.
    let re = "";
    const p = cond.val;
    for (let i = 0; i < p.length; i++) {
      const ch = p[i]!;
      if (ch === "\\" && i + 1 < p.length) {
        re += p[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      } else if (ch === "%") re += "[\\s\\S]*";
      else if (ch === "_") re += "[\\s\\S]";
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`, "i").test(String(target));
  }
  const v = resolve(ctx, cond.col) as string | number;
  const val = cond.val as string | number;
  if (cond.type === "eq") return v === val;
  if (cond.type === "ne") return v !== val;
  if (cond.type === "gte") return v >= val;
  if (cond.type === "gt") return v > val;
  if (cond.type === "lt") return v < val;
  return v <= val;
}

export const state = { idCounter: 0 };

type OrderSpec = { col: Col; dir: "asc" | "desc" } | Col;
type JoinSpec = {
  table: object;
  cond: { type: "eq"; col: Col; val: Col };
  kind: "inner" | "left";
};

class Query implements PromiseLike<Row[]> {
  constructor(
    private db: FakeDb,
    private table: object,
    private fields?: Record<string, Col | SqlMarker>,
    private distinct = false,
  ) {}

  private cond?: Cond;
  private order: OrderSpec[] = [];
  private max?: number;
  private skip = 0;
  private joins: JoinSpec[] = [];
  private groupCol?: Col;

  where(cond: Cond | undefined) {
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
  offset(n: number) {
    this.skip = n;
    return this;
  }
  innerJoin(table: object, cond: { type: "eq"; col: Col; val: Col }) {
    this.joins.push({ table, cond, kind: "inner" });
    return this;
  }
  leftJoin(table: object, cond: { type: "eq"; col: Col; val: Col }) {
    this.joins.push({ table, cond, kind: "left" });
    return this;
  }
  groupBy(col: Col) {
    this.groupCol = col;
    return this;
  }

  private run(): Row[] {
    const label = (this.table as { __label: string }).__label;
    let rows: RowCtx[] = this.db
      .rows(this.table)
      .map((r) => ({ base: r, byTable: { [label]: r } }));

    for (const join of this.joins) {
      const joinLabel = (join.table as { __label: string }).__label;
      const joinRows = this.db.rows(join.table);
      const { col, val } = join.cond;
      const joinedCol = col.table === joinLabel ? col : val;
      const otherCol = col.table === joinLabel ? val : col;
      const next: RowCtx[] = [];
      for (const ctx of rows) {
        const otherVal = resolve(ctx, otherCol);
        const match =
          joinRows.find((jr) => jr[joinedCol.name] === otherVal) ?? null;
        if (match === null && join.kind === "inner") continue;
        next.push({ ...ctx, byTable: { ...ctx.byTable, [joinLabel]: match } });
      }
      rows = next;
    }

    rows = rows.filter((ctx) => matches(ctx, this.cond));

    const hasAggregate =
      this.fields != null && Object.values(this.fields).some((f) => !isCol(f));

    let groups: RowCtx[][];
    if (!this.groupCol && hasAggregate) {
      groups = [rows];
    } else if (this.groupCol) {
      const map = new Map<unknown, RowCtx[]>();
      for (const ctx of rows) {
        const key = resolve(ctx, this.groupCol);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(ctx);
      }
      groups = [...map.values()];
    } else {
      groups = rows.map((ctx) => [ctx]);
    }

    const evalField = (group: RowCtx[], field: Col | SqlMarker): unknown => {
      if (isCol(field)) return resolve(group[0]!, field);
      const marker = field as SqlMarker;
      if (marker.__sql.includes("sum")) {
        const col = marker.vals.find(isCol) as Col | undefined;
        const scalar = marker.vals.find((v) => !isCol(v));
        if (!col) return 0;
        return group.filter((ctx) => resolve(ctx, col) === scalar).length;
      }
      return group.length;
    };

    const normalizeOrder = (spec: OrderSpec) =>
      "dir" in spec && (spec.dir === "asc" || spec.dir === "desc")
        ? (spec as { col: Col; dir: "asc" | "desc" })
        : { col: spec as Col, dir: "asc" as const };

    for (const raw of [...this.order].reverse()) {
      const spec = normalizeOrder(raw);
      groups.sort((a, b) => {
        const av = resolve(a[0]!, spec.col) as string | number;
        const bv = resolve(b[0]!, spec.col) as string | number;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return spec.dir === "desc" ? -cmp : cmp;
      });
    }
    let results = groups.map((group) => {
      // Return copies so "before" snapshots don't mutate with later updates.
      if (!this.fields) return { ...group[0]!.base };
      const out: Row = {};
      for (const [key, field] of Object.entries(this.fields)) {
        out[key] = evalField(group, field);
      }
      return out;
    });

    if (this.distinct) {
      const seen = new Set<string>();
      results = results.filter((row) => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    if (this.skip > 0) results = results.slice(this.skip);
    if (this.max != null) results = results.slice(0, this.max);
    return results;
  }

  then<T1 = Row[], T2 = never>(
    onResolve?: ((rows: Row[]) => T1 | PromiseLike<T1>) | null,
    onReject?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onResolve, onReject);
  }
}

// Column defaults applied on insert, mirroring the schema's DB defaults.
const DEFAULTS: Record<string, () => Row> = {
  users: () => ({ tags: [], createdAt: new Date() }),
  terms: () => ({ isCurrent: false }),
  appTermStatus: () => ({
    studentSharingStatus: "not_started",
    staffSharingStatus: "not_started",
    updatedAt: new Date(),
  }),
  appUpvotes: () => ({ createdAt: new Date() }),
  appIssues: () => ({ status: "open", createdAt: new Date() }),
  appActivity: () => ({ createdAt: new Date() }),
  raciTeams: () => ({ sortOrder: 0 }),
  raciMembers: () => ({ userId: null, sortOrder: 0 }),
  raciRows: () => ({ category: null, applicationId: null, sortOrder: 0 }),
  raciAssignments: () => ({}),
  appActivityArchive: () => ({ archivedAt: new Date() }),
  pageLastSeen: () => ({ lastSeenAt: new Date() }),
  syncRuns: () => ({
    ranAt: new Date(),
    importedSnapshots: [],
    skippedSnapshots: [],
    warnings: [],
    error: null,
  }),
  syncAlerts: () => ({
    occurrences: 1,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    resolvedAt: null,
    resolvedReason: null,
  }),
};

function thenable(apply: () => Row[]) {
  return {
    then<T1, T2>(
      onResolve?: ((rows: Row[]) => T1 | PromiseLike<T1>) | null,
      onReject?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
    ) {
      return Promise.resolve(apply()).then(onResolve, onReject);
    },
    returning: async (fields?: Record<string, Col>) => {
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
}

export class FakeDb {
  store = new Map<object, Row[]>();

  rows(table: object): Row[] {
    if (!this.store.has(table)) this.store.set(table, []);
    return this.store.get(table)!;
  }

  select(fields?: Record<string, Col | SqlMarker>) {
    const self = this;
    return {
      from(table: object) {
        return new Query(self, table, fields);
      },
    };
  }

  selectDistinct(fields?: Record<string, Col | SqlMarker>) {
    const self = this;
    return {
      from(table: object) {
        return new Query(self, table, fields, true);
      },
    };
  }

  insert(table: object) {
    const self = this;
    const label = (table as { __label: string }).__label;
    return {
      values: (vals: Row | Row[]) => {
        const list = Array.isArray(vals) ? vals : [vals];
        const apply = () =>
          list.map((v) => {
            const row: Row = {
              id: ++state.idCounter,
              ...(DEFAULTS[label]?.() ?? {}),
              ...v,
            };
            self.rows(table).push(row);
            return row;
          });
        return {
          ...thenable(apply),
          onConflictDoNothing: async (opts?: { target?: Col[] }) => {
            for (const v of list) {
              const targets = opts?.target ?? [];
              const existing =
                targets.length > 0
                  ? self
                      .rows(table)
                      .find((r) => targets.every((c) => r[c.name] === v[c.name]))
                  : undefined;
              if (!existing)
                self.rows(table).push({
                  id: ++state.idCounter,
                  ...(DEFAULTS[label]?.() ?? {}),
                  ...v,
                });
            }
          },
          onConflictDoUpdate: async (opts: { target: Col[]; set: Row }) => {
            for (const v of list) {
              const existing = self
                .rows(table)
                .find((r) => opts.target.every((c) => r[c.name] === v[c.name]));
              if (existing) Object.assign(existing, opts.set);
              else
                self.rows(table).push({
                  id: ++state.idCounter,
                  ...(DEFAULTS[label]?.() ?? {}),
                  ...v,
                });
            }
          },
        };
      },
    };
  }

  update(table: object) {
    const self = this;
    return {
      set: (vals: Row) => ({
        where: (cond: Cond) =>
          thenable(() => {
            const updated: Row[] = [];
            for (const row of self.rows(table)) {
              if (matches({ base: row, byTable: {} }, cond)) {
                Object.assign(row, vals);
                updated.push(row);
              }
            }
            return updated;
          }),
      }),
    };
  }

  delete(table: object) {
    const self = this;
    return {
      where: (cond: Cond) =>
        thenable(() => {
          const all = self.rows(table);
          const removed = all.filter((row) =>
            matches({ base: row, byTable: {} }, cond),
          );
          self.store.set(
            table,
            all.filter((row) => !removed.includes(row)),
          );
          return removed;
        }),
    };
  }

  async execute() {
    return { rows: [] };
  }

  // Minimal transaction support: runs the callback against the same store.
  // No rollback semantics — tests assert behavior, not atomicity.
  async transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

export const fakeDb = new FakeDb();

// One entry per schema table in @workspace/db. New tables go here (only).
export const tables = {
  usersTable: makeTable("users"),
  termsTable: makeTable("terms"),
  applicationsTable: makeTable("applications"),
  appTermStatusTable: makeTable("appTermStatus"),
  appActivityTable: makeTable("appActivity"),
  appActivityArchiveTable: makeTable("appActivityArchive"),
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
  syncRunsTable: makeTable("syncRuns"),
  syncAlertsTable: makeTable("syncAlerts"),
  sessionTable: makeTable("session"),
  raciTeamsTable: makeTable("raciTeams"),
  raciMembersTable: makeTable("raciMembers"),
  raciRowsTable: makeTable("raciRows"),
  raciAssignmentsTable: makeTable("raciAssignments"),
  appSettingsTable: makeTable("appSettings"),
};

/** Reset all fake-db state between tests. */
export function resetFakeDb() {
  fakeDb.store.clear();
  state.idCounter = 0;
}

const sqlTag = (strings: TemplateStringsArray, ...vals: unknown[]) => ({
  __sql: Array.from(strings).join("?"),
  vals,
});
sqlTag.raw = (s: string) => s;

const drizzleOrmImpl = {
  eq: (col: Col, val: unknown) => ({ type: "eq", col, val }),
  ne: (col: Col, val: unknown) => ({ type: "ne", col, val }),
  gte: (col: Col, val: unknown) => ({ type: "gte", col, val }),
  gt: (col: Col, val: unknown) => ({ type: "gt", col, val }),
  lt: (col: Col, val: unknown) => ({ type: "lt", col, val }),
  lte: (col: Col, val: unknown) => ({ type: "lte", col, val }),
  isNull: (col: Col) => ({ type: "isNull", col }),
  inArray: (col: Col, vals: unknown[]) => ({ type: "inArray", col, vals: [...vals] }),
  ilike: (col: Col, val: string) => ({ type: "ilike", col, val }),
  and: (...conds: unknown[]) => ({ type: "and", conds }),
  or: (...conds: unknown[]) => ({ type: "or", conds }),
  asc: (col: Col) => ({ col, dir: "asc" }),
  desc: (col: Col) => ({ col, dir: "desc" }),
  sql: sqlTag,
};

/**
 * Factory for `vi.mock("drizzle-orm", ...)`. Any drizzle-orm export the fake
 * doesn't implement (e.g. inArray, like, notInArray) throws a clear error
 * instead of returning undefined and silently mis-filtering rows.
 */
export const drizzleOrmMock = new Proxy(drizzleOrmImpl, {
  get(target, prop, receiver) {
    if (typeof prop === "symbol" || prop in target) {
      return Reflect.get(target, prop, receiver);
    }
    // Module-interop probes vitest/node may perform on the mocked module.
    if (prop === "default" || prop === "__esModule" || prop === "then") {
      return undefined;
    }
    throw new Error(
      `fakeDb drizzle-orm mock does not implement "${prop}". ` +
        `Add it to drizzleOrmImpl (and the Cond union / matches() if it is a ` +
        `filter operator) in artifacts/api-server/src/test/fakeDb.ts.`,
    );
  },
});

/** Factory for `vi.mock("@workspace/db", ...)`. */
export const dbModuleMock = {
  db: fakeDb,
  RACI_VALUES: ["R", "A", "C", "I", "N/A"] as const,
  ...tables,
};

/**
 * Factory for `vi.mock("connect-pg-simple", ...)`: replaces the
 * Postgres-backed session store with express-session's in-memory store so no
 * database connection is needed. express-session itself (cookie handling,
 * session persistence across requests) stays fully real.
 */
export const connectPgSimpleMock = {
  default: (session: { MemoryStore: new () => object }) =>
    class extends session.MemoryStore {
      constructor(_opts: unknown) {
        super();
      }
    },
};
