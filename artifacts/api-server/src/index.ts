import app from "./app";
import { logger } from "./lib/logger";
import { seed } from "./lib/auth";
import { runMigrations } from "./lib/migrate";
import { startActivityRetentionJob } from "./lib/activityRetention";
import { startSftpSyncJob } from "./lib/sftpSync";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const includeStack = process.env.NODE_ENV !== "production";
    const text =
      includeStack && err.stack ? `${err.message}\n${err.stack}` : err.message;
    return text.slice(0, 2000);
  }
  return String(err).slice(0, 2000);
}

runMigrations()
  .catch((err) => {
    logger.error({ err }, `Database migration failed: ${describeError(err)}`);
    if (process.env.NODE_ENV === "production") {
      logger.error("Refusing to start in production after migration failure.");
      process.exit(1);
    }
  })
  .then(() => seed())
  .catch((err) => {
    logger.error({ err }, `Seeding failed: ${describeError(err)}`);
    if (process.env.NODE_ENV === "production") {
      logger.error("Refusing to start in production after seed failure.");
      process.exit(1);
    }
  })
  .then(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");
      startActivityRetentionJob();
      startSftpSyncJob();
    });
  });
