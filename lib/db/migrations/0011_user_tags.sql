-- Free-form user tags (e.g. "IT") used to filter user picker dropdowns.
-- Hand-written to be idempotent: existing databases may have been created
-- via `drizzle-kit push`.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT '{}' NOT NULL;
