-- Alerts raised when the automatic Clever SFTP sync fails, so admins get an
-- in-app notification instead of failures staying silent. Hand-written to be
-- idempotent: existing databases may have been created via `drizzle-kit push`.
CREATE TABLE IF NOT EXISTS "sync_alerts" (
  "id" serial PRIMARY KEY NOT NULL,
  "message" text NOT NULL,
  "occurrences" integer NOT NULL DEFAULT 1,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  "resolved_reason" text
);
