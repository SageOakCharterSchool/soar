CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "terms" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"school_year" text NOT NULL,
	"term_type" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"sort_order" integer NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"term_id" integer,
	"event_type" text NOT NULL,
	"detail" text NOT NULL,
	"actor_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"comment" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_term_status" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"term_id" integer NOT NULL,
	"student_sharing_status" text DEFAULT 'not_started' NOT NULL,
	"staff_sharing_status" text DEFAULT 'not_started' NOT NULL,
	"sync_method" text,
	"last_synced_at" date,
	"owner" text,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_upvotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"clever_app_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_name_unique" UNIQUE("name"),
	CONSTRAINT "applications_clever_app_id_unique" UNIQUE("clever_app_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_last_seen" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"page" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by" integer,
	"snapshot_date" date NOT NULL,
	"files_included" text[] NOT NULL,
	"rows_inserted" integer DEFAULT 0 NOT NULL,
	"rows_updated" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_additional_resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_date" date NOT NULL,
	"link" text NOT NULL,
	"unique_users" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_applist" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_date" date NOT NULL,
	"app_name" text NOT NULL,
	"student_count" integer DEFAULT 0 NOT NULL,
	"student_percent" double precision DEFAULT 0 NOT NULL,
	"teacher_count" integer DEFAULT 0 NOT NULL,
	"teacher_percent" double precision DEFAULT 0 NOT NULL,
	"active_time_per_user_minutes" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_by_app" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_date" date NOT NULL,
	"application" text NOT NULL,
	"unique_users" integer DEFAULT 0 NOT NULL,
	"scoped_users" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_by_browser" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_date" date NOT NULL,
	"label" text NOT NULL,
	"unique_users" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_by_device" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_date" date NOT NULL,
	"label" text NOT NULL,
	"unique_users" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_by_login_method" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_date" date NOT NULL,
	"label" text NOT NULL,
	"unique_users" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_by_school" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_date" date NOT NULL,
	"school" text NOT NULL,
	"unique_users" integer DEFAULT 0 NOT NULL,
	"scoped_users" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_daily_student" (
	"date" date PRIMARY KEY NOT NULL,
	"active_users" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_daily_teacher" (
	"date" date PRIMARY KEY NOT NULL,
	"active_users" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_key_metrics" (
	"snapshot_date" date PRIMARY KEY NOT NULL,
	"time_range" text,
	"unique_students" integer,
	"scoped_students" integer,
	"total_student_logins" integer,
	"unique_teachers" integer,
	"scoped_teachers" integer,
	"total_teacher_logins" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" json NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_activity" ADD CONSTRAINT "app_activity_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_activity" ADD CONSTRAINT "app_activity_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_activity" ADD CONSTRAINT "app_activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_issues" ADD CONSTRAINT "app_issues_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_issues" ADD CONSTRAINT "app_issues_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_term_status" ADD CONSTRAINT "app_term_status_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_term_status" ADD CONSTRAINT "app_term_status_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_term_status" ADD CONSTRAINT "app_term_status_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_upvotes" ADD CONSTRAINT "app_upvotes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_upvotes" ADD CONSTRAINT "app_upvotes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_last_seen" ADD CONSTRAINT "page_last_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_log" ADD CONSTRAINT "import_log_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_activity_created_at_idx" ON "app_activity" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_activity_term_created_at_idx" ON "app_activity" USING btree ("term_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_term_status_app_term_idx" ON "app_term_status" USING btree ("application_id","term_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_upvotes_app_user_idx" ON "app_upvotes" USING btree ("application_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_last_seen_user_page_idx" ON "page_last_seen" USING btree ("user_id","page");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_additional_resources_idx" ON "usage_additional_resources" USING btree ("snapshot_date","link");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_applist_idx" ON "usage_applist" USING btree ("snapshot_date","app_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_by_app_idx" ON "usage_by_app" USING btree ("snapshot_date","application");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_by_browser_idx" ON "usage_by_browser" USING btree ("snapshot_date","label");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_by_device_idx" ON "usage_by_device" USING btree ("snapshot_date","label");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_by_login_method_idx" ON "usage_by_login_method" USING btree ("snapshot_date","label");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_by_school_idx" ON "usage_by_school" USING btree ("snapshot_date","school");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" USING btree ("expire");