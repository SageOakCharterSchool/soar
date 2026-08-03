-- Add hidden flag to applications (idempotent: existing DBs were created via push)
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "hidden" boolean NOT NULL DEFAULT false;
