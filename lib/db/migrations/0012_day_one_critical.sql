ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "day_one_critical" boolean NOT NULL DEFAULT false;
