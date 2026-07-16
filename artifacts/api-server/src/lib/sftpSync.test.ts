import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeDb, tables, resetFakeDb } from "../test/fakeDb";

vi.mock("drizzle-orm", async () => (await import("../test/fakeDb")).drizzleOrmMock);
vi.mock("@workspace/db", async () => (await import("../test/fakeDb")).dbModuleMock);

import {
  getSftpConfig,
  getSftpSyncStatus,
  listRemoteBatches,
  syncFromSftp,
  type SftpClientLike,
  type SftpConfig,
} from "./sftpSync";

const CONFIG: SftpConfig = {
  host: "reports-sftp.clever.com",
  port: 22,
  username: "district",
  password: "secret",
  remoteDir: "/",
};

const EXPORT_PROPS = "Property,Value\nExport_date,2026-06-30\nTime_range,Last 28 days\n";
const EXPORT_PROPS_JULY = "Property,Value\nExport_date,2026-07-14\nTime_range,Last 28 days\n";
const KEY_METRICS = "Metric,Value\nUnique Students,120\nUnique Teachers,15\n";

type RemoteFs = Record<string, Record<string, string>>;

function makeMockClient(fs: RemoteFs) {
  const calls = { connect: 0, end: 0, gets: [] as string[] };
  const client: SftpClientLike = {
    async connect() {
      calls.connect += 1;
      return undefined;
    },
    async list(remotePath: string) {
      const norm = remotePath.replace(/\/+$/, "") || "/";
      const dir = fs[norm];
      if (!dir) throw new Error(`No such dir: ${remotePath}`);
      const entries: Array<{ name: string; type: string }> = Object.keys(dir).map(
        (name) => ({ name, type: "-" }),
      );
      const prefix = norm === "/" ? "/" : `${norm}/`;
      for (const key of Object.keys(fs)) {
        if (key !== norm && key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          entries.push({ name: key.slice(prefix.length), type: "d" });
        }
      }
      return entries;
    },
    async get(remotePath: string) {
      calls.gets.push(remotePath);
      const idx = remotePath.lastIndexOf("/");
      const dir = remotePath.slice(0, idx) || "/";
      const name = remotePath.slice(idx + 1);
      const content = fs[dir]?.[name];
      if (content === undefined) throw new Error(`No such file: ${remotePath}`);
      return Buffer.from(content, "utf8");
    },
    async end() {
      calls.end += 1;
      return undefined;
    },
  };
  return { client, calls };
}

beforeEach(() => {
  resetFakeDb();
  delete process.env["SFTP_HOST"];
  delete process.env["SFTP_PORT"];
  delete process.env["SFTP_USERNAME"];
  delete process.env["SFTP_PASSWORD"];
  delete process.env["SFTP_REMOTE_DIR"];
});

describe("getSftpConfig", () => {
  it("returns null when credentials are not set", () => {
    expect(getSftpConfig()).toBeNull();
    process.env["SFTP_HOST"] = "reports-sftp.clever.com";
    expect(getSftpConfig()).toBeNull();
  });

  it("returns config with defaults when credentials are set", () => {
    process.env["SFTP_HOST"] = "reports-sftp.clever.com";
    process.env["SFTP_USERNAME"] = "u";
    process.env["SFTP_PASSWORD"] = "p";
    expect(getSftpConfig()).toEqual({
      host: "reports-sftp.clever.com",
      port: 22,
      username: "u",
      password: "p",
      remoteDir: "/",
    });
  });

  it("rejects an invalid port", () => {
    process.env["SFTP_HOST"] = "h";
    process.env["SFTP_USERNAME"] = "u";
    process.env["SFTP_PASSWORD"] = "p";
    process.env["SFTP_PORT"] = "abc";
    expect(() => getSftpConfig()).toThrow(/SFTP_PORT/);
  });
});

describe("listRemoteBatches", () => {
  it("finds root-level CSVs and dated subdirectories", async () => {
    const { client } = makeMockClient({
      "/": { "ExportProperties.csv": EXPORT_PROPS, "readme.txt": "hi" },
      "/2026-07-14": { "ExportProperties.csv": EXPORT_PROPS_JULY, "KeyMetrics.csv": KEY_METRICS },
      "/empty": {},
    });
    const batches = await listRemoteBatches(client, "/");
    expect(batches).toHaveLength(2);
    expect(batches[0]!.fileNames).toEqual(["ExportProperties.csv"]);
    expect(batches[1]!.label).toBe("2026-07-14");
    expect(batches[1]!.fileNames).toContain("KeyMetrics.csv");
  });
});

