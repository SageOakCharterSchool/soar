/**
 * Migration safety check.
 *
 * Boots the built API server (which applies drizzle migrations at startup)
 * against two throwaway databases created on the dev Postgres server:
 *
 *   A. an empty database — verifies migrations work from scratch
 *   B. a database that already has the current schema but an EMPTY drizzle
 *      journal (simulating a database originally created with
 *      `drizzle-kit push`, like our real deployed database) — verifies every
 *      migration is idempotent when re-run against existing tables
 *
 * Fails (exit 1) if the server cannot start cleanly in either scenario.
 * The server is booted with NODE_ENV=production so migration or seed
 * failures make it exit instead of limping along.
 *
 * Run with: pnpm --filter @workspace/scripts verify-migrations
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runLint } from "./lint-migrations.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const apiServerDir = path.join(repoRoot, "artifacts/api-server");
const migrationsDir = path.join(repoRoot, "lib/db/migrations");

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  throw new Error("DATABASE_URL is required (dev database must be provisioned).");
}

function assertDevDatabase(url: string) {
  const host = new URL(url).hostname;
  const devHosts = new Set(["localhost", "127.0.0.1", "helium"]);
  if (process.env.PGHOST) devHosts.add(process.env.PGHOST);
  if (!devHosts.has(host)) {
    throw new Error(
      `Refusing to run migration verification against non-development host "${host}". ` +
        "This check creates and drops temporary databases and must only run against the dev Postgres server.",
    );
  }
}
assertDevDatabase(adminUrl);

function tempDbUrl(dbName: string): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function createDb(name: string) {
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${name}"`);
  });
}

async function dropDb(name: string) {
  await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

/** Apply all migration SQL files raw, WITHOUT writing the drizzle journal —
 * this reproduces a database created by `drizzle-kit push` (tables exist,
 * journal empty), so the startup migrator will re-run every migration. */
async function applySchemaWithoutJournal(dbUrl: string) {
  const journalPath = path.join(migrationsDir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    for (const entry of journal.entries) {
      const sqlText = readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), "utf8");
      for (const stmt of sqlText.split("--> statement-breakpoint")) {
        const trimmed = stmt.trim();
        if (trimmed) await client.query(trimmed);
      }
    }
  } finally {
    await client.end();
  }
}

/** Seed representative rows into key tables so scenario B verifies that
 * migrations survive on a POPULATED database (e.g. a NOT NULL column added
 * without a default would fail here, and data loss is detected after boot). */
const seedCounts = {
  users: 2,
  terms: 2,
  applications: 2,
  app_term_status: 2,
} as const;

/** Parse a numeric env override, failing fast on invalid or non-positive
 * values so a typo cannot silently disable the timing enforcement. */
function envNumber(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    throw new Error(
      `Invalid ${name}="${raw}": must be a positive number <= ${max}.`,
    );
  }
  return n;
}

/** Number of bulk rows seeded into each large-in-production table
 * (app_activity, usage_* snapshots, session) so migration timing runs
 * against realistic data volume, not near-empty tables. */
const BULK_ACTIVITY_ROWS = envNumber("VERIFY_MIG_BULK_ROWS", 5000, 1_000_000);

/** Per-statement time budgets when re-running migrations on the populated
 * database. A statement that rewrites/locks the whole table will blow past
 * these on real data volumes. Note: timing happens on an extra re-run before
 * the server boot re-runs migrations again — intentionally stricter than
 * production, since every migration must already be idempotent. */
const STATEMENT_WARN_MS = envNumber("VERIFY_MIG_WARN_MS", 1000, 600_000);
const STATEMENT_FAIL_MS = envNumber("VERIFY_MIG_FAIL_MS", 5000, 600_000);

