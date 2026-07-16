import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, appSettingsTable } from "@workspace/db";
import { UpdateAppSettingsBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../lib/auth";

const router: IRouter = Router();

export const STALE_OPEN_DAYS_KEY = "staleOpenDays";
export const DEFAULT_STALE_OPEN_DAYS = 7;

async function readStaleOpenDays(): Promise<number> {
  const [row] = await db
    .select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, STALE_OPEN_DAYS_KEY));
  if (!row) return DEFAULT_STALE_OPEN_DAYS;
  const parsed = parseInt(row.value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
    return DEFAULT_STALE_OPEN_DAYS;
  }
  return parsed;
}

router.get("/settings", requireAuth, async (_req, res): Promise<void> => {
  res.json({ staleOpenDays: await readStaleOpenDays() });
});

router.put("/settings", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdateAppSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ message: "staleOpenDays must be a whole number between 1 and 365" });
    return;
  }
  if (!Number.isInteger(parsed.data.staleOpenDays)) {
    res
      .status(400)
      .json({ message: "staleOpenDays must be a whole number between 1 and 365" });
    return;
  }
  await db
    .insert(appSettingsTable)
    .values({
      key: STALE_OPEN_DAYS_KEY,
      value: String(parsed.data.staleOpenDays),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [appSettingsTable.key],
      set: { value: String(parsed.data.staleOpenDays), updatedAt: new Date() },
    });
  res.json({ staleOpenDays: parsed.data.staleOpenDays });
});

export default router;
