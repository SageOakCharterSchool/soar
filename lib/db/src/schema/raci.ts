import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { applicationsTable } from "./rostering";
import { usersTable } from "./users";

export const RACI_VALUES = ["R", "A", "C", "I", "N/A"] as const;
export type RaciValue = (typeof RACI_VALUES)[number];

export const raciTeamsTable = pgTable("raci_teams", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const raciMembersTable = pgTable(
  "raci_members",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => raciTeamsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Optional link to a dashboard account, matched by name where possible.
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("raci_members_team_name_idx").on(t.teamId, t.name)],
);

export const raciRowsTable = pgTable(
  "raci_rows",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => raciTeamsTable.id, { onDelete: "cascade" }),
    // Category header the row is grouped under (null = ungrouped).
    category: text("category"),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    // Optional link to an application in the Clever application list.
    applicationId: integer("application_id").references(() => applicationsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("raci_rows_team_idx").on(t.teamId)],
);

export const raciAssignmentsTable = pgTable(
  "raci_assignments",
  {
    id: serial("id").primaryKey(),
    rowId: integer("row_id")
      .notNull()
      .references(() => raciRowsTable.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => raciMembersTable.id, { onDelete: "cascade" }),
    value: text("value", { enum: RACI_VALUES }).notNull(),
  },
  (t) => [uniqueIndex("raci_assignments_row_member_idx").on(t.rowId, t.memberId)],
);

export type RaciTeam = typeof raciTeamsTable.$inferSelect;
export type RaciMember = typeof raciMembersTable.$inferSelect;
export type RaciRow = typeof raciRowsTable.$inferSelect;
export type RaciAssignment = typeof raciAssignmentsTable.$inferSelect;
