import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  date,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { termsTable } from "./terms";
import { usersTable } from "./users";

export const applicationsTable = pgTable("applications", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  category: text("category"),
  // Reserved for the future Clever API integration phase.
  cleverAppId: text("clever_app_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appTermStatusTable = pgTable(
  "app_term_status",
  {
    id: serial("id").primaryKey(),
    applicationId: integer("application_id")
      .notNull()
      .references(() => applicationsTable.id, { onDelete: "cascade" }),
    termId: integer("term_id")
      .notNull()
      .references(() => termsTable.id, { onDelete: "cascade" }),
    studentSharingStatus: text("student_sharing_status", {
      enum: ["not_started", "in_progress", "complete", "needs_review"],
    })
      .notNull()
      .default("not_started"),
    staffSharingStatus: text("staff_sharing_status", {
      enum: ["not_started", "in_progress", "complete", "needs_review"],
    })
      .notNull()
      .default("not_started"),
    syncMethod: text("sync_method"),
    lastSyncedAt: date("last_synced_at", { mode: "string" }),
    owner: text("owner"),
    notes: text("notes"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    updatedBy: integer("updated_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
  },
  (t) => [uniqueIndex("app_term_status_app_term_idx").on(t.applicationId, t.termId)],
);

export const appUpvotesTable = pgTable(
  "app_upvotes",
  {
    id: serial("id").primaryKey(),
    applicationId: integer("application_id")
      .notNull()
      .references(() => applicationsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("app_upvotes_app_user_idx").on(t.applicationId, t.userId)],
);

export const appIssuesTable = pgTable("app_issues", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id")
    .notNull()
    .references(() => applicationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  comment: text("comment").notNull(),
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appActivityTable = pgTable("app_activity", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id")
    .notNull()
    .references(() => applicationsTable.id, { onDelete: "cascade" }),
  termId: integer("term_id").references(() => termsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type", {
    enum: ["status_change", "app_added", "issue_reported", "issue_resolved"],
  }).notNull(),
  detail: text("detail").notNull(),
  actorId: integer("actor_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pageLastSeenTable = pgTable(
  "page_last_seen",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    page: text("page").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("page_last_seen_user_page_idx").on(t.userId, t.page)],
);

export const insertApplicationSchema = createInsertSchema(applicationsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertApplication = z.infer<typeof insertApplicationSchema>;
export type Application = typeof applicationsTable.$inferSelect;
export type AppTermStatus = typeof appTermStatusTable.$inferSelect;
export type AppUpvote = typeof appUpvotesTable.$inferSelect;
export type AppIssue = typeof appIssuesTable.$inferSelect;
export type AppActivity = typeof appActivityTable.$inferSelect;
export type PageLastSeen = typeof pageLastSeenTable.$inferSelect;
