/**
 * Production login smoke check: verifies staff can actually log in on the
 * live published app. Runs against the production URL and checks, step by
 * step, that:
 *
 *   1. The deployed app is reachable (GET /api/healthz)
 *   2. Login succeeds and a secure session cookie is issued
 *   3. An authenticated request with that cookie succeeds (GET /api/auth/me)
 *   4. The session persists across a second request
 *
 * Each step reports clearly whether it passed, so a failure pinpoints which
 * layer broke (deployment/env, login, cookie, or session persistence).
 *
 * This check is READ-ONLY against production: it logs in with an existing
 * account, calls /auth/me twice, then logs out. It never creates, modifies,
 * or deletes data.
 *
 * Usage:
 *   PROD_APP_URL=https://<app>.replit.app \
 *   SMOKE_EMAIL=<email> SMOKE_PASSWORD=<password> \
 *   pnpm --filter @workspace/scripts run prod-login-check
 *
 *   or: pnpm --filter @workspace/scripts run prod-login-check -- https://<app>.replit.app
 *
 * Credentials fall back to ADMIN_EMAIL / ADMIN_PASSWORD if SMOKE_* are unset.
 * For local rehearsal against the dev server, set ALLOW_INSECURE_COOKIES=1
 * (skips the Secure-cookie attribute assertions, which only apply over HTTPS).
 */

const urlArg = process.argv.slice(2).find((a) => a !== "--");
const rawUrl = urlArg ?? process.env.PROD_APP_URL;

if (!rawUrl) {
  console.error(
    "PROD LOGIN CHECK ERRORED: no production URL provided.\n" +
      "Set PROD_APP_URL or pass the published URL as an argument, e.g.\n" +
      "  pnpm --filter @workspace/scripts run prod-login-check -- https://<app>.replit.app",
  );
  process.exit(1);
}

const base = `${rawUrl.replace(/\/+$/, "")}/api`;

const EMAIL = process.env.SMOKE_EMAIL ?? process.env.ADMIN_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD ?? process.env.ADMIN_PASSWORD;
const allowInsecure = process.env.ALLOW_INSECURE_COOKIES === "1";

if (!EMAIL || !PASSWORD) {
  console.error(
    "PROD LOGIN CHECK ERRORED: no credentials provided.\n" +
      "Set SMOKE_EMAIL and SMOKE_PASSWORD (or ADMIN_EMAIL and ADMIN_PASSWORD) " +
      "to the credentials of an existing account on the published app.",
  );
  process.exit(1);
}

const email: string = EMAIL;
const password: string = PASSWORD;

type StepName = "reachability" | "login" | "cookie" | "authenticated request" | "session persistence";

function stepFail(step: StepName, detail: string): never {
  console.error(`\nFAIL at step "${step}": ${detail}`);
  console.error("PROD LOGIN CHECK FAILED");
  process.exit(1);
}

function stepPass(step: StepName, detail: string) {
  console.log(`  ok [${step}]: ${detail}`);
}

async function tryFetch(step: StepName, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "manual" });
  } catch (err) {
    stepFail(step, `network error reaching ${url}: ${(err as Error).message}`);
  }
}

async function main() {
  console.log(`Production login smoke check against ${base}`);
  console.log(`Account: ${email}\n`);

  // Step 1: reachability
  const health = await tryFetch("reachability", `${base}/healthz`);
  if (!health.ok) {
    stepFail(
      "reachability",
      `GET /healthz returned HTTP ${health.status}. The deployment may be down, still building, or the API is not mounted at /api.`,
    );
  }
  stepPass("reachability", `GET /healthz -> ${health.status}`);

  // Step 2: login
  const loginRes = await tryFetch("login", `${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (loginRes.status === 401) {
    stepFail(
      "login",
      "HTTP 401 (invalid credentials). Check SMOKE_EMAIL/SMOKE_PASSWORD match a real account on the published app (production may have different ADMIN_* secrets than development).",
    );
  }
  if (!loginRes.ok) {
    const body = await loginRes.text().catch(() => "");
    stepFail(
      "login",
      `HTTP ${loginRes.status}. A 5xx usually means a server-side problem (database, SESSION_SECRET, or startup seed failure). Body: ${body.slice(0, 300)}`,
    );
  }
  stepPass("login", `POST /auth/login -> ${loginRes.status}`);

  // Step 3: session cookie
  const setCookie = loginRes.headers.get("set-cookie");
  if (!setCookie) {
    stepFail(
      "cookie",
      "login succeeded but no Set-Cookie header was returned. The session middleware did not persist a session (check session store / DATABASE_URL in production).",
    );
  }
  if (!setCookie.includes("sageoak.sid=")) {
    stepFail("cookie", `Set-Cookie did not contain the expected "sageoak.sid" session cookie: ${setCookie}`);
  }
  const lower = setCookie.toLowerCase();
  if (!allowInsecure) {
    if (!lower.includes("secure")) {
      stepFail(
        "cookie",
        'session cookie is missing the "Secure" attribute — browsers behind the HTTPS proxy may drop it. Check NODE_ENV=production and trust proxy settings on the deployment.',
      );
    }
    if (!lower.includes("httponly")) {
      stepFail("cookie", 'session cookie is missing the "HttpOnly" attribute.');
    }
  }
  const cookie = setCookie.split(";")[0];
  stepPass(
    "cookie",
    `received sageoak.sid session cookie${allowInsecure ? " (secure-attribute checks skipped)" : " with Secure + HttpOnly"}`,
  );

  // Step 4: authenticated request
  const meRes = await tryFetch("authenticated request", `${base}/auth/me`, {
    headers: { Cookie: cookie },
  });
  if (meRes.status === 401) {
    stepFail(
      "authenticated request",
      "GET /auth/me returned 401 with a fresh session cookie. The cookie is not being honored — usually a proxy/secure-cookie mismatch or the session was not saved to the store.",
    );
  }
  if (!meRes.ok) {
    stepFail("authenticated request", `GET /auth/me -> HTTP ${meRes.status}`);
  }
  const me = (await meRes.json()) as { email?: string; role?: string };
  if (me.email?.toLowerCase() !== email.toLowerCase()) {
    stepFail(
      "authenticated request",
      `GET /auth/me returned a different user ("${me.email}") than the one that logged in ("${email}").`,
    );
  }
  stepPass("authenticated request", `GET /auth/me -> ${meRes.status} as ${me.email}`);

  // Step 5: session persistence (second request on the same cookie)
  const meAgain = await tryFetch("session persistence", `${base}/auth/me`, {
    headers: { Cookie: cookie },
  });
  if (!meAgain.ok) {
    stepFail(
      "session persistence",
      `second GET /auth/me -> HTTP ${meAgain.status}. The session did not survive a second request (session store may not be persisting).`,
    );
  }
  stepPass("session persistence", `second GET /auth/me -> ${meAgain.status}`);

  // Cleanup: log the smoke-test session out.
  const logoutRes = await tryFetch("session persistence", `${base}/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  console.log(`\nLogged out smoke-test session (HTTP ${logoutRes.status}).`);

  console.log(
    me.role === "staff"
      ? "PROD LOGIN CHECK PASSED: staff can log in on the live app."
      : `PROD LOGIN CHECK PASSED: the ${me.role ?? "checked"} account can log in on the live app (use a staff account via SMOKE_EMAIL/SMOKE_PASSWORD to verify staff login specifically).`,
  );
}

main().catch((err) => {
  console.error(`PROD LOGIN CHECK ERRORED: ${(err as Error).message}`);
  process.exit(1);
});
