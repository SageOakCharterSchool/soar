import { Router, type IRouter } from "express";
import { and, eq, ne } from "drizzle-orm";
import { db, termsTable, appTermStatusTable } from "@workspace/db";
import { CreateTermBody, UpdateTermBody, CopyTermStatusesBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../lib/auth";

const router: IRouter = Router();

router.get("/terms", requireAuth, async (_req, res): Promise<void> => {
  const terms = await db.select().from(termsTable).orderBy(termsTable.sortOrder);
  res.json(terms);
});

router.post("/terms", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateTermBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const { isCurrent, ...rest } = parsed.data;
  const [term] = await db
    .insert(termsTable)
    .values({ ...rest, isCurrent: isCurrent ?? false })
    .returning();
  if (term && term.isCurrent) {
    await db.update(termsTable).set({ isCurrent: false }).where(ne(termsTable.id, term.id));
  }
  res.status(201).json(term);
});

router.patch("/terms/:id", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw ?? "", 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ message: "Invalid term id" });
    return;
  }
  const parsed = UpdateTermBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  if (parsed.data.isCurrent === false) {
    res.status(400).json({
      message: "Set another term as current instead of un-setting this one",
    });
    return;
  }
  const [term] = await db
    .update(termsTable)
    .set(parsed.data)
    .where(eq(termsTable.id, id))
    .returning();
  if (!term) {
    res.status(404).json({ message: "Term not found" });
    return;
  }
  if (parsed.data.isCurrent === true) {
    await db.update(termsTable).set({ isCurrent: false }).where(ne(termsTable.id, id));
  }
  res.json(term);
});

router.post("/terms/:id/copy-statuses", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const targetId = parseInt(raw ?? "", 10);
  if (Number.isNaN(targetId)) {
    res.status(400).json({ message: "Invalid term id" });
    return;
  }
  const parsed = CopyTermStatusesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const [target] = await db.select().from(termsTable).where(eq(termsTable.id, targetId));
  const [source] = await db
    .select()
    .from(termsTable)
    .where(eq(termsTable.id, parsed.data.sourceTermId));
  if (!target || !source) {
    res.status(404).json({ message: "Term not found" });
    return;
  }
  const sourceRows = await db
    .select()
    .from(appTermStatusTable)
    .where(eq(appTermStatusTable.termId, source.id));
  const targetRows = await db
    .select()
    .from(appTermStatusTable)
    .where(eq(appTermStatusTable.termId, target.id));
  const covered = new Set(targetRows.map((r) => r.applicationId));
  let copied = 0;
  for (const row of sourceRows) {
    if (covered.has(row.applicationId)) continue;
    await db.insert(appTermStatusTable).values({
      applicationId: row.applicationId,
      termId: target.id,
      studentSharingStatus: row.studentSharingStatus,
      staffSharingStatus: row.staffSharingStatus,
      syncMethod: row.syncMethod,
      owner: row.owner,
      notes: row.notes,
    });
    copied += 1;
  }
  res.json({ message: `Copied ${copied} status rows from ${source.label}` });
});

export default router;