async function seedSampleRows(dbUrl: string) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(`
      INSERT INTO users (email, password_hash, display_name, role) VALUES
        ('seed-admin@example.invalid', 'x-not-a-real-hash', 'Seed Admin', 'admin'),
        ('seed-staff@example.invalid', 'x-not-a-real-hash', 'Seed Staff', 'staff');

      INSERT INTO terms (label, school_year, term_type, start_date, end_date, sort_order, is_current) VALUES
        ('Fall 2025', '2025-2026', 'regular', '2025-08-15', '2025-12-19', 1, false),
        ('Spring 2026', '2025-2026', 'regular', '2026-01-05', '2026-05-29', 2, true);

      INSERT INTO applications (name, category) VALUES
        ('Seed App One', 'Math'),
        ('Seed App Two', NULL);

      INSERT INTO app_term_status
        (application_id, term_id, student_sharing_status, staff_sharing_status, sync_method, last_synced_at, owner, notes, updated_by)
      VALUES
        ((SELECT id FROM applications WHERE name = 'Seed App One'),
         (SELECT id FROM terms WHERE label = 'Fall 2025'),
         'complete', 'in_progress', 'manual', '2025-09-01', 'Seed Admin', 'seeded row', 
         (SELECT id FROM users WHERE email = 'seed-admin@example.invalid')),
        ((SELECT id FROM applications WHERE name = 'Seed App Two'),
         (SELECT id FROM terms WHERE label = 'Spring 2026'),
         'not_started', 'not_started', NULL, NULL, NULL, NULL, NULL);
    `);
  } finally {
    await client.end();
  }
}

/** Seed a large volume of rows into every table that grows large in
 * production (app_activity, usage_* snapshots, session) so migration timing
 * reflects real data volume on each of them, not just activity history. */
async function seedBulkActivityRows(dbUrl: string) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(
      `
      INSERT INTO app_activity (application_id, term_id, event_type, detail, actor_id, created_at)
      SELECT
        (SELECT id FROM applications WHERE name = 'Seed App One'),
        (SELECT id FROM terms WHERE label = 'Fall 2025'),
        CASE WHEN gs % 3 = 0 THEN 'status_change' WHEN gs % 3 = 1 THEN 'note_added' ELSE 'issue_opened' END,
        'bulk seeded activity row #' || gs,
        (SELECT id FROM users WHERE email = 'seed-admin@example.invalid'),
        -- Deterministic so the post-migration spot check can verify exact values.
        -- Base date is in the future so activity-retention pruning at server
        -- boot never deletes these rows out from under the check.
        '2030-01-01T00:00:00Z'::timestamptz + (gs || ' minutes')::interval
      FROM generate_series(1, $1) AS gs
      `,
      [BULK_ACTIVITY_ROWS],
    );

    // usage_by_app: unique on (snapshot_date, application) — vary both.
    await client.query(
      `
      INSERT INTO usage_by_app (snapshot_date, application, unique_users, scoped_users)
      SELECT
        ('2025-09-01'::date + (gs % 30)),
        'bulk-seed-app-' || gs,
        gs % 500,
        gs % 400
      FROM generate_series(1, $1) AS gs
      `,
      [BULK_ACTIVITY_ROWS],
    );

    // usage_applist: unique on (snapshot_date, app_name) — vary both.
    await client.query(
      `
      INSERT INTO usage_applist
        (snapshot_date, app_name, student_count, student_percent, teacher_count, teacher_percent, active_time_per_user_minutes)
      SELECT
        ('2025-09-01'::date + (gs % 30)),
        'bulk-seed-applist-' || gs,
        gs % 1000,
        (gs % 100)::double precision,
        gs % 100,
        (gs % 100)::double precision,
        (gs % 60)::double precision
      FROM generate_series(1, $1) AS gs
      `,
      [BULK_ACTIVITY_ROWS],
    );

    // usage_daily_student / usage_daily_teacher: date is the PRIMARY KEY,
    // so each row needs a distinct date.
    await client.query(
      `
      INSERT INTO usage_daily_student (date, active_users)
      SELECT ('2000-01-01'::date + gs), gs % 2000
      FROM generate_series(1, $1) AS gs
      `,
      [BULK_ACTIVITY_ROWS],
    );
    await client.query(
      `
      INSERT INTO usage_daily_teacher (date, active_users)
      SELECT ('2000-01-01'::date + gs), gs % 300
      FROM generate_series(1, $1) AS gs
      `,
      [BULK_ACTIVITY_ROWS],
    );

    // session: sid is the primary key; seed realistic-looking session blobs.
    await client.query(
      `
      INSERT INTO session (sid, sess, expire)
      SELECT
        'bulk-seed-sid-' || gs,
        json_build_object('cookie', json_build_object('maxAge', 86400000), 'seed', gs),
        -- Deterministic future expiry: verifiable exactly, and never swept by
        -- expired-session cleanup during the check.
        '2030-01-01T00:00:00Z'::timestamptz + (gs || ' seconds')::interval
      FROM generate_series(1, $1) AS gs
      `,
      [BULK_ACTIVITY_ROWS],
    );
  } finally {
    await client.end();
  }
}

