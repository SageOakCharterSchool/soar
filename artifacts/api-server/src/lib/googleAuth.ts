import crypto from "crypto";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";
import { logger } from "./logger";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const allowedDomain = (
    process.env.GOOGLE_ALLOWED_DOMAIN ?? "sageoak.education"
  ).toLowerCase();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, allowedDomain };
}

export function isGoogleSsoEnabled(): boolean {
  return getGoogleConfig() !== null;
}

/**
 * The exact redirect URI registered in the Google Cloud console. Prefers
 * APP_BASE_URL (required behind proxies where the Host header may not match
 * the public URL); falls back to the request's own protocol/host.
 */
export function getRedirectUri(req: Request): string {
  const base =
    process.env.APP_BASE_URL?.replace(/\/+$/, "") ??
    `${req.protocol}://${req.get("host")}`;
  return `${base}/api/auth/google/callback`;
}

export function buildAuthUrl(req: Request, state: string): string {
  const config = getGoogleConfig();
  if (!config) throw new Error("Google SSO is not configured");
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: getRedirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    state,
    // Hint Google to pre-filter to the school domain (not a security
    // boundary — the callback re-validates the email domain).
    hd: config.allowedDomain,
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export function generateState(): string {
  return crypto.randomBytes(24).toString("hex");
}

type GoogleClaims = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  hd?: string;
};

function decodeIdToken(idToken: string): GoogleClaims | null {
  // The id_token is received directly from Google's token endpoint over
  // TLS, so decoding without signature verification is safe here.
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export type GoogleCallbackResult =
  | { ok: true; user: User }
  | { ok: false; code: "google_failed" | "wrong_domain" };

export async function handleGoogleCallback(
  req: Request,
  code: string,
): Promise<GoogleCallbackResult> {
  const config = getGoogleConfig();
  if (!config) return { ok: false, code: "google_failed" };

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: getRedirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    logger.warn(
      { status: tokenRes.status },
      "Google token exchange failed",
    );
    return { ok: false, code: "google_failed" };
  }
  const tokenBody = (await tokenRes.json()) as { id_token?: string };
  const claims = tokenBody.id_token ? decodeIdToken(tokenBody.id_token) : null;
  if (!claims?.email || claims.email_verified !== true || !claims.sub) {
    logger.warn("Google callback returned no verified email");
    return { ok: false, code: "google_failed" };
  }

  const email = claims.email.toLowerCase();
  const emailDomain = email.split("@")[1] ?? "";
  if (
    emailDomain !== config.allowedDomain ||
    (claims.hd && claims.hd.toLowerCase() !== config.allowedDomain)
  ) {
    logger.warn({ emailDomain }, "Google sign-in rejected: wrong domain");
    return { ok: false, code: "wrong_domain" };
  }

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (existing) {
    // Link the Google account; never change the existing role.
    if (existing.googleId !== claims.sub) {
      const [updated] = await db
        .update(usersTable)
        .set({ googleId: claims.sub })
        .where(eq(usersTable.id, existing.id))
        .returning();
      return { ok: true, user: updated ?? existing };
    }
    return { ok: true, user: existing };
  }

  const [created] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash: null,
      googleId: claims.sub,
      displayName: claims.name?.trim() || email,
      role: "staff",
    })
    .returning();
  if (!created) return { ok: false, code: "google_failed" };
  logger.info({ email }, "Auto-provisioned staff user via Google SSO");
  return { ok: true, user: created };
}