describe("syncFromSftp", () => {
  it("imports new snapshots through the import pipeline with source sftp", async () => {
    const { client, calls } = makeMockClient({
      "/": {},
      "/2026-06-30": {
        "ExportProperties.csv": EXPORT_PROPS,
        "KeyMetrics.csv": KEY_METRICS,
      },
    });
    const summary = await syncFromSftp(client, CONFIG);
    expect(summary.importedSnapshots).toEqual(["2026-06-30"]);
    expect(summary.skippedSnapshots).toEqual([]);
    const log = fakeDb.rows(tables.importLogTable);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      snapshotDate: "2026-06-30",
      source: "sftp",
      uploadedBy: null,
    });
    const metrics = fakeDb.rows(tables.usageKeyMetricsTable);
    expect(metrics[0]).toMatchObject({ snapshotDate: "2026-06-30", uniqueStudents: 120 });
    expect(calls.connect).toBe(1);
    expect(calls.end).toBe(1);
  });

  it("skips snapshots already in the import log without downloading the batch", async () => {
    fakeDb.rows(tables.importLogTable).push(
      {
        id: 1,
        uploadedBy: 7,
        snapshotDate: "2026-06-30",
        filesIncluded: ["ExportProperties.csv"],
        source: "upload",
        rowsInserted: 1,
        rowsUpdated: 0,
        uploadedAt: new Date(),
      },
    );
    const { client, calls } = makeMockClient({
      "/": {},
      "/2026-06-30": {
        "ExportProperties.csv": EXPORT_PROPS,
        "KeyMetrics.csv": KEY_METRICS,
      },
    });
    const summary = await syncFromSftp(client, CONFIG);
    expect(summary.importedSnapshots).toEqual([]);
    expect(summary.skippedSnapshots).toEqual(["2026-06-30"]);
    // Only ExportProperties should have been downloaded to check the date.
    expect(calls.gets).toEqual(["/2026-06-30/ExportProperties.csv"]);
    expect(fakeDb.rows(tables.importLogTable)).toHaveLength(1);
  });

  it("is idempotent across repeated runs", async () => {
    const fs: RemoteFs = {
      "/": {},
      "/2026-06-30": {
        "ExportProperties.csv": EXPORT_PROPS,
        "KeyMetrics.csv": KEY_METRICS,
      },
    };
    const first = await syncFromSftp(makeMockClient(fs).client, CONFIG);
    expect(first.importedSnapshots).toEqual(["2026-06-30"]);
    const second = await syncFromSftp(makeMockClient(fs).client, CONFIG);
    expect(second.importedSnapshots).toEqual([]);
    expect(second.skippedSnapshots).toEqual(["2026-06-30"]);
    expect(fakeDb.rows(tables.importLogTable)).toHaveLength(1);
  });

  it("imports multiple new batches and warns about unusable ones", async () => {
    const { client } = makeMockClient({
      "/": {},
      "/2026-06-30": {
        "ExportProperties.csv": EXPORT_PROPS,
        "KeyMetrics.csv": KEY_METRICS,
      },
      "/2026-07-14": {
        "ExportProperties.csv": EXPORT_PROPS_JULY,
      },
      "/broken": { "KeyMetrics.csv": KEY_METRICS },
      "/baddate": { "ExportProperties.csv": "Property,Value\nFoo,Bar\n" },
    });
    const summary = await syncFromSftp(client, CONFIG);
    expect(summary.importedSnapshots.sort()).toEqual(["2026-06-30", "2026-07-14"]);
    expect(summary.warnings.some((w) => w.includes("broken"))).toBe(true);
    expect(summary.warnings.some((w) => w.includes("baddate"))).toBe(true);
    expect(fakeDb.rows(tables.importLogTable)).toHaveLength(2);
  });

  it("warns when the server has no CSV files at all", async () => {
    const { client, calls } = makeMockClient({ "/": { "readme.txt": "hi" } });
    const summary = await syncFromSftp(client, CONFIG);
    expect(summary.importedSnapshots).toEqual([]);
    expect(summary.warnings[0]).toMatch(/No CSV report files/);
    expect(calls.end).toBe(1);
  });

  it("builds status from persisted sync runs so it survives restarts", async () => {
    fakeDb.rows(tables.syncRunsTable).push(
      {
        id: 1,
        ranAt: new Date("2026-07-14T02:00:00Z"),
        ok: true,
        importedSnapshots: ["2026-07-13"],
        skippedSnapshots: [],
        warnings: [],
        error: null,
      },
      {
        id: 2,
        ranAt: new Date("2026-07-15T02:00:00Z"),
        ok: true,
        importedSnapshots: [],
        skippedSnapshots: ["2026-07-13"],
        warnings: [],
        error: null,
      },
    );
    const status = await getSftpSyncStatus();
    expect(status.lastRunAt).toBe("2026-07-15T02:00:00.000Z");
    expect(status.lastResult).toEqual({
      importedSnapshots: [],
      skippedSnapshots: ["2026-07-13"],
      warnings: [],
    });
    expect(status.lastError).toBeNull();
    expect(status.recentRuns).toHaveLength(2);
    expect(status.recentRuns[0]!.id).toBe(2);
    expect(status.recentRuns[1]!.importedSnapshots).toEqual(["2026-07-13"]);
  });

  it("surfaces a failed run's error from the persisted history", async () => {
    fakeDb.rows(tables.syncRunsTable).push({
      id: 1,
      ranAt: new Date("2026-07-15T02:00:00Z"),
      ok: false,
      importedSnapshots: [],
      skippedSnapshots: [],
      warnings: [],
      error: "connection refused",
    });
    const status = await getSftpSyncStatus();
    expect(status.lastError).toBe("connection refused");
    expect(status.lastResult).toBeNull();
    expect(status.recentRuns[0]!.ok).toBe(false);
  });

  it("reports empty status when no runs are persisted", async () => {
    const status = await getSftpSyncStatus();
    expect(status.lastRunAt).toBeNull();
    expect(status.lastResult).toBeNull();
    expect(status.lastError).toBeNull();
    expect(status.recentRuns).toEqual([]);
  });

  it("closes the connection even when listing fails", async () => {
    const calls = { end: 0 };
    const client: SftpClientLike = {
      connect: async () => undefined,
      list: async () => {
        throw new Error("boom");
      },
      get: async () => Buffer.from(""),
      end: async () => {
        calls.end += 1;
        return undefined;
      },
    };
    await expect(syncFromSftp(client, CONFIG)).rejects.toThrow("boom");
    expect(calls.end).toBe(1);
  });
});
