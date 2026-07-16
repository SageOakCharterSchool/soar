import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Admin-facing alerts raised when the automatic Clever SFTP sync fails.
 * Repeated identical failures update the existing active alert (occurrences /
 * lastSeenAt) instead of creating a new row, so admins are not spammed.
 * A later successful sync resolves all active alerts.
 */
export const syncAlertsTable = pgTable("sync_alerts", {
  id: serial("id").primaryKey(),
  message: text("message").notNull(),
  occurrences: integer("occurrences").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  // How the alert was cleared: "sync_succeeded" or "dismissed".
  resolvedReason: text("resolved_reason"),
});

export type SyncAlert = typeof syncAlertsTable.$inferSelect;
