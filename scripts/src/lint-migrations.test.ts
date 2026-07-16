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

  it("flags DELETE without WHERE followed by another statement with WHERE in the same block", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          'DELETE FROM "sessions";\nUPDATE "users" SET active = false WHERE last_login < now();',
      }),
    ).toEqual(["DELETE without WHERE"]);
  });

  it("flags DELETE without WHERE followed by a qualified DELETE in the same block", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          'DELETE FROM "sessions";\nDELETE FROM "tokens" WHERE expires_at < now();',
      }),
    ).toEqual(["DELETE without WHERE"]);
  });

  it("flags DELETE whose only WHERE is inside a subquery", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          'DELETE FROM "sessions" USING (SELECT id FROM "users" WHERE banned) u;',
      }),
    ).toEqual(["DELETE without WHERE"]);
  });

  it("flags DELETE whose only WHERE is in a subquery in the target list", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DELETE FROM sessions RETURNING (SELECT name FROM users WHERE users.id = sessions.user_id);",
      }),
    ).toEqual(["DELETE without WHERE"]);
  });

  it("flags UPDATE without WHERE", () => {
    expect(rulesFound({ "0001_a.sql": 'UPDATE "users" SET active = false;' })).toEqual([
      "UPDATE without WHERE",
    ]);
  });

  it("flags a multi-line UPDATE without WHERE", () => {
    expect(
      rulesFound({
        "0001_a.sql": 'UPDATE "users"\nSET active = false,\n  role = \'member\';',
      }),
    ).toEqual(["UPDATE without WHERE"]);
  });

  it("flags UPDATE without WHERE followed by a qualified UPDATE in the same block", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          'UPDATE "users" SET active = false;\nUPDATE "users" SET role = \'x\' WHERE id = 1;',
      }),
    ).toEqual(["UPDATE without WHERE"]);
  });

  it("flags UPDATE whose only WHERE is inside a subquery", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "UPDATE users SET banned = (SELECT count(*) FROM logins WHERE failed) > 3;",
      }),
    ).toEqual(["UPDATE without WHERE"]);
  });

  it("flags real UPDATE without WHERE inside dollar-quoted DO blocks", () => {
    expect(
      rulesFound({
        "0001_a.sql": "DO $$ BEGIN UPDATE users SET active = false; END $$;",
      }),
    ).toEqual(["UPDATE without WHERE"]);
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

  it("does not flag a multi-line DELETE with a top-level WHERE", () => {
    expect(
      rulesFound({
        "0001_a.sql": 'DELETE FROM "sessions"\nWHERE expires_at < now()\n  AND user_id IS NULL;',
      }),
    ).toEqual([]);
  });

  it("does not flag DELETE with WHERE ... IN (subquery)", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE banned);",
      }),
    ).toEqual([]);
  });

  it("does not flag DELETE USING with a top-level WHERE after the subquery", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DELETE FROM sessions USING (SELECT id FROM users WHERE banned) u WHERE sessions.user_id = u.id;",
      }),
    ).toEqual([]);
  });

  it("does not flag UPDATE with WHERE", () => {
    expect(
      rulesFound({ "0001_a.sql": "UPDATE users SET active = false WHERE id = 1;" }),
    ).toEqual([]);
  });

  it("does not flag a multi-line UPDATE with a top-level WHERE", () => {
    expect(
      rulesFound({
        "0001_a.sql": 'UPDATE "users"\nSET active = false\nWHERE last_login < now();',
      }),
    ).toEqual([]);
  });

  it("does not flag UPDATE with WHERE ... IN (subquery)", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "UPDATE users SET banned = true WHERE id IN (SELECT user_id FROM abuse WHERE score > 9);",
      }),
    ).toEqual([]);
  });

  it("does not flag UPDATE FROM with a top-level WHERE after a subquery", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "UPDATE users SET role = r.role FROM (SELECT id, role FROM staged WHERE ready) r WHERE users.id = r.id;",
      }),
    ).toEqual([]);
  });

  it("does not flag ON UPDATE foreign-key actions", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          'ALTER TABLE "sessions" ADD CONSTRAINT fk FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      }),
    ).toEqual([]);
  });

  it("does not flag SELECT ... FOR UPDATE", () => {
    expect(
      rulesFound({
        "0001_a.sql": "DO $$ BEGIN PERFORM 1 FROM users FOR UPDATE; END $$;",
      }),
    ).toEqual([]);
  });

  it("allows an intentional mass UPDATE carrying a -- destructive: marker", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          '-- destructive: backfilling new column for all rows intentionally\nUPDATE "users" SET plan = \'free\';',
      }),
    ).toEqual([]);
  });

  it("does not treat an identifier containing 'where' as a WHERE clause", () => {
    expect(
      rulesFound({ "0001_a.sql": "DELETE FROM sessions_wherehouse;" }),
    ).toEqual(["DELETE without WHERE"]);
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

describe("dynamic EXECUTE inside DO blocks", () => {
  it("flags EXECUTE format(...) inside a DO block", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DO $$ DECLARE tbl text := 'users'; BEGIN EXECUTE format('DELETE FROM %I', tbl); END $$;",
      }),
    ).toEqual(["Dynamic EXECUTE"]);
  });

  it("flags EXECUTE with string concatenation", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DO $$ DECLARE t text := 'sessions'; BEGIN EXECUTE 'TRUNCATE ' || t; END $$;",
      }),
    ).toEqual(["Dynamic EXECUTE"]);
  });

  it("flags EXECUTE of a variable", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DO $$ DECLARE stmt text; BEGIN stmt := 'DROP TABLE ' || 'users'; EXECUTE stmt; END $$;",
      }),
    ).toEqual(["Dynamic EXECUTE"]);
  });

  it("flags dynamic EXECUTE inside tagged dollar quotes", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DO $body$ BEGIN EXECUTE format('ALTER TABLE %I DISABLE TRIGGER ALL', 'users'); END $body$;",
      }),
    ).toEqual(["Dynamic EXECUTE"]);
  });

  it("allows dynamic EXECUTE carrying a -- destructive: marker", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "-- destructive: dropping legacy per-tenant tables, data archived\nDO $$ DECLARE tbl text; BEGIN FOR tbl IN SELECT tablename FROM pg_tables WHERE tablename LIKE 'legacy_%' LOOP EXECUTE format('DROP TABLE %I', tbl); END LOOP; END $$;",
      }),
    ).toEqual([]);
  });

  it("flags dynamic EXECUTE inside a CREATE FUNCTION body", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "CREATE FUNCTION purge(tbl text) RETURNS void AS $$ BEGIN EXECUTE format('DELETE FROM %I', tbl); END $$ LANGUAGE plpgsql;",
      }),
    ).toEqual(["Dynamic EXECUTE"]);
  });

  it("does not flag EXECUTE with a constant dollar-quoted literal", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DO $$ BEGIN EXECUTE $q$ CREATE INDEX IF NOT EXISTS idx_users_name ON users (name) $q$; END $$;",
      }),
    ).toEqual([]);
  });

  it("does not flag EXECUTE with a constant string literal", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DO $$ BEGIN EXECUTE 'CREATE INDEX IF NOT EXISTS idx_users_name ON users (name)'; END $$;",
      }),
    ).toEqual([]);
  });

  it("does not flag EXECUTE constant with USING parameters", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DO $$ BEGIN EXECUTE 'INSERT INTO settings (key, value) VALUES ($1, $2)' USING 'k', 'v'; END $$;",
      }),
    ).toEqual([]);
  });

  it("does not flag EXECUTE constant with INTO", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DO $$ DECLARE n int; BEGIN EXECUTE 'SELECT count(*) FROM users' INTO n; END $$;",
      }),
    ).toEqual([]);
  });

  it("does not flag a plain conditional-CREATE DO block", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'role') THEN CREATE TYPE role AS ENUM ('admin', 'user'); END IF; END $$;",
      }),
    ).toEqual([]);
  });

  it("does not flag CREATE TRIGGER ... EXECUTE FUNCTION inside a DO block", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DO $$ BEGIN CREATE TRIGGER trg BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at(); END $$;",
      }),
    ).toEqual([]);
  });

  it("does not flag GRANT EXECUTE inside a DO block", () => {
    expect(
      rulesFound({
        "0001_a.sql":
          "DO $$ BEGIN GRANT EXECUTE ON FUNCTION touch_updated_at() TO app_user; END $$;",
      }),
    ).toEqual([]);
  });

  it("does not flag EXECUTE outside a dollar-quoted body", () => {
    expect(
      rulesFound({
        "0001_a.sql": "GRANT EXECUTE ON FUNCTION touch_updated_at() TO app_user;",
      }),
    ).toEqual([]);
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
