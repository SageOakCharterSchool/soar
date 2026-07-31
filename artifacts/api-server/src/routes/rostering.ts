import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, gt, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  applicationsTable,
  appTermStatusTable,
  appUpvotesTable,
  appIssuesTable,
  appActivityTable,
  appActivityArchiveTable,
  pageLastSeenTable,
  termsTable,
  usersTable,
  raciRowsTable,
  usageByAppTable,
  usageAppListTable,
  type User,
} from "@workspace/db";
import {
  UpdateAppTermStatusBody,
  UpdateAppDayOneCriticalBody,
  CreateAppBody,
  RenameAppBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../lib/auth";
import { emitRosteringActivity, onRosteringActivity } from "../lib/activityEvents";
import { getRaciPeopleByApp } from "../lib/raciPeople";
import { readAppSettings } from "../lib/appSettings";

const router: IRouter = Router();

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
    // Left join: RACI change events may not be tied to an application.
    .leftJoin(applicationsTable, eq(appActivityTable.applicationId, applicationsTable.id))
    .leftJoin(usersTable, eq(appActivityTable.actorId, usersTable.id))
    .orderBy(desc(appActivityTable.createdAt), desc(appActivityTable.id))
    .limit(limit);

  const rows =
    termId != null
      ? await base.where(
          or(eq(appActivityTable.termId, termId), isNull(appActivityTable.termId)),
        )
      : await base;

  res.json(
    rows.map((r) => ({
      ...r,
      appName: r.appName ?? (r.eventType === "app_removed" ? "App removed" : "RACI"),
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

function csvEscape(value: unknown): string {
  let s = value == null ? "" : String(value);
  // Prevent CSV/formula injection: Excel and Google Sheets treat cells
  // starting with =, +, -, @ (or tab/CR) as formulas. Prefix with a single
  // quote so spreadsheets render the value as plain text.
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Archived activity (rows older than the retention window). Admin-only.
router.get(
  "/rostering/activity/archive",
  requireAdmin,
  async (req, res): Promise<void> => {
    const limitRaw = parseInt(String(req.query.limit ?? "100"), 10);
    const limit = Number.isNaN(limitRaw) ? 100 : Math.min(Math.max(limitRaw, 1), 1000);
    const offsetRaw = parseInt(String(req.query.offset ?? "0"), 10);
    const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(offsetRaw, 0);
    const format = String(req.query.format ?? "json");

    const conditions = [];

    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) {
      const pattern = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
      conditions.push(
        or(
          ilike(appActivityArchiveTable.appName, pattern),
          ilike(appActivityArchiveTable.actorName, pattern),
          ilike(appActivityArchiveTable.detail, pattern),
        ),
      );
    }

    const appName = typeof req.query.appName === "string" ? req.query.appName.trim() : "";
    if (appName) {
      // Escaped pattern with no wildcards = case-insensitive exact match.
      conditions.push(
        ilike(appActivityArchiveTable.appName, appName.replace(/[%_\\]/g, "\\$&")),
      );
    }

    const fromRaw = typeof req.query.from === "string" ? req.query.from.trim() : "";
    if (fromRaw) {
      const from = new Date(fromRaw);
      if (Number.isNaN(from.getTime())) {
        res.status(400).json({ message: "from must be a valid ISO 8601 date" });
        return;
      }
      conditions.push(gte(appActivityArchiveTable.createdAt, from));
    }

    const toRaw = typeof req.query.to === "string" ? req.query.to.trim() : "";
    if (toRaw) {
      const to = new Date(toRaw);
      if (Number.isNaN(to.getTime())) {
        res.status(400).json({ message: "to must be a valid ISO 8601 date" });
        return;
      }
      // A bare date like 2026-01-31 should include the whole day.
      if (/^\d{4}-\d{2}-\d{2}$/.test(toRaw)) {
        to.setUTCHours(23, 59, 59, 999);
      }
      conditions.push(lte(appActivityArchiveTable.createdAt, to));
    }

    // Snapshot boundary: only rows archived at/before this instant are
    // included. Paged exports pass the snapshot from the first page back on
    // subsequent requests so rows archived mid-export can't shift offsets
    // (which would silently duplicate or skip rows).
    const archivedBeforeRaw =
      typeof req.query.archivedBefore === "string" ? req.query.archivedBefore.trim() : "";
    let snapshot: Date;
    if (archivedBeforeRaw) {
      snapshot = new Date(archivedBeforeRaw);
      if (Number.isNaN(snapshot.getTime())) {
        res.status(400).json({ message: "archivedBefore must be a valid ISO 8601 date" });
        return;
      }
    } else {
      snapshot = new Date();
    }
    conditions.push(lte(appActivityArchiveTable.archivedAt, snapshot));
    res.setHeader("X-Archive-Snapshot", snapshot.toISOString());

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(appActivityArchiveTable)
      .where(where);
    res.setHeader("X-Total-Count", String(countRow?.count ?? 0));

    const rows = await db
      .select({
        id: appActivityArchiveTable.id,
        applicationId: appActivityArchiveTable.applicationId,
        appName: appActivityArchiveTable.appName,
        termId: appActivityArchiveTable.termId,
        eventType: appActivityArchiveTable.eventType,
        detail: appActivityArchiveTable.detail,
        actorName: appActivityArchiveTable.actorName,
        createdAt: appActivityArchiveTable.createdAt,
        archivedAt: appActivityArchiveTable.archivedAt,
      })
      .from(appActivityArchiveTable)
      .where(where)
      .orderBy(desc(appActivityArchiveTable.createdAt), desc(appActivityArchiveTable.id))
      .limit(limit)
      .offset(offset);

    const mapped = rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      archivedAt: r.archivedAt.toISOString(),
    }));

    if (format === "csv") {
      const header = "app,event_type,detail,actor,occurred_at,archived_at";
      const lines = mapped.map((r) =>
        [r.appName, r.eventType, r.detail, r.actorName ?? "", r.createdAt, r.archivedAt]
          .map(csvEscape)
          .join(","),
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="activity-archive.csv"',
      );
      res.send([header, ...lines].join("\n") + "\n");
      return;
    }

    res.json(mapped);
  },
);

const ROSTERING_PAGE = "rostering";

router.get("/rostering/last-seen", requireAuth, async (req, res): Promise<void> => {
  const user = (req as Request & { user: User }).user;
  const [row] = await db
    .select({ lastSeenAt: pageLastSeenTable.lastSeenAt })
    .from(pageLastSeenTable)
    .where(
      and(eq(pageLastSeenTable.userId, user.id), eq(pageLastSeenTable.page, ROSTERING_PAGE)),
    );
  res.json({ lastSeenAt: row ? row.lastSeenAt.toISOString() : null });
});

router.get("/rostering/unseen-count", requireAuth, async (req, res): Promise<void> => {
  const user = (req as Request & { user: User }).user;
  const [row] = await db
    .select({ lastSeenAt: pageLastSeenTable.lastSeenAt })
    .from(pageLastSeenTable)
    .where(
      and(eq(pageLastSeenTable.userId, user.id), eq(pageLastSeenTable.page, ROSTERING_PAGE)),
    );
  const [result] = row
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(appActivityTable)
        .where(gt(appActivityTable.createdAt, row.lastSeenAt))
    : await db
        .select({ count: sql<number>`count(*)::int` })
        .from(appActivityTable);
  res.json({ count: result?.count ?? 0 });
});

router.post("/rostering/last-seen", requireAuth, async (req, res): Promise<void> => {
  const user = (req as Request & { user: User }).user;
  const [previous] = await db
    .select({ lastSeenAt: pageLastSeenTable.lastSeenAt })
    .from(pageLastSeenTable)
    .where(
      and(eq(pageLastSeenTable.userId, user.id), eq(pageLastSeenTable.page, ROSTERING_PAGE)),
    );
  await db
    .insert(pageLastSeenTable)
    .values({ userId: user.id, page: ROSTERING_PAGE, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: [pageLastSeenTable.userId, pageLastSeenTable.page],
      set: { lastSeenAt: new Date() },
    });
  res.json({ lastSeenAt: previous ? previous.lastSeenAt.toISOString() : null });
});

// Server-sent events stream: pushes a short "activity" event whenever any
// rostering activity row is created, so clients can refresh badge counts
// immediately instead of waiting for the next poll.
router.get("/rostering/events", requireAuth, (req, res): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 5000\n\n");

  const unsubscribe = onRosteringActivity(() => {
    res.write("event: activity\ndata: {}\n\n");
  });
  // Heartbeat keeps proxies from timing out the idle connection.
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
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
      dayOneCritical: applicationsTable.dayOneCritical,
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

  // RACI people for each linked application (from the RACI matrix page).
  const raciMap = await getRaciPeopleByApp([
    ...new Set(rows.map((row) => row.applicationId)),
  ]);

  res.json(
    rows.map((row) => ({
      ...row,
      lastSyncedAt: row.lastSyncedAt ?? null,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      upvoteCount: upvoteMap.get(row.applicationId)?.count ?? 0,
      upvotedByMe: (upvoteMap.get(row.applicationId)?.mine ?? 0) > 0,
      openIssueCount: issueMap.get(row.applicationId) ?? 0,
      raci: raciMap.get(row.applicationId) ?? [],
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
  // Sharing statuses are settings-driven: new values must be an *active*
  // configured option, but keeping a row's existing (possibly deactivated)
  // value is always allowed.
  const settings = await readAppSettings();
  const activeStatuses = new Set(
    settings.sharingStatusOptions.filter((o) => o.active).map((o) => o.value),
  );
  for (const [field, current] of [
    ["studentSharingStatus", before.studentSharingStatus],
    ["staffSharingStatus", before.staffSharingStatus],
  ] as const) {
    const next = parsed.data[field];
    if (next !== undefined && next !== current && !activeStatuses.has(next)) {
      res.status(400).json({
        message: `"${next}" is not an active sharing status option`,
      });
      return;
    }
  }
  const statusLabels = new Map(
    settings.sharingStatusOptions.map((o) => [o.value, o.label]),
  );
  const labelFor = (value: string) => statusLabels.get(value) ?? value;
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
      `Student sharing: ${labelFor(before.studentSharingStatus)} → ${labelFor(row.studentSharingStatus)}`,
    );
  }
  if (before.staffSharingStatus !== row.staffSharingStatus) {
    changes.push(
      `Staff sharing: ${labelFor(before.staffSharingStatus)} → ${labelFor(row.staffSharingStatus)}`,
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
    emitRosteringActivity();
  }
  const [updater] = await db.select().from(usersTable).where(eq(usersTable.id, user.id));
  res.json({
    ...row,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: updater?.displayName ?? null,
  });
});

// Manually register an application that is not imported from Clever (e.g.
// custom rostering programs). Creates the app plus its status row for the
// given term so it appears on the board immediately.
router.post("/apps", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateAppBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const name = parsed.data.name.trim();
  if (!name) {
    res.status(400).json({ message: "Name is required" });
    return;
  }
  const [term] = await db
    .select()
    .from(termsTable)
    .where(eq(termsTable.id, parsed.data.termId));
  if (!term) {
    res.status(404).json({ message: "Term not found" });
    return;
  }
  // Case-insensitive duplicate check so "Zoom" and "zoom" can't coexist —
  // imports match by exact name, so near-duplicates would fragment history.
  const existingApps = await db.select().from(applicationsTable);
  const duplicate = existingApps.find(
    (a) => a.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) {
    res.status(409).json({
      message: `An application named "${duplicate.name}" already exists`,
    });
    return;
  }
  // New sharing statuses must be active configured options (same rule as the
  // status edit endpoint).
  const settings = await readAppSettings();
  const activeStatuses = new Set(
    settings.sharingStatusOptions.filter((o) => o.active).map((o) => o.value),
  );
  for (const field of ["studentSharingStatus", "staffSharingStatus"] as const) {
    const value = parsed.data[field];
    if (value !== undefined && !activeStatuses.has(value)) {
      res.status(400).json({
        message: `"${value}" is not an active sharing status option`,
      });
      return;
    }
  }
  const category = parsed.data.category?.trim() || null;
  try {
    // App + status row + activity event are created atomically so a manual
    // app can never exist without its board row.
    const created = await db.transaction(async (tx) => {
      const [app] = await tx
        .insert(applicationsTable)
        .values({ name, category })
        .returning();
      if (!app) throw new Error("Application insert returned no row");
      const [status] = await tx
        .insert(appTermStatusTable)
        .values({
          applicationId: app.id,
          termId: term.id,
          ...(parsed.data.studentSharingStatus !== undefined
            ? { studentSharingStatus: parsed.data.studentSharingStatus }
            : {}),
          ...(parsed.data.staffSharingStatus !== undefined
            ? { staffSharingStatus: parsed.data.staffSharingStatus }
            : {}),
          owner: parsed.data.owner?.trim() || null,
          notes: parsed.data.notes?.trim() || null,
          updatedBy: user.id,
        })
        .returning();
      if (!status) throw new Error("Status insert returned no row");
      await tx.insert(appActivityTable).values({
        applicationId: app.id,
        termId: term.id,
        eventType: "app_added",
        detail: category ? `Added manually (${category})` : "Added manually",
        actorId: user.id,
      });
      return { app, status };
    });
    emitRosteringActivity();
    res.status(201).json({
      applicationId: created.app.id,
      name: created.app.name,
      category: created.app.category ?? null,
      statusId: created.status.id,
    });
  } catch (err) {
    // Unique violation (23505): another request created the same name after
    // our preflight check — report it as a duplicate, not a server error.
    if (
      err != null &&
      typeof err === "object" &&
      ("code" in err ? (err as { code?: string }).code : undefined) === "23505"
    ) {
      res.status(409).json({
        message: `An application named "${name}" already exists`,
      });
      return;
    }
    throw err;
  }
});

// Rename an application. Imports match apps by exact name, so renaming an
// app that appears in imported usage reports would break that matching (the
// next import would re-create the old name as a duplicate app). Those renames
// are rejected; manually added apps never appear in usage data and can always
// be renamed.
router.patch("/apps/:id", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw ?? "", 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ message: "Invalid application id" });
    return;
  }
  const parsed = RenameAppBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const name = parsed.data.name.trim();
  if (!name) {
    res.status(400).json({ message: "Name is required" });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const [app] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, id));
  if (!app) {
    res.status(404).json({ message: "Application not found" });
    return;
  }
  if (app.name === name) {
    res.json({ applicationId: app.id, name: app.name });
    return;
  }
  // Case-insensitive duplicate check (same rule as app creation) so a rename
  // can't create "Zoom"/"zoom" near-duplicates that fragment history.
  const existingApps = await db.select().from(applicationsTable);
  const duplicate = existingApps.find(
    (a) => a.id !== id && a.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) {
    res.status(409).json({
      message: `An application named "${duplicate.name}" already exists`,
    });
    return;
  }
  // Block renames of apps that imports know by their current name — unless
  // the change is only capitalization/whitespace, which the importer's
  // matching treats as the same app anyway.
  const current = app.name.trim().toLowerCase();
  if (current !== name.toLowerCase()) {
    const usageMatch = (value: string) => value.trim().toLowerCase() === current;
    const [byApp, byList] = await Promise.all([
      db.select({ application: usageByAppTable.application }).from(usageByAppTable),
      db.select({ appName: usageAppListTable.appName }).from(usageAppListTable),
    ]);
    if (
      byApp.some((r) => usageMatch(r.application)) ||
      byList.some((r) => usageMatch(r.appName))
    ) {
      res.status(409).json({
        message: `"${app.name}" appears in imported usage reports, which match apps by name. Renaming it would make the next import re-create "${app.name}" as a separate app, so it can't be renamed here.`,
      });
      return;
    }
  }
  const [updated] = await db
    .update(applicationsTable)
    .set({ name })
    .where(eq(applicationsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ message: "Application not found" });
    return;
  }
  await db.insert(appActivityTable).values({
    applicationId: updated.id,
    eventType: "app_renamed",
    detail: `Renamed "${app.name}" to "${updated.name}"`,
    actorId: user.id,
  });
  emitRosteringActivity();
  res.json({ applicationId: updated.id, name: updated.name });
});

