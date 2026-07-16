import { Router, type IRouter, type Request } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  raciTeamsTable,
  raciMembersTable,
  raciRowsTable,
  raciAssignmentsTable,
  applicationsTable,
  appActivityTable,
  type User,
} from "@workspace/db";
import {
  CreateRaciRowBody,
  UpdateRaciRowBody,
  CreateRaciMemberBody,
  UpdateRaciMemberBody,
  SetRaciCellBody,
  RenameRaciCategoryBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../lib/auth";
import { emitRosteringActivity } from "../lib/activityEvents";

const router: IRouter = Router();

function parseId(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(String(value ?? ""), 10);
  return Number.isNaN(id) ? null : id;
}

async function logRaciChange(
  actorId: number,
  detail: string,
  applicationId: number | null = null,
): Promise<void> {
  await db.insert(appActivityTable).values({
    applicationId,
    eventType: "raci_change",
    detail,
    actorId,
  });
  emitRosteringActivity();
}

async function loadMatrix() {
  const teams = await db
    .select()
    .from(raciTeamsTable)
    .orderBy(asc(raciTeamsTable.sortOrder), asc(raciTeamsTable.id));
  const members = await db
    .select()
    .from(raciMembersTable)
    .orderBy(asc(raciMembersTable.sortOrder), asc(raciMembersTable.id));
  const rows = await db
    .select({
      id: raciRowsTable.id,
      teamId: raciRowsTable.teamId,
      category: raciRowsTable.category,
      name: raciRowsTable.name,
      sortOrder: raciRowsTable.sortOrder,
      applicationId: raciRowsTable.applicationId,
      appName: applicationsTable.name,
    })
    .from(raciRowsTable)
    .leftJoin(applicationsTable, eq(raciRowsTable.applicationId, applicationsTable.id))
    .orderBy(asc(raciRowsTable.sortOrder), asc(raciRowsTable.id));
  const assignments = await db.select().from(raciAssignmentsTable);

  const cellsByRow = new Map<number, { memberId: number; value: string }[]>();
  for (const a of assignments) {
    if (!cellsByRow.has(a.rowId)) cellsByRow.set(a.rowId, []);
    cellsByRow.get(a.rowId)!.push({ memberId: a.memberId, value: a.value });
  }

  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    sortOrder: team.sortOrder,
    members: members
      .filter((m) => m.teamId === team.id)
      .map((m) => ({
        id: m.id,
        teamId: m.teamId,
        name: m.name,
        userId: m.userId ?? null,
        sortOrder: m.sortOrder,
      })),
    rows: rows
      .filter((r) => r.teamId === team.id)
      .map((r) => ({
        id: r.id,
        teamId: r.teamId,
        category: r.category ?? null,
        name: r.name,
        sortOrder: r.sortOrder,
        applicationId: r.applicationId ?? null,
        appName: r.appName ?? null,
        assignments: cellsByRow.get(r.id) ?? [],
      })),
  }));
}

router.get("/raci", requireAuth, async (_req, res): Promise<void> => {
  res.json({ teams: await loadMatrix() });
});

