-- RACI matrix tables (teams, members, rows, cell assignments) plus a
-- relaxation of app_activity.application_id so RACI changes (which may not be
-- tied to an application) can appear in the shared activity feed.
-- Hand-written to be idempotent: existing databases may have been created
-- via `drizzle-kit push`.
CREATE TABLE IF NOT EXISTS "raci_teams" (
"id" serial PRIMARY KEY NOT NULL,
"name" text NOT NULL,
"sort_order" integer DEFAULT 0 NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "raci_teams_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raci_members" (
"id" serial PRIMARY KEY NOT NULL,
"team_id" integer NOT NULL,
"name" text NOT NULL,
"user_id" integer,
"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raci_rows" (
"id" serial PRIMARY KEY NOT NULL,
"team_id" integer NOT NULL,
"category" text,
"name" text NOT NULL,
"sort_order" integer DEFAULT 0 NOT NULL,
"application_id" integer,
"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raci_assignments" (
"id" serial PRIMARY KEY NOT NULL,
"row_id" integer NOT NULL,
"member_id" integer NOT NULL,
"value" text NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raci_members" ADD CONSTRAINT "raci_members_team_id_raci_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."raci_teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raci_members" ADD CONSTRAINT "raci_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raci_rows" ADD CONSTRAINT "raci_rows_team_id_raci_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."raci_teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raci_rows" ADD CONSTRAINT "raci_rows_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raci_assignments" ADD CONSTRAINT "raci_assignments_row_id_raci_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."raci_rows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raci_assignments" ADD CONSTRAINT "raci_assignments_member_id_raci_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."raci_members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "raci_members_team_name_idx" ON "raci_members" ("team_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raci_rows_team_idx" ON "raci_rows" ("team_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "raci_assignments_row_member_idx" ON "raci_assignments" ("row_id", "member_id");
--> statement-breakpoint
ALTER TABLE "app_activity" ALTER COLUMN "application_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_activity_archive" ALTER COLUMN "application_id" DROP NOT NULL;
