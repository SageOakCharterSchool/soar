import { lt, sql } from "drizzle-orm";
import { db, appActivityTable } from "@workspace/db";
import { logger } from "./logger";

const RETENTION_MONTHS = 12;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function pruneOldActivity(): Promise<number> {
  const cutoff = sql<Date>`now() - interval '${sql.raw(String(RETENTION_MONTHS))} months'`;
  const deleted = await db
    .delete(appActivityTable)
    .where(lt(appActivityTable.createdAt, cutoff))
    .returning({ id: appActivityTable.id });
  if (deleted.length > 0) {
    logger.info(
      { deleted: deleted.length, retentionMonths: RETENTION_MONTHS },
      "Pruned old app_activity rows",
    );
  }
  return deleted.length;
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
