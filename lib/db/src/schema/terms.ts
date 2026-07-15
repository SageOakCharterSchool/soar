import { pgTable, text, serial, integer, boolean, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const termsTable = pgTable("terms", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  schoolYear: text("school_year").notNull(),
  termType: text("term_type", { enum: ["regular", "summer"] }).notNull(),
  startDate: date("start_date", { mode: "string" }).notNull(),
  endDate: date("end_date", { mode: "string" }).notNull(),
  sortOrder: integer("sort_order").notNull(),
  isCurrent: boolean("is_current").notNull().default(false),
});

export const insertTermSchema = createInsertSchema(termsTable).omit({ id: true });
export type InsertTerm = z.infer<typeof insertTermSchema>;
export type Term = typeof termsTable.$inferSelect;
