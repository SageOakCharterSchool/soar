-- Adds app_issues.resolved_at so the Issues page can mark issues resolved
-- since a user's previous visit as "new".
-- Hand-written to be idempotent: existing databases may have been created
-- via `drizzle-kit push`.
ALTER TABLE "app_issues" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
