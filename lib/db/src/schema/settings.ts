import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Simple key/value store for admin-configurable application settings
 * (e.g. how many days an issue can stay open before it is flagged as
 * "open too long"). Values are stored as text and parsed by the API layer.
 */
export const appSettingsTable = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AppSetting = typeof appSettingsTable.$inferSelect;
