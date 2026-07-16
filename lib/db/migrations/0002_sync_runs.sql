-- Persist SFTP sync run history so status survives server restarts.
-- Hand-written to be idempotent: existing databases may have been created
-- via `drizzle-kit push`.
CREATE TABLE IF NOT EXISTS "sync_runs" (
"id" serial PRIMARY KEY NOT NULL,
"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
"ok" boolean NOT NULL,
"imported_snapshots" text[] DEFAULT '{}' NOT NULL,
"skipped_snapshots" text[] DEFAULT '{}' NOT NULL,
"warnings" text[] DEFAULT '{}' NOT NULL,
"error" text
);
