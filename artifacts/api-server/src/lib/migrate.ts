import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "@workspace/db";
import { logger } from "./logger";

function resolveMigrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Bundled build: migrations are copied next to the server bundle
    path.join(here, "migrations"),
    // Running from source (tests / tsx): use the db package's folder
    path.resolve(here, "../../../../lib/db/migrations"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
  }
  throw new Error(
    `Could not find drizzle migrations folder. Looked in: ${candidates.join(", ")}`,
  );
}

export async function runMigrations(): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder();
  logger.info({ migrationsFolder }, "Applying database migrations");
  await migrate(db, { migrationsFolder });
  logger.info("Database migrations up to date");
}