/** Re-run every migration statement against the populated database, timing
 * each one. This mirrors what the startup migrator does on a pushed-schema
 * database, but lets us flag statements that take a long lock or rewrite
 * whole tables — those pass instantly on tiny data but stall the live app. */
async function timeMigrationsOnPopulatedDb(dbUrl: string): Promise<void> {
  const journalPath = path.join(migrationsDir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const slow: string[] = [];
  const tooSlow: string[] = [];
  try {
    for (const entry of journal.entries) {
      const sqlText = readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), "utf8");
      const statements = sqlText
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);
      let fileTotal = 0;
      for (let i = 0; i < statements.length; i++) {
        const start = performance.now();
        await client.query(statements[i]);
        const ms = performance.now() - start;
        fileTotal += ms;
        if (ms >= STATEMENT_WARN_MS) {
          const preview = statements[i].replace(/\s+/g, " ").slice(0, 120);
          const desc = `${entry.tag}.sql statement ${i + 1} took ${Math.round(ms)}ms: ${preview}...`;
          if (ms >= STATEMENT_FAIL_MS) tooSlow.push(desc);
          else slow.push(desc);
        }
      }
      console.log(`  timed ${entry.tag}.sql: ${statements.length} statements in ${Math.round(fileTotal)}ms`);
    }
  } finally {
    await client.end();
  }
  for (const s of slow) {
    console.warn(`WARN: slow migration statement (>${STATEMENT_WARN_MS}ms) on populated data: ${s}`);
  }
  if (tooSlow.length > 0) {
    throw new Error(
      `[pushed-db] Migration statements exceeded the ${STATEMENT_FAIL_MS}ms time budget on a database with ` +
        `${BULK_ACTIVITY_ROWS} rows in each large table (app_activity, usage_by_app, usage_applist, ` +
        `usage_daily_student, usage_daily_teacher, session) — they would likely lock or rewrite whole tables in production:\n` +
        tooSlow.map((s) => `  - ${s}`).join("\n"),
    );
  }
}

/** After the server booted (and re-ran all migrations), verify no seeded
 * rows disappeared or were mangled. */
async function verifySeededRowsSurvived(dbUrl: string) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    for (const [table, expected] of Object.entries(seedCounts)) {
      const filter =
        table === "users"
          ? `WHERE email LIKE 'seed-%@example.invalid'`
          : table === "applications"
            ? `WHERE name LIKE 'Seed App %'`
            : table === "terms"
              ? `WHERE label IN ('Fall 2025', 'Spring 2026')`
              : "";
      const res = await client.query(`SELECT COUNT(*)::int AS n FROM ${table} ${filter}`);
      const n: number = res.rows[0].n;
      if (n < expected) {
        throw new Error(
          `[pushed-db] Data loss detected: table "${table}" has ${n} seeded rows after migration, expected ${expected}.`,
        );
      }
    }
    const status = await client.query(
      `SELECT student_sharing_status, staff_sharing_status, notes
         FROM app_term_status ats
         JOIN applications a ON a.id = ats.application_id
        WHERE a.name = 'Seed App One'`,
    );
    const row = status.rows[0];
    if (
      !row ||
      row.student_sharing_status !== "complete" ||
      row.staff_sharing_status !== "in_progress" ||
      row.notes !== "seeded row"
    ) {
      throw new Error(
        `[pushed-db] Data corruption detected: app_term_status seeded values changed after migration: ${JSON.stringify(row)}`,
      );
    }
  } finally {
    await client.end();
  }
}

