import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  db,
  applicationsTable,
  appTermStatusTable,
  appUpvotesTable,
  appIssuesTable,
  appActivityTable,
  usersTable,
  type User,
} from "@workspace/db";
import { UpdateAppTermStatusBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../lib/auth";

const router: IRouter = Router();

const STATUS_LABELS: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
  needs_review: "Needs review",
};

router.get("/rostering/activity", requireAuth, async (req, res): Promise<void> => {
  const termIdRaw = req.query.termId;
  const termId = termIdRaw != null ? parseInt(String(termIdRaw), 10) : null;
  if (termIdRaw != null && Number.isNaN(termId)) {
    res.status(400).json({ message: "termId must be an integer" });
    return;
  }
  const limitRaw = parseInt(String(req.query.limit ?? "25"), 10);
  const limit = Number.isNaN(limitRaw) ? 25 : Math.min(Math.max(limitRaw, 1), 100);

  const base = db
    .select({
      id: appActivityTable.id,
      applicationId: appActivityTable.applicationId,
      appName: applicationsTable.name,
      termId: appActivityTable.termId,
      eventType: appActivityTable.eventType,
      detail: appActivityTable.detail,
      actorName: usersTable.displayName,
      createdAt: appActivityTable.createdAt,
    })
    .from(appActivityTable)
    .innerJoin(applicationsTable, eq(appActivityTable.applicationId, applicationsTable.id))
    .leftJoin(usersTable, eq(appActivityTable.actorId, usersTable.id))
    .orderBy(desc(appActivityTable.createdAt), desc(appActivityTable.id))
    .limit(limit);

  const rows =
    termId != null
      ? await base.where(
          or(eq(appActivityTable.termId, termId), isNull(appActivityTable.termId)),
        )
      : await base;

  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

router.get("/rostering/board", requireAuth, async (req, res): Promise<void> => {
  const termId = parseInt(String(req.query.termId ?? ""), 10);
  if (Number.isNaN(termId)) {
    res.status(400).json({ message: "termId query parameter is required" });
    return;
  }
  const user = (req as Request & { user: User }).user;

  const rows = await db
    .select({
      applicationId: applicationsTable.id,
      appName: applicationsTable.name,
      category: applicationsTable.category,
      statusId: appTermStatusTable.id,
      studentSharingStatus: appTermStatusTable.studentSharingStatus,
      staffSharingStatus: appTermStatusTable.staffSharingStatus,
      syncMethod: appTermStatusTable.syncMethod,
      lastSyncedAt: appTermStatusTable.lastSyncedAt,
      owner: appTermStatusTable.owner,
      notes: appTermStatusTable.notes,
      updatedAt: appTermStatusTable.updatedAt,
      updatedByName: usersTable.displayName,
    })
    .from(appTermStatusTable)
    .innerJoin(applicationsTable, eq(appTermStatusTable.applicationId, applicationsTable.id))
    .leftJoin(usersTable, eq(appTermStatusTable.updatedBy, usersTable.id))
    .where(eq(appTermStatusTable.termId, termId))
    .orderBy(applicationsTable.name);

  const upvotes = await db
    .select({
      applicationId: appUpvotesTable.applicationId,
      count: sql<number>`count(*)::int`,
      mine: sql<number>`sum(case when ${appUpvotesTable.userId} = ${user.id} then 1 else 0 end)::int`,
    })
    .from(appUpvotesTable)
    .groupBy(appUpvotesTable.applicationId);
  const upvoteMap = new Map(upvotes.map((u) => [u.applicationId, u]));

  const issues = await db
    .select({
      applicationId: appIssuesTable.applicationId,
      count: sql<number>`count(*)::int`,
    })
    .from(appIssuesTable)
    .where(eq(appIssuesTable.status, "open"))
    .groupBy(appIssuesTable.applicationId);
  const issueMap = new Map(issues.map((i) => [i.applicationId, i.count]));

  res.json(
    rows.map((row) => ({
      ...row,
      lastSyncedAt: row.lastSyncedAt ?? null,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      upvoteCount: upvoteMap.get(row.applicationId)?.count ?? 0,
      upvotedByMe: (upvoteMap.get(row.applicationId)?.mine ?? 0) > 0,
      openIssueCount: issueMap.get(row.applicationId) ?? 0,
    })),
  );
});

router.get("/rostering/summary", requireAuth, async (req, res): Promise<void> => {
  const termId = parseInt(String(req.query.termId ?? ""), 10);
  if (Number.isNaN(termId)) {
    res.status(400).json({ message: "termId query parameter is required" });
    return;
  }
  const rows = await db
    .select({
      status: appTermStatusTable.studentSharingStatus,
      count: sql<number>`count(*)::int`,
    })
    .from(appTermStatusTable)
    .where(eq(appTermStatusTable.termId, termId))
    .groupBy(appTermStatusTable.studentSharingStatus);
  const byStatus = new Map(rows.map((r) => [r.status, r.count]));
  const notStarted = byStatus.get("not_started") ?? 0;
  const inProgress = byStatus.get("in_progress") ?? 0;
  const complete = byStatus.get("complete") ?? 0;
  const needsReview = byStatus.get("needs_review") ?? 0;
  res.json({
    notStarted,
    inProgress,
    complete,
    needsReview,
    total: notStarted + inProgress + complete + needsReview,
  });
});

router.patch("/rostering/status/:id", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw ?? "", 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ message: "Invalid status id" });
    return;
  }
  const parsed = UpdateAppTermStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const [before] = await db
    .select()
    .from(appTermStatusTable)
    .where(eq(appTermStatusTable.id, id));
  if (!before) {
    res.status(404).json({ message: "Status row not found" });
    return;
  }
  const [row] = await db
    .update(appTermStatusTable)
    .set({ ...parsed.data, updatedBy: user.id, updatedAt: new Date() })
    .where(eq(appTermStatusTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ message: "Status row not found" });
    return;
  }
  const changes: string[] = [];
  if (before.studentSharingStatus !== row.studentSharingStatus) {
    changes.push(
      `Student sharing: ${STATUS_LABELS[before.studentSharingStatus]} → ${STATUS_LABELS[row.studentSharingStatus]}`,
    );
  }
  if (before.staffSharingStatus !== row.staffSharingStatus) {
    changes.push(
      `Staff sharing: ${STATUS_LABELS[before.staffSharingStatus]} → ${STATUS_LABELS[row.staffSharingStatus]}`,
    );
  }
  if ((before.owner ?? null) !== (row.owner ?? null)) {
    changes.push(`Owner set to ${row.owner ?? "—"}`);
  }
  if ((before.syncMethod ?? null) !== (row.syncMethod ?? null)) {
    changes.push(`Sync method set to ${row.syncMethod ?? "—"}`);
  }
  if (changes.length > 0) {
    await db.insert(appActivityTable).values({
      applicationId: row.applicationId,
      termId: row.termId,
      eventType: "status_change",
      detail: changes.join("; "),
      actorId: user.id,
    });
  }
  const [updater] = await db.select().from(usersTable).where(eq(usersTable.id, user.id));
  res.json({
    ...row,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: updater?.displayName ?? null,
  });
});

export default router;
