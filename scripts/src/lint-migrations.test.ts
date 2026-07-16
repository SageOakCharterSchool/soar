import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lintMigrationsDir } from "./lint-migrations";

const tempDirs: string[] = [];

function makeMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lint-migrations-test-"));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function rulesFound(files: Record<string, string>): string[] {
  return lintMigrationsDir(makeMigrationsDir(files)).map((f) => f.rule);
}

describe("lintMigrationsDir destructive patterns", () => {
  it("flags DROP TABLE", () => {
    expect(rulesFound({ "0001_a.sql": 'DROP TABLE "users";' })).toEqual(["DROP TABLE"]);
  });

  it("flags DROP TABLE IF EXISTS", () => {
    expect(rulesFound({ "0001_a.sql": 'DROP TABLE IF EXISTS "users" CASCADE;' })).toEqual([
      "DROP TABLE",
    ]);
  });

  it("flags ALTER TABLE ... DROP COLUMN", () => {
    expect(
      rulesFound({ "0001_a.sql": 'ALTER TABLE "users" DROP COLUMN "email";' }),
    ).toEqual(["DROP COLUMN"]);
  });

  it("flags TRUNCATE", () => {
    expect(rulesFound({ "0001_a.sql": 'TRUNCATE "sync_history";' })).toEqual(["TRUNCATE"]);
  });

  it("flags lossy ALTER COLUMN ... TYPE", () => {
    expect(
      rulesFound({
        "0001_a.sql": 'ALTER TABLE "users" ALTER COLUMN "name" TYPE varchar(10);',
      }),
    ).toEqual(["ALTER COLUMN TYPE"]);
  });

  it("flags ALTER COLUMN ... SET DATA TYPE", () => {
    expect(
      rulesFound({
        "0001_a.sql": 'ALTER TABLE "users" ALTER COLUMN "amount" SET DATA TYPE integer;',
      }),
    ).toEqual(["ALTER COLUMN TYPE"]);
  });

  it("flags DELETE without WHERE", () => {
    expect(rulesFound({ "0001_a.sql": 'DELETE FROM "sessions";' })).toEqual([
      "DELETE without WHERE",
    ]);
  });

  it("flags DROP SCHEMA", () => {
    expect(rulesFound({ "0001_a.sql": 'DROP SCHEMA "old" CASCADE;' })).toEqual([
      "DROP SCHEMA/DATABASE",
    ]);
  });

  it("flags DROP DATABASE", () => {
    expect(rulesFound({ "0001_a.sql": "DROP DATABASE olddb;" })).toEqual([
      "DROP SCHEMA/DATABASE",
    ]);
  });

  it("is case-insensitive", () => {
    expect(rulesFound({ "0001_a.sql": "drop table users;" })).toEqual(["DROP TABLE"]);
  });
});

describe("destructive marker allows a statement", () => {
  it("allows a flagged statement carrying a -- destructive: marker", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          '-- destructive: column is unused, data archived to backups table\nALTER TABLE "users" DROP COLUMN "legacy_id";',
      }),
    ).toEqual([]);
  });

  it("marker only covers its own statement block, not others in the same file", () => {
    const sql = [
      '-- destructive: table replaced by users_v2\nDROP TABLE "users_old";',
      'DROP TABLE "users";',
    ].join("\n--> statement-breakpoint\n");
    const findings = lintMigrationsDir(makeMigrationsDir({ "0001_a.sql": sql }));
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("DROP TABLE");
    expect(findings[0].statementIndex).toBe(2);
  });

  it("a bare '-- destructive:' marker without a reason does not allow the statement", () => {
    expect(
      rulesFound({ "0001_a.sql": '-- destructive:\nDROP TABLE "users";' }),
    ).toEqual(["DROP TABLE"]);
  });
});

describe("non-destructive statements are not flagged", () => {
  it("does not flag DELETE with WHERE", () => {
    expect(
      rulesFound({ "0001_a.sql": "DELETE FROM sessions WHERE expires_at < now();" }),
    ).toEqual([]);
  });

  it("does not flag plain CREATE statements", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          'CREATE TABLE "users" ("id" serial PRIMARY KEY, "name" text);\n--> statement-breakpoint\nCREATE INDEX idx_users_name ON "users" ("name");',
      }),
    ).toEqual([]);
  });

  it("does not flag ALTER TABLE ADD COLUMN", () => {
    expect(
      rulesFound({ "0001_a.sql": 'ALTER TABLE "users" ADD COLUMN "nickname" text;' }),
    ).toEqual([]);
  });
});

describe("comments and string literals do not cause false positives", () => {
  it("ignores destructive keywords inside line comments", () => {
    expect(
      rulesFound({
        "0001_a.sql": '-- this used to DROP TABLE users\nCREATE TABLE "users" ("id" serial);',
      }),
    ).toEqual([]);
  });

  it("ignores destructive keywords inside block comments", () => {
    expect(
      rulesFound({
        "0001_a.sql": '/* TRUNCATE was considered here */\nCREATE TABLE "logs" ("id" serial);',
      }),
    ).toEqual([]);
  });

  it("ignores destructive keywords inside single-quoted string literals", () => {
    expect(
      rulesFound({
        "0001_a.sql": "INSERT INTO audit_log (note) VALUES ('operator ran DROP TABLE manually');",
      }),
    ).toEqual([]);
  });

  it("still flags real DDL inside dollar-quoted DO blocks", () => {
    expect(
      rulesFound({
        "0001_a.sql": "DO $$ BEGIN DROP TABLE users; END $$;",
      }),
    ).toEqual(["DROP TABLE"]);
  });
});

describe("multi-file behavior", () => {
  it("only scans .sql files and reports the file name", () => {
    const findings = lintMigrationsDir(
      makeMigrationsDir({
        "0001_ok.sql": 'CREATE TABLE "a" ("id" serial);',
        "0002_bad.sql": 'DROP TABLE "a";',
        "notes.txt": "DROP TABLE ignored;",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("0002_bad.sql");
  });
});
