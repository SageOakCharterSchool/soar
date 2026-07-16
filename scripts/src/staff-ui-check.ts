/**
 * Browser-level staff access check: drives a real Chromium browser via
 * Playwright, logs in as a non-admin (staff) user, and verifies that
 * admin-only pages and controls are not reachable:
 *   - Upload / Users nav links are hidden
 *   - Direct navigation to /upload and /users renders the 404 page
 *   - Rostering page has no "Manage terms" or per-row edit controls
 *   - Issues page has no "Mark resolved" / "Reopen" buttons
 *   - Admin API endpoints return 403 from within the staff browser session
 * Exits with code 1 (fails loudly) if any admin surface is reachable.
 *
 * Requires the web dashboard and API server workflows to be running.
 * Uses the Nix-provided chromium binary (CHROMIUM_PATH overrides).
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chromium, type Page } from "playwright-core";

const appBase =
  process.env.APP_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:80");
const apiBase = `${appBase}/api`;

// Refuse to run against anything that isn't the local dev environment.
// This check creates a temporary staff account; it must never touch production.
function assertNotProduction() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run staff UI check with NODE_ENV=production. This check creates a temporary test account and must only run in development.",
    );
  }
  const host = new URL(appBase).hostname;
  const devHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
  if (process.env.REPLIT_DEV_DOMAIN) devHosts.add(process.env.REPLIT_DEV_DOMAIN);
  if (!devHosts.has(host)) {
    throw new Error(
      `Refusing to run staff UI check against non-development host "${host}". ` +
        "This check creates a temporary test account and must only run against localhost or the Replit dev domain.",
    );
  }
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@sageoak.org";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "sageoak-admin";
const STAFF_EMAIL = "staff-e2e@sageoak.org";
// Random per-run password; the account is deleted again after the run.
const STAFF_PASSWORD = randomBytes(24).toString("base64url");

let failures = 0;
function fail(msg: string) {
  failures++;
  console.error(`  FAIL: ${msg}`);
}
function pass(msg: string) {
  console.log(`  ok: ${msg}`);
}

function chromiumPath(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return execSync("which chromium").toString().trim();
}

async function adminLogin(): Promise<string> {
  // Retry on 5xx / network errors while the API server starts up.
  let loginRes: Response | undefined;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      loginRes = await fetch(`${apiBase}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      if (loginRes.status < 500) break;
    } catch {
      loginRes = undefined;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!loginRes?.ok) {
    throw new Error(`Admin login failed: HTTP ${loginRes?.status ?? "unreachable"}`);
  }
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("No admin session cookie returned");
  return cookie;
}

async function deleteStaffUser(adminCookie: string): Promise<void> {
  const res = await fetch(`${apiBase}/users`, {
    headers: { Cookie: adminCookie },
  });
  if (!res.ok) return;
  const users = (await res.json()) as Array<{ id: number; email: string }>;
  const match = users.find((u) => u.email === STAFF_EMAIL);
  if (!match) return;
  const del = await fetch(`${apiBase}/users/${match.id}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie },
  });
  if (del.ok) {
    console.log(`Deleted staff test user ${STAFF_EMAIL}`);
  } else {
    console.error(
      `WARNING: could not delete staff test user ${STAFF_EMAIL}: HTTP ${del.status}`,
    );
  }
}

async function createStaffUser(adminCookie: string) {
  // Remove any leftover account from a previous (possibly interrupted) run so
  // this run's fresh random password is the only valid credential.
  await deleteStaffUser(adminCookie);
  const res = await fetch(`${apiBase}/users`, {
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

async function countVisible(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count();
}

async function runChecks() {
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    // Log in as staff through the real login form.
    // Note: the app keeps a server-sent events stream open for live badge
    // updates, so "networkidle" never fires — wait for "load" plus explicit
    // element waits instead.
    await page.goto(`${appBase}/`, { waitUntil: "load" });
    await page.getByPlaceholder("admin@sageoak.org").waitFor({ timeout: 15000 });
    await page.getByPlaceholder("admin@sageoak.org").fill(STAFF_EMAIL);
    await page.getByPlaceholder("••••••••").fill(STAFF_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Overview" }).waitFor({ timeout: 15000 });
    console.log(`Logged in as staff user ${STAFF_EMAIL}`);

    console.log("\nHeader navigation:");
    for (const label of ["Overview", "Rostering", "Issues"]) {
      if ((await countVisible(page, `header nav button:has-text("${label}")`)) > 0) {
        pass(`nav shows "${label}"`);
      } else {
        fail(`nav is missing staff link "${label}"`);
      }
    }
    for (const label of ["Upload", "Users"]) {
      if ((await countVisible(page, `header nav button:has-text("${label}")`)) === 0) {
        pass(`nav hides admin link "${label}"`);
      } else {
        fail(`admin nav link "${label}" is visible to staff`);
      }
    }

    console.log("\nDirect navigation to admin pages:");
    for (const path of ["/upload", "/users"]) {
      await page.goto(`${appBase}${path}`, { waitUntil: "load" });
      const notFound = await page
        .getByText("404 Page Not Found")
        .waitFor({ timeout: 15000 })
        .then(() => 1)
        .catch(() => 0);
      if (notFound > 0) {
        pass(`${path} renders the 404 page for staff`);
      } else {
        fail(`${path} did NOT render the 404 page for staff — admin page may be exposed`);
      }
    }

    console.log("\nRostering page (must be read-only for staff):");
    await page.goto(`${appBase}/rostering`, { waitUntil: "load" });
    await page.getByText("Rostering Status Board").waitFor({ timeout: 15000 });
    if ((await page.getByRole("button", { name: "Manage terms" }).count()) === 0) {
      pass(`"Manage terms" control is hidden`);
    } else {
      fail(`"Manage terms" control is visible to staff`);
    }
    if ((await page.locator('button[aria-label^="Edit "]').count()) === 0) {
      pass("per-app edit-status buttons are hidden");
    } else {
      fail("per-app edit-status buttons are visible to staff");
    }

    console.log("\nIssues page (must be read-only for staff):");
    await page.goto(`${appBase}/issues`, { waitUntil: "load" });
    await page.getByText("Issues").first().waitFor({ timeout: 15000 });
    const resolveButtons =
      (await page.getByRole("button", { name: "Mark resolved" }).count()) +
      (await page.getByRole("button", { name: "Reopen" }).count());
    if (resolveButtons === 0) {
      pass("no resolve/reopen buttons shown to staff");
    } else {
      fail(`${resolveButtons} resolve/reopen button(s) visible to staff`);
    }

    console.log("\nAdmin API endpoints from the staff browser session:");
    const apiChecks: Array<[string, string]> = [
      ["GET", "/users"],
      ["POST", "/uploads"],
      ["POST", "/terms"],
      ["PATCH", "/rostering/status/1"],
      ["PATCH", "/issues/1"],
    ];
    for (const [method, path] of apiChecks) {
      const status = await page.evaluate(
        async ({ method, url }) => {
          const res = await fetch(url, {
            method,
            headers: { "Content-Type": "application/json" },
            body: method === "GET" ? undefined : JSON.stringify({}),
            credentials: "include",
          });
          return res.status;
        },
        { method, url: `${apiBase}${path}` },
      );
      if (status === 403) {
        pass(`${method} ${path} -> 403`);
      } else {
        fail(`${method} ${path} -> ${status} (expected 403)`);
      }
    }
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(
      `\nSTAFF UI CHECK FAILED: ${failures} admin surface(s) reachable by staff in the browser.`,
    );
    return false;
  }
  console.log("\nStaff UI check passed: no admin pages or controls reachable by staff.");
  return true;
}

async function main() {
  assertNotProduction();
  console.log(`Staff UI check against ${appBase}`);

  const adminCookie = await adminLogin();
  let passed = false;
  try {
    await createStaffUser(adminCookie);
    passed = await runChecks();
  } finally {
    // Always remove the temporary staff account, even if checks failed.
    await deleteStaffUser(adminCookie);
  }
  if (!passed) process.exit(1);
}

main().catch((err) => {
  console.error(`STAFF UI CHECK ERRORED: ${err.message}`);
  process.exit(1);
});
