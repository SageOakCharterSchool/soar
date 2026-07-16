import SftpClient from "ssh2-sftp-client";
import { db, importLogTable } from "@workspace/db";
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

export interface SftpSyncStatus {
  configured: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastResult: SyncSummary | null;
  lastError: string | null;
}

const status: SftpSyncStatus = {
  configured: false,
  running: false,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
};

export function getSftpSyncStatus(): SftpSyncStatus {
  return { ...status, configured: getSftpConfig() !== null };
}

/** Test hook: reset in-memory sync status. */
export function resetSftpSyncStatus(): void {
  status.running = false;
  status.lastRunAt = null;
  status.lastResult = null;
  status.lastError = null;
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
 * Run one sync pass against the real SFTP server, updating the in-memory
 * status. Never throws — failures are recorded in the status and logged.
 */
export async function runSftpSync(): Promise<
  { ok: true; summary: SyncSummary } | { ok: false; error: string }
> {
  const config = getSftpConfig();
  if (!config) {
    return { ok: false, error: "SFTP is not configured" };
  }
  if (status.running) {
    return { ok: false, error: "A sync is already running" };
  }
  status.running = true;
  try {
    const client = new SftpClient();
    const summary = await syncFromSftp(client as unknown as SftpClientLike, config);
    status.lastRunAt = new Date().toISOString();
    status.lastResult = summary;
    status.lastError = null;
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
    status.lastRunAt = new Date().toISOString();
    status.lastResult = null;
    status.lastError = message;
    logger.error({ err }, "SFTP report sync failed");
    return { ok: false, error: message };
  } finally {
    status.running = false;
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