/** Verify the bulk-seeded rows in every large table survived the migration
 * re-runs. */
async function verifyBulkRowsSurvived(dbUrl: string) {
  const checks: { table: string; where: string }[] = [
    { table: "app_activity", where: `detail LIKE 'bulk seeded activity row #%'` },
    { table: "usage_by_app", where: `application LIKE 'bulk-seed-app-%'` },
    { table: "usage_applist", where: `app_name LIKE 'bulk-seed-applist-%'` },
    { table: "usage_daily_student", where: `date BETWEEN '2000-01-02' AND ('2000-01-01'::date + ${BULK_ACTIVITY_ROWS})` },
    { table: "usage_daily_teacher", where: `date BETWEEN '2000-01-02' AND ('2000-01-01'::date + ${BULK_ACTIVITY_ROWS})` },
    { table: "session", where: `sid LIKE 'bulk-seed-sid-%'` },
  ];
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    for (const { table, where } of checks) {
      const res = await client.query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
      );
      const n: number = res.rows[0].n;
      if (n < BULK_ACTIVITY_ROWS) {
        throw new Error(
          `[pushed-db] Data loss detected: ${table} has ${n} bulk-seeded rows after migration, expected ${BULK_ACTIVITY_ROWS}.`,
        );
      }
    }
    await verifyBulkRowValues(client);
  } finally {
    await client.end();
  }
}

/** Spot-check actual VALUES in a sample of the bulk-seeded rows. Row counts
 * alone would not catch a migration that nulls out or zeroes a column (e.g.
 * `UPDATE usage_by_app SET unique_users = 0` or a column rewrite that
 * re-defaults values), so we recompute the deterministic seeded value for a
 * handful of generate_series indices and compare each column exactly. */
