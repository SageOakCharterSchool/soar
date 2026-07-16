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

/**
 * True when the (comment/string-stripped) SQL contains an UPDATE statement
 * whose own statement has no top-level WHERE clause. Uses the same
 * statement-splitting / paren-depth approach as hasDeleteWithoutWhere, and
 * ignores "ON UPDATE" (FK actions) and "FOR UPDATE" (row locks), which are
 * not UPDATE statements.
 */
export function hasUpdateWithoutWhere(cleanedSql: string): boolean {
  for (const statement of cleanedSql.split(";")) {
    const updateRe = /\bUPDATE\b/gi;
    let match: RegExpExecArray | null = null;
    while ((match = updateRe.exec(statement)) !== null) {
      const before = statement.slice(0, match.index).trimEnd();
      if (/\b(ON|FOR)$/i.test(before)) continue;
      break;
    }
    if (!match) continue;
    const rest = statement.slice(match.index + match[0].length);
    if (!/\bSET\b/i.test(rest)) continue;
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

/**
 * True when the (comment/string-stripped) SQL contains a PL/pgSQL EXECUTE with
 * dynamically built SQL inside a dollar-quoted body (e.g. a DO block).
 *
 * After stripping, a constant string literal becomes exactly '' — so
 * `EXECUTE 'CREATE INDEX ...'` reduces to `EXECUTE ''` and is treated as
 * constant (constant strings are visible verbatim in the raw SQL, so a
 * reviewer can see exactly what they run).
 * Anything else after EXECUTE (format(...), concatenation with || , a
 * variable) means the SQL is assembled at runtime, where destructive
 * statements can hide from this lint.
 *
 * `EXECUTE FUNCTION` / `EXECUTE PROCEDURE` (trigger definitions) and
 * `GRANT/REVOKE ... EXECUTE` are not dynamic SQL and are ignored.
 *
 * Scope: this intentionally covers ALL dollar-quoted procedural bodies, not
 * just DO blocks — dynamic SQL inside CREATE FUNCTION bodies shipped by a
 * migration is just as capable of hiding destructive statements.
 */
export function hasDynamicExecute(cleanedSql: string): boolean {
  const bodyRe = /\$([A-Za-z_0-9]*)\$([\s\S]*?)\$\1\$/g;
  let bodyMatch: RegExpExecArray | null;
  while ((bodyMatch = bodyRe.exec(cleanedSql)) !== null) {
    const body = bodyMatch[2];
    const execRe = /\bEXECUTE\b/gi;
    let m: RegExpExecArray | null;
    while ((m = execRe.exec(body)) !== null) {
      const before = body.slice(0, m.index);
      if (/\b(GRANT|REVOKE)\b[^;]*$/i.test(before)) continue;
      const rest = body.slice(m.index + m[0].length).trimStart();
      if (/^(FUNCTION|PROCEDURE)\b/i.test(rest)) continue;
      // Constant: a single string literal (stripped single-quoted '' or a
      // dollar-quoted literal) followed by end of statement or INTO/USING.
      if (/^''\s*(;|INTO\b|USING\b|$)/i.test(rest)) continue;
      if (/^\$([A-Za-z_0-9]*)\$[\s\S]*?\$\1\$\s*(;|INTO\b|USING\b|$)/i.test(rest)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Extract the SQL contents of constant EXECUTE string literals inside
 * dollar-quoted procedural bodies (DO blocks, CREATE FUNCTION bodies) from the
 * RAW (unstripped) SQL. hasDynamicExecute treats constant strings as safe from
 * a "hidden dynamic SQL" perspective, but their contents can still be
 * destructive (e.g. EXECUTE 'DROP TABLE users';) — so the extracted contents
 * are run through the same destructive rules as top-level SQL.
 *
 * Handles both single-quoted literals (with '' escapes) and dollar-quoted
 * literals. Skips EXECUTE FUNCTION/PROCEDURE and GRANT/REVOKE ... EXECUTE,
 * matching hasDynamicExecute.
 */
export function extractConstantExecuteSql(rawSql: string): string[] {
  const contents: string[] = [];
  const bodyRe = /\$([A-Za-z_0-9]*)\$([\s\S]*?)\$\1\$/g;
  let bodyMatch: RegExpExecArray | null;
  while ((bodyMatch = bodyRe.exec(rawSql)) !== null) {
    const body = bodyMatch[2];
    const execRe = /\bEXECUTE\b/gi;
    let m: RegExpExecArray | null;
    while ((m = execRe.exec(body)) !== null) {
      const before = body.slice(0, m.index);
      if (/\b(GRANT|REVOKE)\b[^;]*$/i.test(before)) continue;
      const rest = body.slice(m.index + m[0].length).trimStart();
      if (/^(FUNCTION|PROCEDURE)\b/i.test(rest)) continue;
      // Only a lone literal (followed by end of statement, INTO, or USING) is
      // constant; a literal followed by || etc. is part of dynamic SQL, which
      // hasDynamicExecute already flags.
      const single = /^'((?:[^']|'')*)'\s*(?:;|INTO\b|USING\b|$)/i.exec(rest);
      if (single) {
        contents.push(single[1].replace(/''/g, "'"));
        continue;
      }
      const dollar = /^\$([A-Za-z_0-9]*)\$([\s\S]*?)\$\1\$\s*(?:;|INTO\b|USING\b|$)/i.exec(rest);
      if (dollar) contents.push(dollar[2]);
    }
  }
  return contents;
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
    name: "UPDATE without WHERE",
    check: hasUpdateWithoutWhere,
    message: "UPDATE without a WHERE clause overwrites every row in the table.",
  },
  {
    name: "Dynamic EXECUTE",
    check: hasDynamicExecute,
    message:
      "EXECUTE with dynamically built SQL (format(), ||, variables) inside a DO block can hide destructive operations from this lint.",
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
      // Constant EXECUTE string literals are stripped to '' above, but their
      // contents can still be destructive — scan them with the same rules.
      const executeSql = extractConstantExecuteSql(stmt)
        .map((s) => stripCommentsAndStrings(s).trim())
        .filter(Boolean)
        .join(";\n");
      const scanned = executeSql ? `${cleaned}\n;${executeSql};` : cleaned;
      for (const rule of RULES) {
        const matched = rule.check ? rule.check(scanned) : rule.pattern!.test(scanned);
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
