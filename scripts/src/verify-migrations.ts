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

    console.log(`\nScenario B: existing schema with empty journal (${pushedDb})`);
    await createDb(pushedDb);
    await applySchemaWithoutJournal(tempDbUrl(pushedDb));
    await bootServer(tempDbUrl(pushedDb), "pushed-db");
    console.log("PASS: migrations re-ran idempotently against an existing schema.");

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
