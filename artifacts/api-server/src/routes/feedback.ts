import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  applicationsTable,
  appUpvotesTable,
  appIssuesTable,
  usersTable,
  type User,
} from "@workspace/db";
import { IssueInput as _unused, ReportIssueBody, UpdateIssueBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../lib/auth";

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
  res.status(201).json({
    id: issue!.id,
    applicationId,
    appName: app.name,
    userId: user.id,
    reporterName: user.displayName,
    comment: issue!.comment,
    status: issue!.status,
    createdAt: issue!.createdAt.toISOString(),
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

  res.json(issues.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })));
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
  const [issue] = await db
    .update(appIssuesTable)
    .set({ status: parsed.data.status })
    .where(eq(appIssuesTable.id, id))
    .returning();
  if (!issue) {
    res.status(404).json({ message: "Issue not found" });
    return;
  }
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, issue.applicationId));
  const [reporter] = await db.select().from(usersTable).where(eq(usersTable.id, issue.userId));
  res.json({
    id: issue.id,
    applicationId: issue.applicationId,
    appName: app?.name ?? "",
    userId: issue.userId,
    reporterName: reporter?.displayName ?? "",
    comment: issue.comment,
    status: issue.status,
    createdAt: issue.createdAt.toISOString(),
  });
});

export default router;
