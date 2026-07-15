/**
 * Staff access check: verifies a non-admin (staff) user is blocked from all
 * admin-only API endpoints, while still able to reach staff-visible data.
 * Exits with code 1 (fails loudly) if any admin surface is reachable by staff.
 *
 * Requires the API server to be running (uses REPLIT_DEV_DOMAIN or API_BASE_URL).
 */

const base =
  process.env.API_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/api`
    : "http://localhost:3001/api");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@sageoak.org";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "sageoak-admin";
const STAFF_EMAIL = "staff-e2e@sageoak.org";
const STAFF_PASSWORD = "staff-e2e-pass1";

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

async function ensureStaffUser(adminCookie: string) {
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
  if (res.ok) {
    console.log(`Created staff test user ${STAFF_EMAIL}`);
    return;
  }
  // Already exists (conflict) is fine; anything else is not.
  if (res.status === 409 || res.status === 400) {
    console.log(`Staff test user ${STAFF_EMAIL} already exists`);
    return;
  }
  throw new Error(`Could not create staff user: HTTP ${res.status}`);
}

async function main() {
  console.log(`Staff access check against ${base}`);

  const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  await ensureStaffUser(adminCookie);
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
    process.exit(1);
  }
  console.log("\nStaff access check passed: all admin surfaces blocked for staff.");
}

main().catch((err) => {
  console.error(`STAFF ACCESS CHECK ERRORED: ${err.message}`);
  process.exit(1);
});
