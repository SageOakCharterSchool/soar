import SftpClient from "ssh2-sftp-client";
import { desc } from "drizzle-orm";
import { db, importLogTable, syncRunsTable } from "@workspace/db";
import { logger } from "./logger";
import {
  classifyFile,
  extractSnapshotInfo,
  runImport,
  type UploadedFile,
} from "./importer";

const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  remoteDir: string;
}

export function getSftpConfig(): SftpConfig | null {
  const host = process.env["SFTP_HOST"];
  const username = process.env["SFTP_USERNAME"];
  const password = process.env["SFTP_PASSWORD"];
  if (!host || !username || !password) return null;
  const rawPort = process.env["SFTP_PORT"];
  const port = rawPort ? Number(rawPort) : 22;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid SFTP_PORT value: "${rawPort}"`);
  }
  return {
    host,
    port,
    username,
    password,
    remoteDir: process.env["SFTP_REMOTE_DIR"] ?? "/",
  };
}

// Minimal surface of ssh2-sftp-client that the sync uses; tests provide a
// mock implementing this interface.
export interface SftpClientLike {
  connect(opts: {
    host: string;
    port: number;
    username: string;
    password: string;
  }): Promise<unknown>;
  list(remotePath: string): Promise<Array<{ name: string; type: string }>>;
  get(remotePath: string): Promise<unknown>;
  end(): Promise<unknown>;
}

export interface SyncSummary {
  importedSnapshots: string[];
  skippedSnapshots: string[];
  warnings: string[];
}

export interface SftpSyncRun {
  id: number;
  ranAt: string;
  ok: boolean;
  importedSnapshots: string[];
  skippedSnapshots: string[];
  warnings: string[];
  error: string | null;
}

export interface SftpSyncStatus {
  configured: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastResult: SyncSummary | null;
  lastError: string | null;
  recentRuns: SftpSyncRun[];
}

const RECENT_RUNS_LIMIT = 20;

// Only the "currently running" flag lives in memory; run history is
// persisted in the sync_runs table so it survives restarts.
let syncRunning = false;

/**
 * Build the sync status from the persisted run history so the last run's
 * time/result/error survive server restarts.
 */
export async function getSftpSyncStatus(): Promise<SftpSyncStatus> {
  const rows = await db
    .select()
    .from(syncRunsTable)
    .orderBy(desc(syncRunsTable.ranAt), desc(syncRunsTable.id))
    .limit(RECENT_RUNS_LIMIT);
  const recentRuns: SftpSyncRun[] = rows.map((r) => ({
    id: r.id,
    ranAt: r.ranAt.toISOString(),
    ok: r.ok,
    importedSnapshots: r.importedSnapshots,
    skippedSnapshots: r.skippedSnapshots,
    warnings: r.warnings,
    error: r.error,
  }));
  const last = recentRuns[0] ?? null;
  return {
    configured: getSftpConfig() !== null,
    running: syncRunning,
    lastRunAt: last ? last.ranAt : null,
    lastResult:
      last && last.ok
        ? {
            importedSnapshots: last.importedSnapshots,
            skippedSnapshots: last.skippedSnapshots,
            warnings: last.warnings,
          }
        : null,
    lastError: last ? last.error : null,
    recentRuns,
  };
}

/** Test hook: reset the in-memory running flag. */
export function resetSftpSyncStatus(): void {
  syncRunning = false;
}

async function recordSyncRun(run: {
  ok: boolean;
  summary: SyncSummary | null;
  error: string | null;
}): Promise<void> {
  try {
    await db.insert(syncRunsTable).values({
      ranAt: new Date(),
      ok: run.ok,
      importedSnapshots: run.summary?.importedSnapshots ?? [],
      skippedSnapshots: run.summary?.skippedSnapshots ?? [],
      warnings: run.summary?.warnings ?? [],
      error: run.error,
    });
  } catch (err) {
    logger.error({ err }, "Failed to record SFTP sync run in the database");
  }
}

function joinRemote(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

interface RemoteBatch {
  label: string;
  dir: string;
  fileNames: string[];
}

/**
 * Discover report batches on the SFTP server: CSV files directly in the
 * remote directory form one batch, and each first-level subdirectory
 * containing CSV files forms its own batch (Clever publishes each report
 * export in a dated folder).
 */
export async function listRemoteBatches(
  client: SftpClientLike,
  remoteDir: string,
): Promise<RemoteBatch[]> {
  const entries = await client.list(remoteDir);
  const batches: RemoteBatch[] = [];
  const rootCsvs = entries
    .filter((e) => e.type === "-" && /\.csv$/i.test(e.name))
    .map((e) => e.name);
  if (rootCsvs.length > 0) {
    batches.push({ label: remoteDir, dir: remoteDir, fileNames: rootCsvs });
  }
  for (const entry of entries.filter((e) => e.type === "d")) {
    const dir = joinRemote(remoteDir, entry.name);
    const subEntries = await client.list(dir);
    const csvs = subEntries
      .filter((e) => e.type === "-" && /\.csv$/i.test(e.name))
      .map((e) => e.name);
    if (csvs.length > 0) {
      batches.push({ label: entry.name, dir, fileNames: csvs });
    }
  }
  return batches;
}

async function getFileContent(
  client: SftpClientLike,
  remotePath: string,
): Promise<string> {
  const data = await client.get(remotePath);
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  throw new Error(`Unexpected SFTP get() result for ${remotePath}`);
}

/**
 * Core sync orchestration: list remote batches, work out which snapshots
 * are new (by Export_date vs the import log), download those, and run them
 * through the shared import pipeline with source "sftp". Idempotent —
 * snapshots whose Export_date already appears in the import log are skipped.
 */
export async function syncFromSftp(
  client: SftpClientLike,
  config: SftpConfig,
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    importedSnapshots: [],
    skippedSnapshots: [],
    warnings: [],
  };
  await client.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
  });
  try {
    const batches = await listRemoteBatches(client, config.remoteDir);
    if (batches.length === 0) {
      summary.warnings.push("No CSV report files found on the SFTP server.");
      return summary;
    }
    const existingLog = await db.select().from(importLogTable);
    const importedDates = new Set(existingLog.map((r) => r.snapshotDate));

    for (const batch of batches) {
      const exportPropsName = batch.fileNames.find(
        (n) => classifyFile(n) === "exportProperties",
      );
      if (!exportPropsName) {
        summary.warnings.push(
          `Skipped "${batch.label}": no ExportProperties.csv found.`,
        );
        continue;
      }
      const propsContent = await getFileContent(
        client,
        joinRemote(batch.dir, exportPropsName),
      );
      const { snapshotDate } = extractSnapshotInfo(propsContent);
      if (!snapshotDate) {
        summary.warnings.push(
          `Skipped "${batch.label}": could not read Export_date from ExportProperties.csv.`,
        );
        continue;
      }
      if (importedDates.has(snapshotDate)) {
        summary.skippedSnapshots.push(snapshotDate);
        continue;
      }

      const files: UploadedFile[] = [
        { name: exportPropsName, content: propsContent },
      ];
      for (const name of batch.fileNames) {
        if (name === exportPropsName) continue;
        files.push({
          name,
          content: await getFileContent(client, joinRemote(batch.dir, name)),
        });
      }
      const outcome = await runImport(files, null, "sftp");
      if ("error" in outcome) {
        summary.warnings.push(`Import failed for "${batch.label}": ${outcome.error}`);
        continue;
      }
      importedDates.add(snapshotDate);
      summary.importedSnapshots.push(snapshotDate);
      summary.warnings.push(
        ...outcome.warnings.map((w) => `${batch.label}: ${w}`),
      );
    }
    return summary;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Run one sync pass against the real SFTP server, persisting the outcome to
 * the sync_runs table. Never throws — failures are recorded and logged.
 */
export async function runSftpSync(): Promise<
  { ok: true; summary: SyncSummary } | { ok: false; error: string }
> {
  const config = getSftpConfig();
  if (!config) {
    return { ok: false, error: "SFTP is not configured" };
  }
  if (syncRunning) {
    return { ok: false, error: "A sync is already running" };
  }
  syncRunning = true;
  try {
    const client = new SftpClient();
    const summary = await syncFromSftp(client as unknown as SftpClientLike, config);
    await recordSyncRun({ ok: true, summary, error: null });
    logger.info(
      {
        imported: summary.importedSnapshots,
        skipped: summary.skippedSnapshots.length,
        warnings: summary.warnings,
      },
      "SFTP report sync finished",
    );
    return { ok: true, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSyncRun({ ok: false, summary: null, error: message });
    logger.error({ err }, "SFTP report sync failed");
    return { ok: false, error: message };
  } finally {
    syncRunning = false;
  }
}

export function startSftpSyncJob(): void {
  if (!getSftpConfig()) {
    logger.info(
      "SFTP sync not configured (set SFTP_HOST, SFTP_USERNAME, SFTP_PASSWORD to enable)",
    );
    return;
  }
  const run = () =>
    runSftpSync().catch((err) => {
      logger.error({ err }, "SFTP sync job crashed unexpectedly");
    });
  void run();
  const timer = setInterval(run, RUN_INTERVAL_MS);
  timer.unref();
}
