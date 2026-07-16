import { eq, inArray } from "drizzle-orm";
import {
  db,
  raciRowsTable,
  raciMembersTable,
  raciAssignmentsTable,
} from "@workspace/db";

export interface RaciPerson {
  name: string;
  value: string;
}

const RACI_ORDER: Record<string, number> = { A: 0, R: 1, C: 2, I: 3, "N/A": 4 };

/**
 * RACI people for each linked application (from the RACI matrix page).
 * Returns a map of applicationId -> people, sorted A, R, C, I then by name.
 * When `applicationIds` is provided, only assignments for those applications
 * are loaded. An empty list short-circuits to an empty map.
 */
export async function getRaciPeopleByApp(
  applicationIds?: number[],
): Promise<Map<number, RaciPerson[]>> {
  if (applicationIds && applicationIds.length === 0) {
    return new Map();
  }
  const base = db
    .select({
      applicationId: raciRowsTable.applicationId,
      memberName: raciMembersTable.name,
      value: raciAssignmentsTable.value,
    })
    .from(raciAssignmentsTable)
    .innerJoin(raciRowsTable, eq(raciAssignmentsTable.rowId, raciRowsTable.id))
    .innerJoin(raciMembersTable, eq(raciAssignmentsTable.memberId, raciMembersTable.id));
  const raciCells = applicationIds
    ? await base.where(inArray(raciRowsTable.applicationId, applicationIds))
    : await base;

  const raciMap = new Map<number, RaciPerson[]>();
  for (const cell of raciCells) {
    if (cell.applicationId == null || cell.value === "N/A") continue;
    if (!raciMap.has(cell.applicationId)) raciMap.set(cell.applicationId, []);
    const list = raciMap.get(cell.applicationId)!;
    if (!list.some((p) => p.name === cell.memberName && p.value === cell.value)) {
      list.push({ name: cell.memberName, value: cell.value });
    }
  }
  for (const list of raciMap.values()) {
    list.sort(
      (a, b) =>
        (RACI_ORDER[a.value] ?? 9) - (RACI_ORDER[b.value] ?? 9) ||
        a.name.localeCompare(b.name),
    );
  }
  return raciMap;
}
