/**
 * Staff access check: verifies a non-admin (staff) user is blocked from all
 * admin-only API endpoints, while still able to reach staff-visible data.
 * Exits with code 1 (fails loudly) if any admin surface is reachable by staff.
 *
 * Requires the API server to be running (uses REPLIT_DEV_DOMAIN or API_BASE_URL).
 */

import { randomBytes } from "node:crypto";

const base =
  process.env.API_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/api`
    : "http://localhost:3001/api");

// Refuse to run against anything that isn't the local dev environment.
// This check creates a temporary staff account; it must never touch production.
function assertNotProduction() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run staff access check with NODE_ENV=production. This check creates a temporary test account and must only run in development.",
    );
  }
  const host = new URL(base).hostname;
  const devHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
  if (process.env.REPLIT_DEV_DOMAIN) devHosts.add(process.env.REPLIT_DEV_DOMAIN);
  if (!devHosts.has(host)) {
    throw new Error(
      `Refusing to run staff access check against non-development host "${host}". ` +
        "This check creates a temporary test account and must only run against localhost or the Replit dev domain.",
    );
  }
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@sageoak.org";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "sageoak-admin";
const STAFF_EMAIL = "staff-e2e@sageoak.org";
// Random per-run password: even if this account ever leaks somewhere, the
// credentials are never known/publishable, and the user is deleted after the run.
const STAFF_PASSWORD = randomBytes(24).toString("base64url");

let failures = 0;

function fail(msg: string) {
  failures++;
  console.error(`  FAIL: ${msg}`);
}

function pass(msg: string) {
  console.log(`  ok: ${msg}`);
}

async function loginOnce(email: string, password: string): Promise<Response> {
  return fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

async function login(email: string, password: string): Promise<string> {
  // Retry on 5xx / network errors: the API server may still be starting up.
  let res: Response | undefined;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      res = await loginOnce(email, password);
      if (res.status < 500) break;
    } catch {
      res = undefined;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!res) throw new Error(`Could not reach API server at ${base}`);
  if (!res.ok) {
    throw new Error(`Login failed for ${email}: HTTP ${res.status}`);
  }
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error(`No session cookie returned for ${email}`);
  return cookie.split(";")[0];
}

async function findStaffUserId(adminCookie: string): Promise<number | null> {
  const res = await fetch(`${base}/users`, {
    headers: { Cookie: adminCookie },
  });
  if (!res.ok) return null;
  const users = (await res.json()) as Array<{ id: number; email: string }>;
  const match = users.find((u) => u.email === STAFF_EMAIL);
  return match ? match.id : null;
}

async function deleteStaffUser(adminCookie: string): Promise<void> {
  const id = await findStaffUserId(adminCookie);
  if (id == null) return;
  const res = await fetch(`${base}/users/${id}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie },
  });
  if (res.ok) {
    console.log(`Deleted staff test user ${STAFF_EMAIL}`);
  } else {
    console.error(
      `WARNING: could not delete staff test user ${STAFF_EMAIL}: HTTP ${res.status}`,
    );
  }
}

async function createStaffUser(adminCookie: string) {
  // Remove any leftover account from a previous (possibly interrupted) run so
  // this run's fresh random password is the only valid credential.
  await deleteStaffUser(adminCookie);
  const res = await fetch(`${base}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
      displayName: "Staff E2E",
      role: "staff",
    }),
  });
  if (!res.ok) {
    throw new Error(`Could not create staff user: HTTP ${res.status}`);
  }
  console.log(`Created staff test user ${STAFF_EMAIL} (random per-run password)`);
}

async function runChecks(adminCookie: string) {
  await createStaffUser(adminCookie);
  const staffCookie = await login(STAFF_EMAIL, STAFF_PASSWORD);

  const adminEndpoints: Array<[string, string]> = [
    ["GET", "/users"],
    ["POST", "/users"],
    ["PATCH", "/users/1"],
    ["DELETE", "/users/999999"],
    ["POST", "/uploads"],
    ["GET", "/uploads/log"],
    ["POST", "/terms"],
    ["PATCH", "/terms/1"],
    ["POST", "/terms/1/copy-statuses"],
    ["PATCH", "/rostering/status/1"],
    ["PATCH", "/issues/1"],
  ];

  console.log("\nAdmin-only endpoints must return 403 for staff:");
  for (const [method, path] of adminEndpoints) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: staffCookie },
      body: method === "GET" ? undefined : JSON.stringify({}),
    });
    if (res.status === 403) {
      pass(`${method} ${path} -> 403`);
    } else {
      fail(`${method} ${path} -> ${res.status} (expected 403)`);
    }
  }

  console.log("\nStaff-visible endpoints must still work for staff:");
  const staffEndpoints: Array<[string, string]> = [
    ["GET", "/auth/me"],
    ["GET", "/terms"],
  ];
  for (const [method, path] of staffEndpoints) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Cookie: staffCookie },
    });
    if (res.ok) {
      pass(`${method} ${path} -> ${res.status}`);
    } else {
      fail(`${method} ${path} -> ${res.status} (expected success)`);
    }
  }

  // Sanity check: unauthenticated requests must also be blocked.
  console.log("\nUnauthenticated requests to admin endpoints must be rejected:");
  const res = await fetch(`${base}/users`);
  if (res.status === 401 || res.status === 403) {
    pass(`GET /users (no session) -> ${res.status}`);
  } else {
    fail(`GET /users (no session) -> ${res.status} (expected 401/403)`);
  }

  if (failures > 0) {
    console.error(
      `\nSTAFF ACCESS CHECK FAILED: ${failures} admin surface(s) reachable or misbehaving for staff.`,
    );
    return false;
  }
  console.log("\nStaff access check passed: all admin surfaces blocked for staff.");
  return true;
}

async function main() {
  assertNotProduction();
  console.log(`Staff access check against ${base}`);

  const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  let passed = false;
  try {
    passed = await runChecks(adminCookie);
  } finally {
    // Always remove the temporary staff account, even if checks failed.
    await deleteStaffUser(adminCookie);
  }
  if (!passed) process.exit(1);
}

main().catch((err) => {
  console.error(`STAFF ACCESS CHECK ERRORED: ${err.message}`);
  process.exit(1);
});