async function verifyBulkRowValues(client: pg.Client) {
  // Sample indices across the seeded range (same gs values used at seed time).
  const samples = Array.from(
    new Set([1, 7, Math.floor(BULK_ACTIVITY_ROWS / 2), BULK_ACTIVITY_ROWS - 1, BULK_ACTIVITY_ROWS]),
  ).filter((gs) => gs >= 1 && gs <= BULK_ACTIVITY_ROWS);

  const fail = (table: string, gs: number, column: string, expected: unknown, actual: unknown): never => {
    throw new Error(
      `[pushed-db] Data corruption detected: ${table} bulk-seeded row (gs=${gs}) has ` +
        `${column}=${JSON.stringify(actual)} after migration, expected ${JSON.stringify(expected)}. ` +
        `A migration likely rewrote or defaulted this column even though row counts survived.`,
    );
  };

  for (const gs of samples) {
    // usage_by_app: unique_users = gs % 500, scoped_users = gs % 400,
    // snapshot_date = '2025-09-01' + (gs % 30)
    {
      const res = await client.query(
        `SELECT unique_users, scoped_users, snapshot_date::text AS snapshot_date,
                (snapshot_date = ('2025-09-01'::date + ($2::int % 30))) AS date_ok
           FROM usage_by_app WHERE application = $1`,
        [`bulk-seed-app-${gs}`, gs],
      );
      const row = res.rows[0];
      if (!row) fail("usage_by_app", gs, "row", "present", "missing");
      if (row.unique_users !== gs % 500) fail("usage_by_app", gs, "unique_users", gs % 500, row.unique_users);
      if (row.scoped_users !== gs % 400) fail("usage_by_app", gs, "scoped_users", gs % 400, row.scoped_users);
      if (row.date_ok !== true) {
        fail("usage_by_app", gs, "snapshot_date", `2025-09-01 + ${gs % 30} days`, row.snapshot_date);
      }
    }

    // usage_applist: counts/percents/minutes derived from gs
    {
      const res = await client.query(
        `SELECT student_count, student_percent, teacher_count, teacher_percent, active_time_per_user_minutes,
                snapshot_date::text AS snapshot_date,
                (snapshot_date = ('2025-09-01'::date + ($2::int % 30))) AS date_ok
           FROM usage_applist WHERE app_name = $1`,
        [`bulk-seed-applist-${gs}`, gs],
      );
      const row = res.rows[0];
      if (!row) fail("usage_applist", gs, "row", "present", "missing");
      if (row.date_ok !== true) {
        fail("usage_applist", gs, "snapshot_date", `2025-09-01 + ${gs % 30} days`, row.snapshot_date);
      }
      if (row.student_count !== gs % 1000) fail("usage_applist", gs, "student_count", gs % 1000, row.student_count);
      if (Number(row.student_percent) !== gs % 100) fail("usage_applist", gs, "student_percent", gs % 100, row.student_percent);
      if (row.teacher_count !== gs % 100) fail("usage_applist", gs, "teacher_count", gs % 100, row.teacher_count);
      if (Number(row.teacher_percent) !== gs % 100) fail("usage_applist", gs, "teacher_percent", gs % 100, row.teacher_percent);
      if (Number(row.active_time_per_user_minutes) !== gs % 60) {
        fail("usage_applist", gs, "active_time_per_user_minutes", gs % 60, row.active_time_per_user_minutes);
      }
    }

    // usage_daily_student / usage_daily_teacher: active_users derived from gs
    {
      const res = await client.query(
        `SELECT active_users FROM usage_daily_student WHERE date = ('2000-01-01'::date + $1::int)`,
        [gs],
      );
      const row = res.rows[0];
      if (!row) fail("usage_daily_student", gs, "row", "present", "missing");
      if (row.active_users !== gs % 2000) fail("usage_daily_student", gs, "active_users", gs % 2000, row.active_users);
    }
    {
      const res = await client.query(
        `SELECT active_users FROM usage_daily_teacher WHERE date = ('2000-01-01'::date + $1::int)`,
        [gs],
      );
      const row = res.rows[0];
      if (!row) fail("usage_daily_teacher", gs, "row", "present", "missing");
      if (row.active_users !== gs % 300) fail("usage_daily_teacher", gs, "active_users", gs % 300, row.active_users);
    }

    // session: the sess JSON payload must survive byte-for-byte semantically,
    // and expire must keep its deterministic seeded timestamp.
    {
      const res = await client.query(
        `SELECT sess, expire::text AS expire,
                (expire = ('2030-01-01T00:00:00Z'::timestamptz + ($2 || ' seconds')::interval)) AS expire_ok
           FROM session WHERE sid = $1`,
        [`bulk-seed-sid-${gs}`, gs],
      );
      const row = res.rows[0];
      if (!row) fail("session", gs, "row", "present", "missing");
      const sess = row.sess;
      if (!sess || typeof sess !== "object") fail("session", gs, "sess", "json object", sess);
      if (sess.seed !== gs) fail("session", gs, "sess.seed", gs, sess?.seed);
      if (sess.cookie?.maxAge !== 86400000) fail("session", gs, "sess.cookie.maxAge", 86400000, sess?.cookie?.maxAge);
      if (row.expire_ok !== true) {
        fail("session", gs, "expire", `2030-01-01T00:00:00Z + ${gs}s`, row.expire);
      }
    }

    // app_activity: detail text, event_type, and created_at derived from gs
    {
      const res = await client.query(
        `SELECT event_type, created_at::text AS created_at,
                (created_at = ('2030-01-01T00:00:00Z'::timestamptz + ($2 || ' minutes')::interval)) AS created_at_ok
           FROM app_activity WHERE detail = $1`,
        [`bulk seeded activity row #${gs}`, gs],
      );
      const row = res.rows[0];
      if (!row) fail("app_activity", gs, "row", "present", "missing");
      const expectedType = gs % 3 === 0 ? "status_change" : gs % 3 === 1 ? "note_added" : "issue_opened";
      if (row.event_type !== expectedType) fail("app_activity", gs, "event_type", expectedType, row.event_type);
      if (row.created_at_ok !== true) {
        fail("app_activity", gs, "created_at", `2030-01-01T00:00:00Z + ${gs}min`, row.created_at);
      }
    }
  }
  console.log(
    `  value spot check passed: ${samples.length} sampled rows per table match seeded values ` +
      `(usage_by_app, usage_applist, usage_daily_student, usage_daily_teacher, session, app_activity).`,
  );
}

