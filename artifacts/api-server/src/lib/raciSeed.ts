import { eq } from "drizzle-orm";
import {
  db,
  raciTeamsTable,
  raciMembersTable,
  raciRowsTable,
  raciAssignmentsTable,
  applicationsTable,
  usersTable,
  RACI_VALUES,
  type RaciValue,
} from "@workspace/db";
import { logger } from "./logger";
import seedData from "../data/raciSeed.json";

type SeedAssignment = { member: string; value: string };
type SeedRow = { name: string; category: string | null; assignments: SeedAssignment[] };
type SeedTeam = { name: string; members: string[]; rows: SeedRow[] };

const VALID = new Set<string>(RACI_VALUES);

/**
 * One-time seed of the RACI matrix from the IT team's spreadsheet (imported
 * at build time as checked-in JSON). Runs only while the raci_teams table is
 * empty, so user edits are never overwritten. Member names are matched to
 * dashboard accounts by name where possible; rows whose names match an
 * application in the Clever list are linked to it.
 */
export async function seedRaciIfEmpty(): Promise<void> {
  const existing = await db.select().from(raciTeamsTable);
  if (existing.length > 0) return;

  const users = await db
    .select({ id: usersTable.id, displayName: usersTable.displayName })
    .from(usersTable);
  const apps = await db
    .select({ id: applicationsTable.id, name: applicationsTable.name })
    .from(applicationsTable);
  const appByName = new Map(apps.map((a) => [a.name.trim().toLowerCase(), a.id]));

  const matchUser = (memberName: string): number | null => {
    // Spreadsheet columns use first names (plus e.g. "OakSchool(Katie)").
    const wanted = memberName.trim().toLowerCase().replace(/\(.*\)$/, "").trim();
    const exact = users.filter((u) => u.displayName.trim().toLowerCase() === wanted);
    if (exact.length === 1) return exact[0]!.id;
    const byFirst = users.filter(
      (u) => u.displayName.trim().toLowerCase().split(/\s+/)[0] === wanted,
    );
    return byFirst.length === 1 ? byFirst[0]!.id : null;
  };

  const teams = seedData as SeedTeam[];
  let rowCount = 0;
  let cellCount = 0;
  for (let t = 0; t < teams.length; t++) {
    const team = teams[t]!;
    const [teamRow] = await db
      .insert(raciTeamsTable)
      .values({ name: team.name, sortOrder: t })
      .returning();
    const memberIds = new Map<string, number>();
    for (let m = 0; m < team.members.length; m++) {
      const name = team.members[m]!;
      const [member] = await db
        .insert(raciMembersTable)
        .values({
          teamId: teamRow!.id,
          name,
          userId: matchUser(name),
          sortOrder: m,
        })
        .returning();
      memberIds.set(name, member!.id);
    }
    for (let r = 0; r < team.rows.length; r++) {
      const row = team.rows[r]!;
      const applicationId = appByName.get(row.name.trim().toLowerCase()) ?? null;
      const [rowRec] = await db
        .insert(raciRowsTable)
        .values({
          teamId: teamRow!.id,
          name: row.name,
          category: row.category,
          sortOrder: r,
          applicationId,
        })
        .returning();
      rowCount++;
      for (const a of row.assignments) {
        const memberId = memberIds.get(a.member);
        if (memberId == null || !VALID.has(a.value)) continue;
        await db.insert(raciAssignmentsTable).values({
          rowId: rowRec!.id,
          memberId,
          value: a.value as RaciValue,
        });
        cellCount++;
      }
    }
  }
  logger.info(
    { teams: teams.length, rows: rowCount, cells: cellCount },
    "Seeded RACI matrix from IT team spreadsheet",
  );
}