function csvEscape(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV export for one team section.
router.get("/raci/teams/:id/export", requireAuth, async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ message: "Invalid team id" });
    return;
  }
  const teams = await loadMatrix();
  const team = teams.find((t) => t.id === id);
  if (!team) {
    res.status(404).json({ message: "Team not found" });
    return;
  }
  const header = ["Category", "Decision or Task", ...team.members.map((m) => m.name)];
  const lines = team.rows.map((row) => {
    const byMember = new Map(row.assignments.map((a) => [a.memberId, a.value]));
    return [
      row.category ?? "",
      row.name,
      ...team.members.map((m) => byMember.get(m.id) ?? ""),
    ]
      .map(csvEscape)
      .join(",");
  });
  const safeName = team.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="raci-${safeName}.csv"`);
  res.send([header.map(csvEscape).join(","), ...lines].join("\n") + "\n");
});

async function matchApplicationByName(name: string): Promise<number | null> {
  const apps = await db
    .select({ id: applicationsTable.id, name: applicationsTable.name })
    .from(applicationsTable);
  const target = name.trim().toLowerCase();
  const match = apps.find((a) => a.name.trim().toLowerCase() === target);
  return match?.id ?? null;
}

router.post("/raci/rows", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateRaciRowBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const { teamId, name, category } = parsed.data;
  const [team] = await db.select().from(raciTeamsTable).where(eq(raciTeamsTable.id, teamId));
  if (!team) {
    res.status(400).json({ message: "Team not found" });
    return;
  }
  const siblings = await db
    .select({ sortOrder: raciRowsTable.sortOrder })
    .from(raciRowsTable)
    .where(eq(raciRowsTable.teamId, teamId));
  const sortOrder = siblings.reduce((max, r) => Math.max(max, r.sortOrder), 0) + 1;
  // Auto-link to an application whose name matches the new row's name.
  const applicationId = await matchApplicationByName(name);
  const [row] = await db
    .insert(raciRowsTable)
    .values({ teamId, name: name.trim(), category: category ?? null, sortOrder, applicationId })
    .returning();
  await logRaciChange(
    user.id,
    `RACI: added "${name.trim()}" to ${team.name}`,
    applicationId,
  );
  res.json({
    id: row!.id,
    teamId,
    category: row!.category ?? null,
    name: row!.name,
    sortOrder,
    applicationId: applicationId ?? null,
    appName: null,
    assignments: [],
  });
});

router.patch("/raci/rows/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ message: "Invalid row id" });
    return;
  }
  const parsed = UpdateRaciRowBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const [before] = await db.select().from(raciRowsTable).where(eq(raciRowsTable.id, id));
  if (!before) {
    res.status(404).json({ message: "Row not found" });
    return;
  }
  const updates: Partial<typeof before> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name.trim();
  if (parsed.data.category !== undefined) updates.category = parsed.data.category;
  if (parsed.data.applicationId !== undefined) {
    if (parsed.data.applicationId != null) {
      const [app] = await db
        .select()
        .from(applicationsTable)
        .where(eq(applicationsTable.id, parsed.data.applicationId));
      if (!app) {
        res.status(400).json({ message: "Application not found" });
        return;
      }
    }
    updates.applicationId = parsed.data.applicationId;
  }
  const [row] = await db
    .update(raciRowsTable)
    .set(updates)
    .where(eq(raciRowsTable.id, id))
    .returning();
  const changes: string[] = [];
  if (updates.name !== undefined && updates.name !== before.name) {
    changes.push(`renamed "${before.name}" to "${updates.name}"`);
  }
  if (updates.category !== undefined && updates.category !== before.category) {
    changes.push(
      `moved "${row!.name}" to category ${updates.category ?? "(none)"}`,
    );
  }
  if (
    updates.applicationId !== undefined &&
    updates.applicationId !== before.applicationId
  ) {
    changes.push(
      updates.applicationId != null
        ? `linked "${row!.name}" to an application`
        : `unlinked "${row!.name}" from its application`,
    );
  }
  if (changes.length > 0) {
    await logRaciChange(
      user.id,
      `RACI: ${changes.join("; ")}`,
      row!.applicationId ?? null,
    );
  }
  let appName: string | null = null;
  if (row!.applicationId != null) {
    const [app] = await db
      .select({ name: applicationsTable.name })
      .from(applicationsTable)
      .where(eq(applicationsTable.id, row!.applicationId));
    appName = app?.name ?? null;
  }
  const assignments = await db
    .select({ memberId: raciAssignmentsTable.memberId, value: raciAssignmentsTable.value })
    .from(raciAssignmentsTable)
    .where(eq(raciAssignmentsTable.rowId, id));
  res.json({
    id: row!.id,
    teamId: row!.teamId,
    category: row!.category ?? null,
    name: row!.name,
    sortOrder: row!.sortOrder,
    applicationId: row!.applicationId ?? null,
    appName,
    assignments,
  });
});

router.delete("/raci/rows/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ message: "Invalid row id" });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const [row] = await db.select().from(raciRowsTable).where(eq(raciRowsTable.id, id));
  if (!row) {
    res.status(404).json({ message: "Row not found" });
    return;
  }
  await db.delete(raciAssignmentsTable).where(eq(raciAssignmentsTable.rowId, id));
  await db.delete(raciRowsTable).where(eq(raciRowsTable.id, id));
  await logRaciChange(user.id, `RACI: removed "${row.name}"`, row.applicationId ?? null);
  res.json({ message: "Row removed" });
});

router.post("/raci/members", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateRaciMemberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const { teamId, name } = parsed.data;
  const [team] = await db.select().from(raciTeamsTable).where(eq(raciTeamsTable.id, teamId));
  if (!team) {
    res.status(400).json({ message: "Team not found" });
    return;
  }
  const existing = await db
    .select()
    .from(raciMembersTable)
    .where(eq(raciMembersTable.teamId, teamId));
  if (existing.some((m) => m.name.trim().toLowerCase() === name.trim().toLowerCase())) {
    res.status(400).json({ message: "That member is already on this team" });
    return;
  }
  const sortOrder = existing.reduce((max, m) => Math.max(max, m.sortOrder), 0) + 1;
  const [member] = await db
    .insert(raciMembersTable)
    .values({ teamId, name: name.trim(), sortOrder })
    .returning();
  await logRaciChange(user.id, `RACI: added member ${name.trim()} to ${team.name}`);
  res.json({
    id: member!.id,
    teamId,
    name: member!.name,
    userId: member!.userId ?? null,
    sortOrder,
  });
});

router.patch("/raci/members/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ message: "Invalid member id" });
    return;
  }
  const parsed = UpdateRaciMemberBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const [before] = await db
    .select()
    .from(raciMembersTable)
    .where(eq(raciMembersTable.id, id));
  if (!before) {
    res.status(404).json({ message: "Member not found" });
    return;
  }
  const [member] = await db
    .update(raciMembersTable)
    .set({ name: parsed.data.name.trim() })
    .where(eq(raciMembersTable.id, id))
    .returning();
  if (before.name !== member!.name) {
    await logRaciChange(
      user.id,
      `RACI: renamed member ${before.name} to ${member!.name}`,
    );
  }
  res.json({
    id: member!.id,
    teamId: member!.teamId,
    name: member!.name,
    userId: member!.userId ?? null,
    sortOrder: member!.sortOrder,
  });
});

router.delete("/raci/members/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ message: "Invalid member id" });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const [member] = await db
    .select()
    .from(raciMembersTable)
    .where(eq(raciMembersTable.id, id));
  if (!member) {
    res.status(404).json({ message: "Member not found" });
    return;
  }
  await db.delete(raciAssignmentsTable).where(eq(raciAssignmentsTable.memberId, id));
  await db.delete(raciMembersTable).where(eq(raciMembersTable.id, id));
  await logRaciChange(user.id, `RACI: removed member ${member.name}`);
  res.json({ message: "Member removed" });
});

router.put("/raci/cells", requireAdmin, async (req, res): Promise<void> => {
  const parsed = SetRaciCellBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }
  const user = (req as Request & { user: User }).user;
  const { rowId, memberId, value, expectedValue } = parsed.data;
  const [row] = await db.select().from(raciRowsTable).where(eq(raciRowsTable.id, rowId));
  if (!row) {
    res.status(404).json({ message: "Row not found" });
    return;
  }
  const [member] = await db
    .select()
    .from(raciMembersTable)
    .where(eq(raciMembersTable.id, memberId));
  if (!member || member.teamId !== row.teamId) {
    res.status(404).json({ message: "Member not found on this row's team" });
    return;
  }
  const cellCond = and(
    eq(raciAssignmentsTable.rowId, rowId),
    eq(raciAssignmentsTable.memberId, memberId),
  );
  const [existing] = await db.select().from(raciAssignmentsTable).where(cellCond);
  const beforeValue = existing?.value ?? null;
  // Optimistic concurrency: if the client told us what it last saw and the
  // stored value has since changed, reject instead of silently overwriting
  // another admin's concurrent edit.
  if (expectedValue !== undefined && (expectedValue ?? null) !== beforeValue) {
    res.status(409).json({
      message: "This cell was just changed by another admin",
      currentValue: beforeValue,
    });
    return;
  }
  if (value == null) {
    await db.delete(raciAssignmentsTable).where(cellCond);
  } else if (existing) {
    await db.update(raciAssignmentsTable).set({ value }).where(cellCond);
  } else {
    await db.insert(raciAssignmentsTable).values({ rowId, memberId, value });
  }
  if (beforeValue !== (value ?? null)) {
    await logRaciChange(
      user.id,
      `RACI: ${member.name} on "${row.name}" set to ${value ?? "blank"} (was ${beforeValue ?? "blank"})`,
      row.applicationId ?? null,
    );
  }
  res.json({ rowId, memberId, value: value ?? null });
});

router.post(
  "/raci/teams/:id/rename-category",
  requireAdmin,
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ message: "Invalid team id" });
      return;
    }
    const parsed = RenameRaciCategoryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.message });
      return;
    }
    const user = (req as Request & { user: User }).user;
    const [team] = await db.select().from(raciTeamsTable).where(eq(raciTeamsTable.id, id));
    if (!team) {
      res.status(404).json({ message: "Team not found" });
      return;
    }
    const updated = await db
      .update(raciRowsTable)
      .set({ category: parsed.data.to.trim() })
      .where(
        and(eq(raciRowsTable.teamId, id), eq(raciRowsTable.category, parsed.data.from)),
      )
      .returning();
    if (updated.length === 0) {
      res.status(404).json({ message: "Category not found on this team" });
      return;
    }
    await logRaciChange(
      user.id,
      `RACI: renamed category "${parsed.data.from}" to "${parsed.data.to.trim()}" in ${team.name}`,
    );
    res.json({ message: "Category renamed" });
  },
);

export default router;
