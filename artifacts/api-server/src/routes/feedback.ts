import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  db,
  applicationsTable,
  appUpvotesTable,
  appIssuesTable,
  appActivityTable,
  pageLastSeenTable,
  termsTable,
  usersTable,
  type User,
} from "@workspace/db";
import { IssueInput as _unused, ReportIssueBody, UpdateIssueBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../lib/auth";
import { emitRosteringActivity } from "../lib/activityEvents";
import { getRaciPeopleByApp } from "../lib/raciPeople";

const router: IRouter = Router();

router.post("/apps/:id/upvote", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const applicationId = parseInt(raw ?? "", 10);
  if (Number.isNaN(applicationId)) {
    res.status(400).json({ message: "Invalid application id" });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));
  if (!app) {
    res.status(404).json({ message: "Application not found" });
    return;
  }
  const [existing] = await db
    .select()
    .from(appUpvotesTable)
    .where(
      and(
        eq(appUpvotesTable.applicationId, applicationId),
        eq(appUpvotesTable.userId, user.id),
      ),
    );
  let upvoted: boolean;
  if (existing) {
    await db.delete(appUpvotesTable).where(eq(appUpvotesTable.id, existing.id));
    upvoted = false;
  } else {
    await db.insert(appUpvotesTable).values({ applicationId, userId: user.id });
    upvoted = true;
  }
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(appUpvotesTable)
    .where(eq(appUpvotesTable.applicationId, applicationId));
  res.json({ applicationId, upvoted, upvoteCount: countRow?.count ?? 0 });
});

router.post("/apps/:id/issues", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const applicationId = parseInt(raw ?? "", 10);
  if (Number.isNaN(applicationId)) {
    res.status(400).json({ message: "Invalid application id" });
    return;
  }
  const parsed = ReportIssueBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "A comment is required" });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));
  if (!app) {
    res.status(404).json({ message: "Application not found" });
    return;
  }
  const [issue] = await db
    .insert(appIssuesTable)
    .values({ applicationId, userId: user.id, comment: parsed.data.comment })
    .returning();
  const [currentTerm] = await db
    .select()
    .from(termsTable)
    .where(eq(termsTable.isCurrent, true));
  const snippet =
    parsed.data.comment.length > 120
      ? `${parsed.data.comment.slice(0, 117)}...`
      : parsed.data.comment;
  await db.insert(appActivityTable).values({
    applicationId,
    termId: currentTerm?.id ?? null,
    eventType: "issue_reported",
    detail: `Issue reported: ${snippet}`,
    actorId: user.id,
  });
  emitRosteringActivity();
  const raciMap = await getRaciPeopleByApp([applicationId]);
  res.status(201).json({
    id: issue!.id,
    applicationId,
    appName: app.name,
    userId: user.id,
    reporterName: user.displayName,
    comment: issue!.comment,
    status: issue!.status,
    createdAt: issue!.createdAt.toISOString(),
    resolvedAt: null,
    raci: raciMap.get(applicationId) ?? [],
  });
});

router.get("/issues", requireAuth, async (req, res): Promise<void> => {
  const statusFilter = String(req.query.status ?? "all");
  const base = db
    .select({
      id: appIssuesTable.id,
      applicationId: appIssuesTable.applicationId,
      appName: applicationsTable.name,
      userId: appIssuesTable.userId,
      reporterName: usersTable.displayName,
      comment: appIssuesTable.comment,
      status: appIssuesTable.status,
      createdAt: appIssuesTable.createdAt,
      resolvedAt: appIssuesTable.resolvedAt,
    })
    .from(appIssuesTable)
    .innerJoin(applicationsTable, eq(appIssuesTable.applicationId, applicationsTable.id))
    .innerJoin(usersTable, eq(appIssuesTable.userId, usersTable.id))
    .orderBy(desc(appIssuesTable.createdAt));

  const issues =
    statusFilter === "all"
      ? await base
      : await base.where(
          eq(appIssuesTable.status, statusFilter === "resolved" ? "resolved" : "open"),
        );

  // RACI people so staff can see who owns each app (from the RACI matrix).
  const raciMap = await getRaciPeopleByApp([
    ...new Set(issues.map((i) => i.applicationId)),
  ]);
  res.json(
    issues.map((i) => ({
      ...i,
      createdAt: i.createdAt.toISOString(),
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
      raci: raciMap.get(i.applicationId) ?? [],
    })),
  );
});

const ISSUES_PAGE = "issues";
const ISSUE_EVENT_TYPES = ["issue_reported", "issue_resolved"] as const;

router.get("/issues/last-seen", requireAuth, async (req, res): Promise<void> => {
  const user = (req as Request & { user: User }).user;
  const [row] = await db
    .select({ lastSeenAt: pageLastSeenTable.lastSeenAt })
    .from(pageLastSeenTable)
    .where(and(eq(pageLastSeenTable.userId, user.id), eq(pageLastSeenTable.page, ISSUES_PAGE)));
  res.json({ lastSeenAt: row ? row.lastSeenAt.toISOString() : null });
});

