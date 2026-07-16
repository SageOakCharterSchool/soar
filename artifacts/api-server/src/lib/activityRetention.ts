import { eq, lt } from "drizzle-orm";
import {
  db,
  appActivityTable,
  appActivityArchiveTable,
  applicationsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./logger";

const RETENTION_MONTHS = 12;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function retentionCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  return cutoff;
}

/**
 * Copies app_activity rows older than the retention window into
 * app_activity_archive (denormalized with app/actor names), then deletes the
 * originals. Rows are only deleted after their archive copy is written, so a
 * failure mid-run never loses history.
 */
export async function pruneOldActivity(): Promise<number> {
  const cutoff = retentionCutoff();

  const oldRows = await db
    .select({
      id: appActivityTable.id,
      applicationId: appActivityTable.applicationId,
      appName: applicationsTable.name,
      termId: appActivityTable.termId,
      eventType: appActivityTable.eventType,
      detail: appActivityTable.detail,
      actorId: appActivityTable.actorId,
      actorName: usersTable.displayName,
      createdAt: appActivityTable.createdAt,
    })
    .from(appActivityTable)
    // Left join: RACI change events may not be tied to an application.
    .leftJoin(applicationsTable, eq(appActivityTable.applicationId, applicationsTable.id))
    .leftJoin(usersTable, eq(appActivityTable.actorId, usersTable.id))
    .where(lt(appActivityTable.createdAt, cutoff));

  if (oldRows.length === 0) return 0;

  for (const row of oldRows) {
    await db
      .insert(appActivityArchiveTable)
      .values({
        originalId: row.id,
        applicationId: row.applicationId,
        appName: row.appName ?? "RACI",
        termId: row.termId,
        eventType: row.eventType,
        detail: row.detail,
        actorId: row.actorId,
        actorName: row.actorName,
        createdAt: row.createdAt,
      })
      .onConflictDoNothing({ target: [appActivityArchiveTable.originalId] });
    await db.delete(appActivityTable).where(eq(appActivityTable.id, row.id));
  }

  logger.info(
    { archived: oldRows.length, retentionMonths: RETENTION_MONTHS },
    "Archived and pruned old app_activity rows",
  );
  return oldRows.length;
}

export function startActivityRetentionJob(): void {
  const run = () =>
    pruneOldActivity().catch((err) => {
      logger.error({ err }, "Activity retention pruning failed");
    });
  void run();
  const timer = setInterval(run, RUN_INTERVAL_MS);
  timer.unref();
}
