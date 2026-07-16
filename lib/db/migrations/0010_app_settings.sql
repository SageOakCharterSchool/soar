-- Key/value store for admin-configurable application settings (first use:
-- the "open too long" issue threshold in days).
-- Hand-written to be idempotent: existing databases may have been created
-- via `drizzle-kit push`.
CREATE TABLE IF NOT EXISTS "app_settings" (
"key" text PRIMARY KEY NOT NULL,
"value" text NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
