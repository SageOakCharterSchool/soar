import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { db, usersTable, termsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    oauthState?: string;
  }
}

const isProduction = process.env.NODE_ENV === "production";

export const DEFAULT_DEV_ADMIN_PASSWORD = "sageoak-admin";

export function buildSessionMiddleware(): RequestHandler {
  const PgStore = connectPgSimple(session);
  const secret = process.env.SESSION_SECRET ?? "dev-only-session-secret";
  if (isProduction && !process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET environment variable is required in production.");
  }
  return session({
    store: new PgStore({
      conObject: { connectionString: process.env.DATABASE_URL },
    }),
    secret,
    resave: false,
    saveUninitialized: false,
    name: "sageoak.sid",
    // The Replit preview pane embeds the app in a cross-site iframe, so the
    // session cookie must be SameSite=None even in development. Browsers only
    // accept SameSite=None cookies when they are Secure; the dev preview is
    // served over HTTPS through a proxy (trust proxy is set), so "auto" marks
    // the cookie Secure for proxied HTTPS requests while still allowing plain
    // HTTP in local tools/tests (supertest) where Secure would block it.
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "none",
      secure: isProduction ? true : ("auto" as const),
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  });
}

export async function getSessionUser(req: Request) {
  if (!req.session.userId) return null;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId));
  return user ?? null;
}

export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ message: "Not logged in" });
    return;
  }
  (req as Request & { user: typeof user }).user = user;
  next();
};

export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ message: "Not logged in" });
    return;
  }
  if (user.role !== "admin") {
    res.status(403).json({ message: "Admin access required" });
    return;
  }
  (req as Request & { user: typeof user }).user = user;
  next();
};

export function toUserDto(user: {
  id: number;
  email: string;
  displayName: string;
  role: "admin" | "staff";
  tags: string[];
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    tags: user.tags,
    createdAt: user.createdAt.toISOString(),
  };
}

const SEED_TERMS = [
  {
    label: "2025-26 Regular",
    schoolYear: "2025-26",
    termType: "regular" as const,
    startDate: "2025-08-15",
    endDate: "2026-06-12",
    sortOrder: 1,
    isCurrent: false,
  },
  {
    label: "2026-27 Regular",
    schoolYear: "2026-27",
    termType: "regular" as const,
    startDate: "2026-08-14",
    endDate: "2027-06-11",
    sortOrder: 2,
    isCurrent: true,
  },
  {
    label: "2026-27 Summer School",
    schoolYear: "2026-27",
    termType: "summer" as const,
    startDate: "2027-06-21",
    endDate: "2027-07-30",
    sortOrder: 3,
    isCurrent: false,
  },
  {
    label: "2027-28 Regular",
    schoolYear: "2027-28",
    termType: "regular" as const,
    startDate: "2027-08-13",
    endDate: "2028-06-09",
    sortOrder: 4,
    isCurrent: false,
  },
];

export async function seed(): Promise<void> {
  // Session table for connect-pg-simple (its createTableIfMissing option
  // reads a .sql file from disk, which breaks in the bundled build).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")`,
  );

  const adminEmail = process.env.ADMIN_EMAIL ?? (isProduction ? null : "admin@sageoak.org");
  const adminPassword =
    process.env.ADMIN_PASSWORD ?? (isProduction ? null : DEFAULT_DEV_ADMIN_PASSWORD);

  if (isProduction) {
    if (!process.env.ADMIN_PASSWORD) {
      throw new Error(
        "ADMIN_PASSWORD environment variable is required in production. Refusing to start without a real admin password.",
      );
    }
    if (process.env.ADMIN_PASSWORD === DEFAULT_DEV_ADMIN_PASSWORD) {
      throw new Error(
        "ADMIN_PASSWORD is set to the well-known development default. Set a real, secret admin password for production.",
      );
    }
  }

  if (adminEmail && adminPassword) {
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, adminEmail.toLowerCase()));
    if (!existing) {
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      await db.insert(usersTable).values({
        email: adminEmail.toLowerCase(),
        passwordHash,
        displayName: "Administrator",
        role: "admin",
      });
      logger.info({ email: adminEmail }, "Seeded admin user");
    }
  } else {
    logger.warn("ADMIN_EMAIL / ADMIN_PASSWORD not set; no admin user seeded");
  }

  const existingTerms = await db.select().from(termsTable);
  if (existingTerms.length === 0) {
    await db.insert(termsTable).values(SEED_TERMS);
    logger.info("Seeded terms");
  }
}
