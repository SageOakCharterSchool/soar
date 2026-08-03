import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db, usersTable, appActivityTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { getSessionUser, toUserDto, DEFAULT_DEV_ADMIN_PASSWORD } from "../lib/auth";
import { emitRosteringActivity } from "../lib/activityEvents";
import {
  isGoogleSsoEnabled,
  buildAuthUrl,
  generateState,
  handleGoogleCallback,
} from "../lib/googleAuth";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Email and password are required" });
    return;
  }
  if (
    process.env.NODE_ENV === "production" &&
    parsed.data.password === DEFAULT_DEV_ADMIN_PASSWORD
  ) {
    res.status(401).json({ message: "Invalid email or password" });
    return;
  }
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, parsed.data.email.toLowerCase()));
  if (
    !user ||
    !user.passwordHash ||
    !(await bcrypt.compare(parsed.data.password, user.passwordHash))
  ) {
    res.status(401).json({ message: "Invalid email or password" });
    return;
  }
  req.session.userId = user.id;
  res.json(toUserDto(user));
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
  res.json({ message: "Logged out" });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ message: "Not logged in" });
    return;
  }
  res.json(toUserDto(user));
});

// Serializes concurrent self-deletes so two admins can't each pass the
// "another admin exists" check and delete simultaneously, leaving zero admins.
const LAST_ADMIN_LOCK_KEY = 429011;

class LastAdminError extends Error {}

router.delete("/auth/account", async (req, res): Promise<void> => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ message: "Not logged in" });
    return;
  }
  try {
    // Audit insert + delete run in one transaction under an advisory lock so
    // the last-admin check is race-free and a failed delete can't leave a
    // stray audit event.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LAST_ADMIN_LOCK_KEY})`);
      if (user.role === "admin") {
        const admins = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.role, "admin"));
        if (!admins.some((a) => a.id !== user.id)) throw new LastAdminError();
      }
      // The actor FK is set null by the delete; the detail text keeps who it was.
      await tx.insert(appActivityTable).values({
        eventType: "account_self_deleted",
        detail: `${user.displayName} (${user.email}) deleted their own account`,
        actorId: user.id,
      });
      await tx.delete(usersTable).where(eq(usersTable.id, user.id));
    });
  } catch (err) {
    if (err instanceof LastAdminError) {
      res.status(409).json({
        message:
          "You are the only admin. Add another admin before deleting your account, or everyone would be locked out.",
      });
      return;
    }
    throw err;
  }
  await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
  emitRosteringActivity();
  res.json({ message: "Account deleted" });
});

router.get("/auth/config", (_req, res): void => {
  res.json({ googleEnabled: isGoogleSsoEnabled() });
});

router.get("/auth/google", (req, res): void => {
  if (!isGoogleSsoEnabled()) {
    res.status(404).json({ message: "Google sign-in is not configured" });
    return;
  }
  const state = generateState();
  req.session.oauthState = state;
  res.redirect(buildAuthUrl(req, state));
});

router.get("/auth/google/callback", async (req, res): Promise<void> => {
  if (!isGoogleSsoEnabled()) {
    res.status(404).json({ message: "Google sign-in is not configured" });
    return;
  }
  const { code, state } = req.query;
  const expectedState = req.session.oauthState;
  req.session.oauthState = undefined;
  if (
    typeof code !== "string" ||
    typeof state !== "string" ||
    !expectedState ||
    state !== expectedState
  ) {
    res.redirect("/?ssoError=google_failed");
    return;
  }
  const result = await handleGoogleCallback(req, code);
  if (!result.ok) {
    res.redirect(`/?ssoError=${result.code}`);
    return;
  }
  req.session.userId = result.user.id;
  res.redirect("/");
});

export default router;
