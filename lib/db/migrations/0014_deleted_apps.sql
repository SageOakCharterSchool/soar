CREATE TABLE IF NOT EXISTS "deleted_apps" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"deleted_by" integer,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deleted_apps" ADD CONSTRAINT "deleted_apps_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deleted_apps_deleted_at_idx" ON "deleted_apps" ("deleted_at" DESC);
