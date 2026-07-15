---
name: Drizzle startup migrations
description: How schema is applied at server startup; keep migrations idempotent and bundled
---
The api-server applies committed SQL migrations (lib/db/migrations, drizzle-orm node-postgres migrator) at startup; build copies the folder into dist/migrations and the runner resolves it relative to the bundle.

**Why:** Production runs only the esbuild bundle (no drizzle-kit); Railway deploys previously failed on empty DBs without a manual push.

**How to apply:**
- Schema changes: edit schema, run `drizzle-kit generate` in lib/db, then hand-edit the new SQL to be idempotent (CREATE TABLE/INDEX IF NOT EXISTS; wrap ADD CONSTRAINT / CREATE TYPE in DO $$ ... EXCEPTION WHEN duplicate_object THEN null; END $$). Existing dev/prod DBs were created via `drizzle-kit push`, so the migration journal is empty there and migration 0000 re-runs against pre-existing tables.
- Never rely on drizzle-kit at runtime; migrations must be plain SQL files shipped next to the bundle.
