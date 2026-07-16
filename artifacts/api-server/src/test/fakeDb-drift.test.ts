/**
 * Guard test: the shared fake database (`fakeDb.ts`) must stay in sync with
 * the real `@workspace/db` schema. If a table is added to the schema but not
 * to the fake's `tables` map (or vice versa), tests elsewhere would silently
 * mock `@workspace/db` with a missing export. This test fails loudly instead.
 *
 * Note: this file must NOT vi.mock("@workspace/db") — it imports the real
 * schema module (which does not open a database connection).
 */
import { describe, expect, it } from "vitest";
import { Table } from "drizzle-orm";
import * as realSchema from "@workspace/db/schema";
import { tables as fakeTables, drizzleOrmMock } from "./fakeDb";

const realTableExports = Object.entries(realSchema)
  .filter(([, value]) => value instanceof Table)
  .map(([name]) => name)
  .sort();

const fakeTableExports = Object.keys(fakeTables).sort();

describe("fakeDb schema drift guard", () => {
  it("fake db mocks every table exported by the real @workspace/db schema", () => {
    const missingFromFake = realTableExports.filter(
      (name) => !fakeTableExports.includes(name),
    );
    expect(
      missingFromFake,
      `These tables are exported by the real @workspace/db schema but missing ` +
        `from the shared fake (artifacts/api-server/src/test/fakeDb.ts). ` +
        `Add a makeTable entry for each to the \`tables\` map: ` +
        missingFromFake.join(", "),
    ).toEqual([]);
  });

  it("fake db has no stale tables that no longer exist in the real schema", () => {
    const staleInFake = fakeTableExports.filter(
      (name) => !realTableExports.includes(name),
    );
    expect(
      staleInFake,
      `These tables exist in the shared fake (artifacts/api-server/src/test/` +
        `fakeDb.ts) but are not exported by the real @workspace/db schema. ` +
        `Remove them from the \`tables\` map: ` +
        staleInFake.join(", "),
    ).toEqual([]);
  });

  it("sanity: the real schema exports at least one table", () => {
    expect(realTableExports.length).toBeGreaterThan(0);
  });
});

describe("fakeDb drizzle-orm operator guard", () => {
  it("throws a clear error naming an unsupported operator", () => {
    expect(
      () => (drizzleOrmMock as Record<string, unknown>).notInArray,
    ).toThrowError(/does not implement "notInArray"/);
  });

  it("still returns implemented operators", () => {
    expect(typeof (drizzleOrmMock as Record<string, unknown>).eq).toBe(
      "function",
    );
  });

  it("tolerates module-interop probes without throwing", () => {
    const mock = drizzleOrmMock as Record<string, unknown>;
    expect(mock.default).toBeUndefined();
    expect(mock.__esModule).toBeUndefined();
    expect(mock.then).toBeUndefined();
  });
});
