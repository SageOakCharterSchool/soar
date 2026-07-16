-- Track total access counts (Clever num_access) per additional resource,
-- alongside unique users. Hand-written to be idempotent: existing databases
-- may have been created via `drizzle-kit push`.
ALTER TABLE "usage_additional_resources" ADD COLUMN IF NOT EXISTS "total_accesses" integer NOT NULL DEFAULT 0;
