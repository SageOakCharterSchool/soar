# Adding a database migration

Schema changes are applied automatically at server startup (drizzle-orm
migrator; the build copies this folder into `artifacts/api-server/dist/migrations`).

Important context: existing databases (including production) were originally
created with `drizzle-kit push`, so their migration journal starts empty and
**every** migration re-runs against a database that already has tables. All
migration SQL must therefore be idempotent.

## Workflow

1. Edit the schema in `lib/db/src/schema/`.
2. Generate a migration from `lib/db`:

   ```sh
   cd lib/db && pnpm exec drizzle-kit generate --name <short_name>
   ```

3. Hand-edit the generated SQL for idempotency:
   - `CREATE TABLE` → `CREATE TABLE IF NOT EXISTS`
   - `CREATE [UNIQUE] INDEX` → `... IF NOT EXISTS`
   - `ALTER TABLE ... ADD COLUMN` → `ADD COLUMN IF NOT EXISTS`
   - `ADD CONSTRAINT` → wrap in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN null; END $$;`
   - Keep the `--> statement-breakpoint` markers intact.
   - Never write destructive statements (DROP TABLE/COLUMN, data-losing type
     changes) without an explicit, reviewed plan for existing data.
     A lint pass (`pnpm --filter @workspace/scripts lint-migrations`, also run
     automatically as the first phase of `verify-migrations`) fails the build
     if a migration contains `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`,
     `ALTER COLUMN ... TYPE`, `DELETE FROM` without `WHERE`, or
     `DROP SCHEMA/DATABASE`. If such a change is intentional and existing
     data has been accounted for, add a marker comment inside the flagged
     statement block (between `--> statement-breakpoint` markers):

     ```sql
     -- destructive: <reason it is safe / plan for existing data>
     ALTER TABLE "example" DROP COLUMN "legacy_field";
     ```
4. Verify against both an empty database and one that already has the schema:

   ```sh
   pnpm --filter @workspace/scripts verify-migrations
   ```

   This builds the server bundle and boots it against two throwaway
   databases; it fails if any migration errors occur. It is also registered
   as the `migrations` validation step.
5. Do not edit already-shipped migration files or `meta/_journal.json` by
   hand (other than the idempotency edits made before a migration ships).
