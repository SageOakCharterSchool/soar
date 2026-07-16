import { and, desc, eq, isNull } from "drizzle-orm";
import { db, syncAlertsTable, type SyncAlert } from "@workspace/db";
import { logger } from "./logger";

/**
 * Record a failed SFTP sync run as an admin-facing alert. Repeated identical
 * failures update the existing active alert (occurrences, lastSeenAt) instead
 * of creating a new row, so admins are not spammed by a nightly job failing
 * the same way every day.
 */
export async function recordSyncFailure(message: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(syncAlertsTable)
    .where(
      and(eq(syncAlertsTable.message, message), isNull(syncAlertsTable.resolvedAt)),
    )
    .limit(1);
  if (existing) {
    await db
      .update(syncAlertsTable)
      .set({
        occurrences: existing.occurrences + 1,
        lastSeenAt: new Date(),
      })
      .where(eq(syncAlertsTable.id, existing.id));
    return;
  }
  await db.insert(syncAlertsTable).values({ message });
}

/**
 * Resolve all active sync alerts after a successful sync, so stale failure
 * notifications clear themselves once the problem is fixed.
 */
export async function resolveSyncAlerts(): Promise<void> {
  await db
    .update(syncAlertsTable)
    .set({ resolvedAt: new Date(), resolvedReason: "sync_succeeded" })
    .where(isNull(syncAlertsTable.resolvedAt));
}

/** List active (unresolved) sync alerts, newest first. */
export async function listActiveSyncAlerts(): Promise<SyncAlert[]> {
  return db
    .select()
    .from(syncAlertsTable)
    .where(isNull(syncAlertsTable.resolvedAt))
    .orderBy(desc(syncAlertsTable.lastSeenAt));
}

/** Dismiss one active alert by id. Returns false if not found or resolved. */
export async function dismissSyncAlert(id: number): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(syncAlertsTable)
    .where(and(eq(syncAlertsTable.id, id), isNull(syncAlertsTable.resolvedAt)))
    .limit(1);
  if (!existing) return false;
  await db
    .update(syncAlertsTable)
    .set({ resolvedAt: new Date(), resolvedReason: "dismissed" })
    .where(eq(syncAlertsTable.id, id));
  return true;
}

/**
 * Best-effort wrapper used from the sync job: alert bookkeeping must never
 * break the sync itself.
 */
export async function safeRecordSyncOutcome(
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  try {
    if (outcome.ok) await resolveSyncAlerts();
    else await recordSyncFailure(outcome.error);
  } catch (err) {
    logger.error({ err }, "Failed to update sync alerts");
  }
}
