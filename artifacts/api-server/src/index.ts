import app from "./app";
import { logger } from "./lib/logger";
import { seed } from "./lib/auth";
import { startActivityRetentionJob } from "./lib/activityRetention";

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

seed()
  .catch((err) => {
    logger.error({ err }, "Seeding failed");
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
    });
  });
