import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeDb, tables, resetFakeDb } from "../test/fakeDb";

vi.mock("drizzle-orm", async () => (await import("../test/fakeDb")).drizzleOrmMock);
vi.mock("@workspace/db", async () => (await import("../test/fakeDb")).dbModuleMock);

import {
  recordSyncFailure,
  resolveSyncAlerts,
  listActiveSyncAlerts,
  dismissSyncAlert,
  safeRecordSyncOutcome,
} from "./syncAlerts";

beforeEach(() => {
  resetFakeDb();
});

describe("recordSyncFailure", () => {
  it("creates an alert for a new failure", async () => {
    await recordSyncFailure("Connection refused");
    const alerts = await listActiveSyncAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ message: "Connection refused", occurrences: 1 });
  });

  it("does not spam: repeated identical failures update the existing alert", async () => {
    await recordSyncFailure("Connection refused");
    await recordSyncFailure("Connection refused");
    await recordSyncFailure("Connection refused");
    const alerts = await listActiveSyncAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.occurrences).toBe(3);
  });

  it("creates separate alerts for different failure messages", async () => {
    await recordSyncFailure("Connection refused");
    await recordSyncFailure("Authentication failed");
    const alerts = await listActiveSyncAlerts();
    expect(alerts).toHaveLength(2);
  });

  it("creates a fresh alert if the previous identical one was resolved", async () => {
    await recordSyncFailure("Connection refused");
    await resolveSyncAlerts();
    await recordSyncFailure("Connection refused");
    const active = await listActiveSyncAlerts();
    expect(active).toHaveLength(1);
    expect(active[0]!.occurrences).toBe(1);
    expect(fakeDb.rows(tables.syncAlertsTable)).toHaveLength(2);
  });
});

describe("resolveSyncAlerts", () => {
  it("clears all active alerts after a successful sync", async () => {
    await recordSyncFailure("Connection refused");
    await recordSyncFailure("Authentication failed");
    await resolveSyncAlerts();
    expect(await listActiveSyncAlerts()).toHaveLength(0);
    const rows = fakeDb.rows(tables.syncAlertsTable);
    expect(rows.every((r) => r["resolvedReason"] === "sync_succeeded")).toBe(true);
  });
});

describe("dismissSyncAlert", () => {
  it("dismisses an active alert", async () => {
    await recordSyncFailure("Connection refused");
    const [alert] = await listActiveSyncAlerts();
    expect(await dismissSyncAlert(alert!.id)).toBe(true);
    expect(await listActiveSyncAlerts()).toHaveLength(0);
    expect(fakeDb.rows(tables.syncAlertsTable)[0]).toMatchObject({
      resolvedReason: "dismissed",
    });
  });

  it("returns false for unknown or already-resolved alerts", async () => {
    expect(await dismissSyncAlert(999)).toBe(false);
    await recordSyncFailure("x");
    const [alert] = await listActiveSyncAlerts();
    await dismissSyncAlert(alert!.id);
    expect(await dismissSyncAlert(alert!.id)).toBe(false);
  });
});

describe("safeRecordSyncOutcome", () => {
  it("records failures and resolves on success", async () => {
    await safeRecordSyncOutcome({ ok: false, error: "boom" });
    expect(await listActiveSyncAlerts()).toHaveLength(1);
    await safeRecordSyncOutcome({ ok: true });
    expect(await listActiveSyncAlerts()).toHaveLength(0);
  });
});