/** Boot the built server against dbUrl; resolve when it logs "Server
 * listening", reject on exit or timeout. */
function bootServer(dbUrl: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 10000);
    const child = spawn("node", ["--enable-source-maps", "./dist/index.mjs"], {
      cwd: apiServerDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: dbUrl,
        PORT: String(port),
        SESSION_SECRET: randomBytes(32).toString("hex"),
        ADMIN_EMAIL: "migration-check@example.invalid",
        ADMIN_PASSWORD: randomBytes(24).toString("hex"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      finish(new Error(`[${label}] Timed out waiting for server to start.\n${output}`));
    }, 90_000);

    const onData = (buf: Buffer) => {
      output += buf.toString();
      if (output.includes("Database migration failed")) {
        finish(new Error(`[${label}] Migration failed:\n${output}`));
      } else if (output.includes("Server listening")) {
        finish();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`[${label}] Server exited with code ${code} before listening:\n${output}`));
      }
    });
  });
}

async function main() {
  console.log("Linting migrations for destructive statements...");
  if (!runLint(migrationsDir)) {
    throw new Error("Destructive-migration lint failed (see findings above).");
  }

  console.log("Building api-server bundle...");
  const build = spawnSync("pnpm", ["--filter", "@workspace/api-server", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("api-server build failed");
  if (!existsSync(path.join(apiServerDir, "dist/index.mjs"))) {
    throw new Error("dist/index.mjs not found after build");
  }

  const suffix = Date.now().toString(36);
  const emptyDb = `verify_mig_empty_${suffix}`;
  const pushedDb = `verify_mig_pushed_${suffix}`;

  try {
    console.log(`\nScenario A: empty database (${emptyDb})`);
    await createDb(emptyDb);
    await bootServer(tempDbUrl(emptyDb), "empty-db");
    console.log("PASS: server booted and migrated an empty database.");

    console.log(`\nScenario B: existing schema with seeded data and empty journal (${pushedDb})`);
    await createDb(pushedDb);
    await applySchemaWithoutJournal(tempDbUrl(pushedDb));
    await seedSampleRows(tempDbUrl(pushedDb));
    await seedBulkActivityRows(tempDbUrl(pushedDb));
    console.log(
      `Timing migration statements against populated data (${BULK_ACTIVITY_ROWS} rows each in app_activity, usage_by_app, usage_applist, usage_daily_student, usage_daily_teacher, session; warn >${STATEMENT_WARN_MS}ms, fail >${STATEMENT_FAIL_MS}ms)...`,
    );
    await timeMigrationsOnPopulatedDb(tempDbUrl(pushedDb));
    await bootServer(tempDbUrl(pushedDb), "pushed-db");
    await verifySeededRowsSurvived(tempDbUrl(pushedDb));
    await verifyBulkRowsSurvived(tempDbUrl(pushedDb));
    console.log(
      "PASS: migrations re-ran idempotently against a populated schema and seeded rows survived intact.",
    );

    console.log("\nAll migration safety checks passed.");
  } finally {
    await dropDb(emptyDb).catch(() => {});
    await dropDb(pushedDb).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