// Delete an application and its related data. Status rows, issues, upvotes
// and activity are removed by cascade; RACI rows keep their people but are
// unlinked from the app. A tombstone activity event (not tied to the deleted
// app, so it survives the cascade) records who removed what.
router.delete("/apps/:id", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw ?? "", 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ message: "Invalid application id" });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const [app] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, id));
  if (!app) {
    res.status(404).json({ message: "Application not found" });
    return;
  }
  const count = async (table: typeof appTermStatusTable | typeof appIssuesTable | typeof appUpvotesTable | typeof appActivityTable | typeof raciRowsTable) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = table as any;
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(t)
      .where(eq(t.applicationId, id));
    return row?.count ?? 0;
  };
  const [statusRows, issues, upvotes, activityEvents, raciLinked] = await Promise.all([
    count(appTermStatusTable),
    count(appIssuesTable),
    count(appUpvotesTable),
    count(appActivityTable),
    count(raciRowsTable),
  ]);
  await db.transaction(async (tx) => {
    // Related rows are removed explicitly (not left to FK cascades) so the
    // counts we report always match what actually happened.
    await tx
      .update(raciRowsTable)
      .set({ applicationId: null })
      .where(eq(raciRowsTable.applicationId, id));
    await tx.delete(appTermStatusTable).where(eq(appTermStatusTable.applicationId, id));
    await tx.delete(appIssuesTable).where(eq(appIssuesTable.applicationId, id));
    await tx.delete(appUpvotesTable).where(eq(appUpvotesTable.applicationId, id));
    await tx.delete(appActivityTable).where(eq(appActivityTable.applicationId, id));
    await tx.delete(applicationsTable).where(eq(applicationsTable.id, id));
    await tx.insert(appActivityTable).values({
      applicationId: null,
      eventType: "app_removed",
      detail: `Removed app "${app.name}" (${statusRows} status row${statusRows === 1 ? "" : "s"}, ${issues} issue${issues === 1 ? "" : "s"}, ${upvotes} upvote${upvotes === 1 ? "" : "s"}, ${raciLinked} RACI row${raciLinked === 1 ? "" : "s"} unlinked)`,
      actorId: user.id,
    });
  });
  emitRosteringActivity();
  res.json({
    applicationId: app.id,
    name: app.name,
    statusRows,
    issues,
    upvotes,
    activityEvents,
    raciRowsUnlinked: raciLinked,
  });
});

router.patch("/apps/:id/day-one-critical", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw ?? "", 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ message: "Invalid application id" });
    return;
  }
  const parsed = UpdateAppDayOneCriticalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(applicationsTable)
    .set({ dayOneCritical: parsed.data.dayOneCritical })
    .where(eq(applicationsTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ message: "Application not found" });
    return;
  }
  res.json({ applicationId: row.id, dayOneCritical: row.dayOneCritical });
});

export default router;
