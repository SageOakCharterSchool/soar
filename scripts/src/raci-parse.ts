/**
 * Parser for the IT team's RACI spreadsheet.
 *
 * Structure of each sheet:
 * - A legend row (and, on some sheets, a project-description row) precede the
 *   header row, which starts with "Decision or Task" followed by one column
 *   per team member.
 * - Data rows follow. Rows whose first cell has the purple fill (D9D2E9) are
 *   category headers; everything after a category header belongs to it until
 *   the next one. A category header that itself carries R/A/C/I cells is also
 *   imported as a task row under its own category (the spreadsheet does this
 *   for e.g. "ROSTERING").
 * - Cells hold R, A, C, I, or N/A.
 */
import xlsxPkg from "xlsx";
import type { WorkBook, WorkSheet } from "xlsx";

// xlsx ships CJS; under ESM the API lives on the default export.
const XLSX = xlsxPkg;

export const CATEGORY_FILL = "D9D2E9";

export type ParsedAssignment = { member: string; value: string };
export type ParsedRow = {
  name: string;
  category: string | null;
  assignments: ParsedAssignment[];
};
export type ParsedTeam = {
  name: string;
  members: string[];
  rows: ParsedRow[];
};

const VALID_VALUES = new Set(["R", "A", "C", "I", "N/A"]);

function normalizeValue(raw: unknown): string | null {
  if (raw == null) return null;
  const v = String(raw).trim().toUpperCase();
  if (v === "NA" || v === "N/A") return "N/A";
  return VALID_VALUES.has(v) ? v : null;
}

function cellFill(ws: WorkSheet, addr: string): string | null {
  const cell = ws[addr] as
    | { s?: { fgColor?: { rgb?: string }; patternType?: string } }
    | undefined;
  const s = cell?.s;
  if (!s || s.patternType !== "solid") return null;
  return s.fgColor?.rgb ?? null;
}

export function parseRaciWorkbook(wb: WorkBook): ParsedTeam[] {
  const teams: ParsedTeam[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<(unknown | null)[]>(ws, {
      header: 1,
      defval: null,
    });

    const headerIdx = rows.findIndex(
      (r) => typeof r[0] === "string" && String(r[0]).trim() === "Decision or Task",
    );
    if (headerIdx === -1) {
      throw new Error(`Sheet "${sheetName}" has no "Decision or Task" header row`);
    }
    const header = rows[headerIdx]!;
    const members: string[] = [];
    const memberCols: number[] = [];
    for (let c = 1; c < header.length; c++) {
      const name = header[c];
      if (typeof name === "string" && name.trim() !== "") {
        members.push(name.trim());
        memberCols.push(c);
      }
    }

    const parsedRows: ParsedRow[] = [];
    let category: string | null = null;
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r]!;
      const rawName = row[0];
      if (rawName == null || String(rawName).trim() === "") continue;
      const name = String(rawName).trim();

      const assignments: ParsedAssignment[] = [];
      memberCols.forEach((c, i) => {
        const value = normalizeValue(row[c]);
        if (value) assignments.push({ member: members[i]!, value });
      });

      const addr = XLSX.utils.encode_cell({ r, c: 0 });
      const isCategory = cellFill(ws, addr) === CATEGORY_FILL;
      if (isCategory) {
        category = name;
        // A category header that carries assignments is also a real task row.
        if (assignments.length > 0) {
          parsedRows.push({ name, category, assignments });
        }
        continue;
      }
      parsedRows.push({ name, category, assignments });
    }

    teams.push({ name: sheetName, members, rows: parsedRows });
  }
  return teams;
}

export function parseRaciFile(path: string): ParsedTeam[] {
  return parseRaciWorkbook(XLSX.readFile(path, { cellStyles: true }));
}
