-- Archive table for app_activity rows older than the retention window.
-- Rows are copied here before the retention job deletes them, preserving a
-- multi-year audit trail. Denormalized (app/actor names) and without foreign
-- keys so archived history survives app or user deletion.
-- Hand-written to be idempotent: existing databases may have been created
-- via `drizzle-kit push`.
CREATE TABLE IF NOT EXISTS "app_activity_archive" (
"id" serial PRIMARY KEY NOT NULL,
"original_id" integer NOT NULL,
"application_id" integer NOT NULL,
"app_name" text NOT NULL,
"term_id" integer,
"event_type" text NOT NULL,
"detail" text NOT NULL,
"actor_id" integer,
"actor_name" text,
"created_at" timestamp with time zone NOT NULL,
"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "app_activity_archive_created_at_idx" ON "app_activity_archive" ("created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "app_activity_archive_original_id_idx" ON "app_activity_archive" ("original_id");
