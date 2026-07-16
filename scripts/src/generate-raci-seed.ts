/**
 * One-time generator: parses the IT team's RACI spreadsheet and writes the
 * checked-in seed JSON the API server imports on first boot (when the RACI
 * tables are still empty).
 *
 * Usage: pnpm --filter @workspace/scripts generate-raci-seed [path-to-xlsx]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRaciFile } from "./raci-parse";

const source =
  process.argv[2] ?? "attached_assets/IT_Team_RACI_1784220382220.xlsx";
const outPath = resolve("../artifacts/api-server/src/data/raciSeed.json");

const teams = parseRaciFile(resolve("..", source));
writeFileSync(outPath, JSON.stringify(teams, null, 2) + "\n");

const rowCount = teams.reduce((n, t) => n + t.rows.length, 0);
const cellCount = teams.reduce(
  (n, t) => n + t.rows.reduce((m, r) => m + r.assignments.length, 0),
  0,
);
console.log(
  `Wrote ${outPath}: ${teams.length} teams, ${rowCount} rows, ${cellCount} assignments`,
);
