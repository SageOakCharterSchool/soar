-- Add a source marker to import_log so SFTP-synced imports are
-- distinguishable from manual uploads. Hand-written to be idempotent:
-- existing production databases were created via `drizzle-kit push`.
ALTER TABLE "import_log" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'upload';
