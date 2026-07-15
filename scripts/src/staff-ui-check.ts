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
import { chromium, type Page } from "playwright-core";

const appBase =
  process.env.APP_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:80");
const apiBase = `${appBase}/api`;

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

function chromiumPath(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return execSync("which chromium").toString().trim();
}

async function ensureStaffUser() {
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
  const res = await fetch(`${apiBase}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
      displayName: "Staff E2E",
      role: "staff",
    }),
  });
  if (!res.ok && res.status !== 400 && res.status !== 409) {
    throw new Error(`Could not create staff user: HTTP ${res.status}`);
  }
}

async function countVisible(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count();
}

async function main() {
  console.log(`Staff UI check against ${appBase}`);
  await ensureStaffUser();

  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    // Log in as staff through the real login form.
    await page.goto(`${appBase}/`, { waitUntil: "networkidle" });
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
      await page.goto(`${appBase}${path}`, { waitUntil: "networkidle" });
      const notFound = await page.getByText("404 Page Not Found").count();
      if (notFound > 0) {
        pass(`${path} renders the 404 page for staff`);
      } else {
        fail(`${path} did NOT render the 404 page for staff — admin page may be exposed`);
      }
    }

    console.log("\nRostering page (must be read-only for staff):");
    await page.goto(`${appBase}/rostering`, { waitUntil: "networkidle" });
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
    await page.goto(`${appBase}/issues`, { waitUntil: "networkidle" });
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
    process.exit(1);
  }
  console.log("\nStaff UI check passed: no admin pages or controls reachable by staff.");
}

main().catch((err) => {
  console.error(`STAFF UI CHECK ERRORED: ${err.message}`);
  process.exit(1);
});
