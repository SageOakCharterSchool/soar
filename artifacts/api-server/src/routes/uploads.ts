import { Router, type IRouter, type Request } from "express";
import { desc, eq } from "drizzle-orm";
import { db, importLogTable, usersTable, type User } from "@workspace/db";
import { UploadUsageDataBody } from "@workspace/api-zod";
import { requireAdmin } from "../lib/auth";
import { runImport } from "../lib/importer";

const router: IRouter = Router();

router.post("/uploads", requireAdmin, async (req, res): Promise<void> => {
  const parsed = UploadUsageDataBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid upload payload" });
    return;
  }
  if (parsed.data.files.length === 0) {
    res.status(400).json({ message: "No files were included in the upload" });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const outcome = await runImport(parsed.data.files, user.id);
  if ("error" in outcome) {
    res.status(400).json({ message: outcome.error });
    return;
  }
  res.json(outcome);
});

router.get("/uploads/log", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: importLogTable.id,
      uploadedAt: importLogTable.uploadedAt,
      uploadedByName: usersTable.displayName,
      snapshotDate: importLogTable.snapshotDate,
      filesIncluded: importLogTable.filesIncluded,
      rowsInserted: importLogTable.rowsInserted,
      rowsUpdated: importLogTable.rowsUpdated,
    })
    .from(importLogTable)
    .leftJoin(usersTable, eq(importLogTable.uploadedBy, usersTable.id))
    .orderBy(desc(importLogTable.uploadedAt));
  res.json(
    rows.map((r) => ({
      ...r,
      uploadedAt: r.uploadedAt.toISOString(),
      uploadedByName: r.uploadedByName ?? "Unknown",
    })),
  );
});

export default router;
