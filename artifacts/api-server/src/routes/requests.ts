import { Router, type IRouter, type Request } from "express";
import { desc, eq } from "drizzle-orm";
import {
  db,
  applicationsTable,
  appRequestsTable,
  appActivityTable,
  termsTable,
  usersTable,
  type User,
} from "@workspace/db";
import { CreateRequestBody, UpdateRequestBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../lib/auth";
import { emitRosteringActivity } from "../lib/activityEvents";

const router: IRouter = Router();

const REQUEST_TYPE_LABELS: Record<string, string> = {
  lti_addon: "LTI integration / add-on",
  nested_app: "Nested app",
  new_app: "New app",
  other: "Other",
};

function serialize(
  request: typeof appRequestsTable.$inferSelect,
  appName: string | null,
  requesterName: string,
) {
  return {
    id: request.id,
    applicationId: request.applicationId,
    appName,
    userId: request.userId,
    requesterName,
    requestType: request.requestType,
    title: request.title,
    details: request.details,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    statusUpdatedAt: request.statusUpdatedAt
      ? request.statusUpdatedAt.toISOString()
      : null,
  };
}

// Bound user-supplied text before persisting it into the shared activity
// feed (same pattern as issue events): single line, capped length.
function snippet(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

async function currentTermId(): Promise<number | null> {
  const [term] = await db.select().from(termsTable).where(eq(termsTable.isCurrent, true));
  return term?.id ?? null;
}

router.post("/requests", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "A request type and title are required" });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const title = parsed.data.title.trim();
  if (!title) {
    res.status(400).json({ message: "A title is required" });
    return;
  }
  let app: { id: number; name: string } | null = null;
  if (parsed.data.applicationId != null) {
    const [found] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, parsed.data.applicationId));
    if (!found) {
      res.status(404).json({ message: "Application not found" });
      return;
    }
    app = found;
  }
  const [request] = await db
    .insert(appRequestsTable)
    .values({
      applicationId: app?.id ?? null,
      userId: user.id,
      requestType: parsed.data.requestType,
      title,
      details: parsed.data.details?.trim() || null,
    })
    .returning();
  const typeLabel = REQUEST_TYPE_LABELS[parsed.data.requestType] ?? parsed.data.requestType;
  await db.insert(appActivityTable).values({
    applicationId: app?.id ?? null,
    termId: await currentTermId(),
    eventType: "request_submitted",
    detail: app
      ? `Request submitted for ${app.name}: ${snippet(title)} (${typeLabel})`
      : `Request submitted: ${snippet(title)} (${typeLabel})`,
    actorId: user.id,
  });
  emitRosteringActivity();
  res.status(201).json(serialize(request!, app?.name ?? null, user.displayName));
});

router.get("/requests", requireAuth, async (req, res): Promise<void> => {
  const statusFilter = String(req.query.status ?? "all");
  const validFilters = ["new", "under_review", "approved", "completed", "declined", "all"];
  if (!validFilters.includes(statusFilter)) {
    res.status(400).json({ message: "Invalid status filter" });
    return;
  }
  const base = db
    .select({
      id: appRequestsTable.id,
      applicationId: appRequestsTable.applicationId,
      appName: applicationsTable.name,
      userId: appRequestsTable.userId,
      requesterName: usersTable.displayName,
      requestType: appRequestsTable.requestType,
      title: appRequestsTable.title,
      details: appRequestsTable.details,
      status: appRequestsTable.status,
      createdAt: appRequestsTable.createdAt,
      statusUpdatedAt: appRequestsTable.statusUpdatedAt,
    })
    .from(appRequestsTable)
    .leftJoin(applicationsTable, eq(appRequestsTable.applicationId, applicationsTable.id))
    .innerJoin(usersTable, eq(appRequestsTable.userId, usersTable.id))
    .orderBy(desc(appRequestsTable.createdAt));

  const validStatuses = ["new", "under_review", "approved", "completed", "declined"];
  const rows = validStatuses.includes(statusFilter)
    ? await base.where(
        eq(
          appRequestsTable.status,
          statusFilter as (typeof appRequestsTable.$inferSelect)["status"],
        ),
      )
    : await base;

  res.json(
    rows.map((r) => ({
      ...r,
      appName: r.appName ?? null,
      createdAt: r.createdAt.toISOString(),
      statusUpdatedAt: r.statusUpdatedAt ? r.statusUpdatedAt.toISOString() : null,
    })),
  );
});

router.patch("/requests/:id", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw ?? "", 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ message: "Invalid request id" });
    return;
  }
  const parsed = UpdateRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const [existing] = await db
    .select()
    .from(appRequestsTable)
    .where(eq(appRequestsTable.id, id));
  if (!existing) {
    res.status(404).json({ message: "Request not found" });
    return;
  }
  const admin = (req as Request & { user: User }).user;
  const [request] = await db
    .update(appRequestsTable)
    .set({ status: parsed.data.status, statusUpdatedAt: new Date() })
    .where(eq(appRequestsTable.id, id))
    .returning();
  if (!request) {
    res.status(404).json({ message: "Request not found" });
    return;
  }
  if (existing.status !== request.status) {
    await db.insert(appActivityTable).values({
      applicationId: request.applicationId,
      termId: await currentTermId(),
      eventType: "request_updated",
      detail: `Request "${snippet(request.title)}" moved to ${request.status.replace("_", " ")}`,
      actorId: admin.id,
    });
    emitRosteringActivity();
  }
  const [app] = request.applicationId
    ? await db
        .select()
        .from(applicationsTable)
        .where(eq(applicationsTable.id, request.applicationId))
    : [undefined];
  const [requester] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, request.userId));
  res.json(serialize(request, app?.name ?? null, requester?.displayName ?? ""));
});

router.delete("/requests/:id", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw ?? "", 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ message: "Invalid request id" });
    return;
  }
  const [request] = await db
    .select()
    .from(appRequestsTable)
    .where(eq(appRequestsTable.id, id));
  if (!request) {
    res.status(404).json({ message: "Request not found" });
    return;
  }
  await db.delete(appRequestsTable).where(eq(appRequestsTable.id, id));
  emitRosteringActivity();
  res.json({ message: "Request deleted" });
});

export default router;
