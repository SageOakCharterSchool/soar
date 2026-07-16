-- Active time per user is not provided by Clever's real daily SFTP reports,
-- so synced snapshots previously stored 0 for every app. Make the column
-- nullable so "no data" is distinguishable from a real 0, and backfill
-- existing 0 values (all of which came from reports without active-time
-- data) to NULL. Hand-written and idempotent.
ALTER TABLE "usage_applist" ALTER COLUMN "active_time_per_user_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_applist" ALTER COLUMN "active_time_per_user_minutes" DROP DEFAULT;--> statement-breakpoint
UPDATE "usage_applist" SET "active_time_per_user_minutes" = NULL WHERE "active_time_per_user_minutes" = 0;
