import { pgTable, varchar, json, timestamp, index } from "drizzle-orm/pg-core";

// Session storage for connect-pg-simple. Also created at startup by the API
// server's seed() (the library's createTableIfMissing breaks in bundled
// builds); defined here so drizzle-kit push doesn't try to drop it.
export const sessionTable = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6, withTimezone: false }).notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);