router.get("/issues/unseen-count", requireAuth, async (req, res): Promise<void> => {
  const user = (req as Request & { user: User }).user;
  const [row] = await db
    .select({ lastSeenAt: pageLastSeenTable.lastSeenAt })
    .from(pageLastSeenTable)
    .where(and(eq(pageLastSeenTable.userId, user.id), eq(pageLastSeenTable.page, ISSUES_PAGE)));
  const [result] = row
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(appActivityTable)
        .where(
          and(
            inArray(appActivityTable.eventType, ISSUE_EVENT_TYPES),
            gt(appActivityTable.createdAt, row.lastSeenAt),
          ),
        )
    : await db
        .select({ count: sql<number>`count(*)::int` })
        .from(appActivityTable)
        .where(inArray(appActivityTable.eventType, ISSUE_EVENT_TYPES));
  res.json({ count: result?.count ?? 0 });
});

router.post("/issues/last-seen", requireAuth, async (req, res): Promise<void> => {
  const user = (req as Request & { user: User }).user;
  const [previous] = await db
    .select({ lastSeenAt: pageLastSeenTable.lastSeenAt })
    .from(pageLastSeenTable)
    .where(and(eq(pageLastSeenTable.userId, user.id), eq(pageLastSeenTable.page, ISSUES_PAGE)));
  await db
    .insert(pageLastSeenTable)
    .values({ userId: user.id, page: ISSUES_PAGE, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: [pageLastSeenTable.userId, pageLastSeenTable.page],
      set: { lastSeenAt: new Date() },
    });
  res.json({ lastSeenAt: previous ? previous.lastSeenAt.toISOString() : null });
});

router.patch("/issues/:id", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw ?? "", 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ message: "Invalid issue id" });
    return;
  }
  const parsed = UpdateIssueBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const [existingIssue] = await db
    .select()
    .from(appIssuesTable)
    .where(eq(appIssuesTable.id, id));
  if (!existingIssue) {
    res.status(404).json({ message: "Issue not found" });
    return;
  }
  const [issue] = await db
    .update(appIssuesTable)
    .set({
      status: parsed.data.status,
      resolvedAt: parsed.data.status === "resolved" ? new Date() : null,
    })
    .where(eq(appIssuesTable.id, id))
    .returning();
  if (!issue) {
    res.status(404).json({ message: "Issue not found" });
    return;
  }
  if (existingIssue.status !== "resolved" && issue.status === "resolved") {
    const admin = (req as Request & { user: User }).user;
    const [currentTerm] = await db
      .select()
      .from(termsTable)
      .where(eq(termsTable.isCurrent, true));
    const snippet =
      issue.comment.length > 120 ? `${issue.comment.slice(0, 117)}...` : issue.comment;
    await db.insert(appActivityTable).values({
      applicationId: issue.applicationId,
      termId: currentTerm?.id ?? null,
      eventType: "issue_resolved",
      detail: `Issue resolved: ${snippet}`,
      actorId: admin.id,
    });
    emitRosteringActivity();
  }
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, issue.applicationId));
  const [reporter] = await db.select().from(usersTable).where(eq(usersTable.id, issue.userId));
  const raciMap = await getRaciPeopleByApp([issue.applicationId]);
  res.json({
    id: issue.id,
    applicationId: issue.applicationId,
    appName: app?.name ?? "",
    userId: issue.userId,
    reporterName: reporter?.displayName ?? "",
    comment: issue.comment,
    status: issue.status,
    createdAt: issue.createdAt.toISOString(),
    resolvedAt: issue.resolvedAt ? issue.resolvedAt.toISOString() : null,
    raci: raciMap.get(issue.applicationId) ?? [],
  });
});

router.delete("/issues/:id", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw ?? "", 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ message: "Invalid issue id" });
    return;
  }
  const [issue] = await db.select().from(appIssuesTable).where(eq(appIssuesTable.id, id));
  if (!issue) {
    res.status(404).json({ message: "Issue not found" });
    return;
  }
  // Remove the activity events logged for this issue so deleting it leaves no
  // trace in the unseen-count or activity history (used by automated checks
  // cleaning up synthetic test issues).
  const snippet =
    issue.comment.length > 120 ? `${issue.comment.slice(0, 117)}...` : issue.comment;
  await db
    .delete(appActivityTable)
    .where(
      and(
        eq(appActivityTable.applicationId, issue.applicationId),
        inArray(appActivityTable.eventType, ISSUE_EVENT_TYPES),
        inArray(appActivityTable.detail, [
          `Issue reported: ${snippet}`,
          `Issue resolved: ${snippet}`,
        ]),
      ),
    );
  await db.delete(appIssuesTable).where(eq(appIssuesTable.id, id));
  emitRosteringActivity();
  res.json({ message: "Issue deleted" });
});

export default router;
