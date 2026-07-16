/**
 * Destructive-migration lint.
 *
 * Scans every migration SQL file in lib/db/migrations for statements that
 * can delete or corrupt existing data:
 *
 *   - DROP TABLE
 *   - ALTER TABLE ... DROP COLUMN
 *   - TRUNCATE
 *   - ALTER TABLE ... ALTER COLUMN ... TYPE (potentially lossy type change)
 *   - DELETE FROM without WHERE
 *   - DROP SCHEMA / DROP DATABASE
 *
 * A flagged statement is allowed only when the statement block carries an
 * explicit marker comment acknowledging the risk:
 *
 *   -- destructive: <reason it is safe / plan for existing data>
 *
 * Run standalone with: pnpm --filter @workspace/scripts lint-migrations
 * Also runs automatically as the first phase of verify-migrations.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDir = path.resolve(here, "../../lib/db/migrations");

const ALLOW_MARKER = /--[ \t]*destructive:[ \t]*\S+/i;

interface Rule {
  name: string;
  message: string;
  pattern?: RegExp;
  check?: (cleanedSql: string) => boolean;
}

/**
 * True when the (comment/string-stripped) SQL contains a DELETE FROM whose own
 * statement has no top-level WHERE clause. Splits on semicolons so a later
 * statement's WHERE cannot mask an earlier unqualified DELETE, and ignores
 * WHERE clauses nested inside parentheses (subqueries), which do not qualify
 * the outer DELETE.
 */
export function hasDeleteWithoutWhere(cleanedSql: string): boolean {
  for (const statement of cleanedSql.split(";")) {
    const deleteMatch = /\bDELETE\s+FROM\b/i.exec(statement);
    if (!deleteMatch) continue;
    const rest = statement.slice(deleteMatch.index + deleteMatch[0].length);
    let depth = 0;
    let topLevelWhere = false;
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (
        depth === 0 &&
        /^where\b/i.test(rest.slice(i, i + 6)) &&
        (i === 0 || /[\s)]/.test(rest[i - 1]))
      ) {
        topLevelWhere = true;
        break;
      }
    }
    if (!topLevelWhere) return true;
  }
  return false;
}

const RULES: Rule[] = [
  {
    name: "DROP TABLE",
    pattern: /\bDROP\s+TABLE\b/i,
    message: "Dropping a table permanently deletes all of its rows.",
  },
  {
    name: "DROP COLUMN",
    pattern: /\bDROP\s+COLUMN\b/i,
    message: "Dropping a column permanently deletes the data stored in it.",
  },
  {
    name: "TRUNCATE",
    pattern: /\bTRUNCATE\b/i,
    message: "TRUNCATE deletes every row in the table.",
  },
  {
    name: "ALTER COLUMN TYPE",
    pattern: /\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i,
    message:
      "Changing a column's type can silently truncate or corrupt existing values (e.g. text -> varchar(n), numeric -> integer).",
  },
  {
    name: "DELETE without WHERE",
    check: hasDeleteWithoutWhere,
    message: "DELETE FROM without a WHERE clause removes every row in the table.",
  },
  {
    name: "DROP SCHEMA/DATABASE",
    pattern: /\bDROP\s+(SCHEMA|DATABASE)\b/i,
    message: "Dropping a schema or database destroys everything inside it.",
  },
];

/** Strip SQL comments and string literals so patterns only match real SQL. */
function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''") // single-quoted strings
    .replace(/\$\$[\s\S]*?\$\$/g, (m) => {
      // keep dollar-quoted bodies: they can contain real DDL (DO $$ ... $$)
      return m;
    })
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

export interface LintFinding {
  file: string;
  statementIndex: number;
  rule: string;
  message: string;
  snippet: string;
}

export function lintMigrationsDir(migrationsDir = defaultMigrationsDir): LintFinding[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const findings: LintFinding[] = [];
  for (const file of files) {
    const sqlText = readFileSync(path.join(migrationsDir, file), "utf8");
    const statements = sqlText.split("--> statement-breakpoint");
    statements.forEach((rawStmt, idx) => {
      const stmt = rawStmt.trim();
      if (!stmt) return;
      const allowed = ALLOW_MARKER.test(rawStmt);
      const cleaned = stripCommentsAndStrings(stmt);
      for (const rule of RULES) {
        const matched = rule.check ? rule.check(cleaned) : rule.pattern!.test(cleaned);
        if (matched) {
          if (allowed) continue;
          findings.push({
            file,
            statementIndex: idx + 1,
            rule: rule.name,
            message: rule.message,
            snippet: stmt.split("\n").slice(0, 3).join("\n").slice(0, 200),
          });
        }
      }
    });
  }
  return findings;
}

export function runLint(migrationsDir = defaultMigrationsDir): boolean {
  const findings = lintMigrationsDir(migrationsDir);
  if (findings.length === 0) {
    console.log("Destructive-migration lint: no destructive statements found.");
    return true;
  }
  console.error(
    `\nDestructive-migration lint FAILED: ${findings.length} potentially destructive statement(s) found.\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file} (statement ${f.statementIndex}): ${f.rule}`);
    console.error(`    ${f.message}`);
    console.error(`    > ${f.snippet.replace(/\n/g, "\n    > ")}\n`);
  }
  console.error(
    "If a destructive change is intentional and existing data has been accounted for,\n" +
      "add a marker comment INSIDE the flagged statement block explaining why it is safe:\n\n" +
      "  -- destructive: <reason / plan for existing data>\n" +
      "  ALTER TABLE ... DROP COLUMN ...;\n\n" +
      "See lib/db/migrations/README.md for details.",
  );
  return false;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(runLint() ? 0 : 1);
}
