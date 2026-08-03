/**
 * UI check: verifies the self-service "Delete my account" flow in a real
 * browser.
 *
 * Flow:
 *   1. Create a temporary staff account (random per-run password).
 *   2. As that staff user: open the account menu, choose "Delete my account…",
 *      confirm the Delete button stays disabled until the exact phrase is
 *      typed, then confirm.
 *   3. Verify the user lands back on the login screen and the account is gone
 *      server-side.
 *   4. Clean up the staff account if the UI delete failed.
 */
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { chromium, type BrowserContext } from "playwright-core";

const appBase =
  process.env.APP_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:80");
const apiBase = `${appBase}/api`;

// This check creates and deletes a temporary account; never run on production.
if (process.env.NODE_ENV === "production") {
  throw new Error(
    "Refusing to run account-delete UI check with NODE_ENV=production. It creates a temporary test account.",
  );
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@sageoak.org";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "sageoak-admin";
const STAFF_EMAIL = "account-delete-e2e@sageoak.org";
// Random per-run password; the account deletes itself during the run.
const STAFF_PASSWORD = randomBytes(24).toString("base64url");

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.error(`  FAIL: ${m}`);
};
const pass = (m: string) => console.log(`  ok: ${m}`);

function chromiumPath(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return execSync("which chromium").toString().trim();
}

async function adminLogin(): Promise<string> {
  // Retry on 5xx / network errors while the API server starts up.
  let res: Response | undefined;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      res = await fetch(`${apiBase}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      if (res.status < 500) break;
    } catch {
      res = undefined;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!res?.ok) {
    throw new Error(`Admin login failed: HTTP ${res?.status ?? "unreachable"}`);
  }
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("No admin session cookie returned");
  return cookie;
}

async function findStaffUser(
  adminCookie: string,
): Promise<{ id: number; email: string } | undefined> {
  const res = await fetch(`${apiBase}/users`, { headers: { Cookie: adminCookie } });
  if (!res.ok) return undefined;
  const users = (await res.json()) as Array<{ id: number; email: string }>;
  return users.find((u) => u.email === STAFF_EMAIL);
}

async function deleteStaffUser(adminCookie: string): Promise<void> {
  const match = await findStaffUser(adminCookie);
  if (!match) return;
  const del = await fetch(`${apiBase}/users/${match.id}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie },
  });
  if (del.ok) console.log(`Deleted staff test user ${STAFF_EMAIL}`);
  else
    console.error(
      `WARNING: could not delete staff test user ${STAFF_EMAIL}: HTTP ${del.status}`,
    );
}

async function createStaffUser(adminCookie: string): Promise<void> {
  // Remove any leftover account from a previous (possibly interrupted) run.
  await deleteStaffUser(adminCookie);
  const res = await fetch(`${apiBase}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
      displayName: "Account Delete E2E",
      role: "staff",
    }),
  });
  if (!res.ok) throw new Error(`Could not create staff user: HTTP ${res.status}`);
  console.log(`Created staff test user ${STAFF_EMAIL} (random per-run password)`);
}

async function loginViaForm(context: BrowserContext, email: string, password: string) {
  const page = await context.newPage();
  // The app keeps an SSE stream open, so "networkidle" never fires — wait for
  // "load" plus explicit element waits instead.
  await page.goto(`${appBase}/`, { waitUntil: "load" });
  await page.getByPlaceholder("admin@sageoak.org").waitFor({ timeout: 15000 });
  await page.getByPlaceholder("admin@sageoak.org").fill(email);
  await page.getByPlaceholder("••••••••").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Overview" }).waitFor({ timeout: 15000 });
  return page;
}

async function main() {
  const adminCookie = await adminLogin();
  await createStaffUser(adminCookie);

  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await loginViaForm(context, STAFF_EMAIL, STAFF_PASSWORD);
    console.log(`Logged in as staff user ${STAFF_EMAIL}`);

    console.log("\nStaff deletes their own account:");
    await page.getByTestId("button-account-menu").click();
    await page.getByTestId("button-delete-account").click();
    await page.getByText("Delete my account?").waitFor({ timeout: 15000 });
    pass("confirmation dialog opens from the account menu");

    const confirmButton = page.getByTestId("button-confirm-delete-account");
    if (await confirmButton.isDisabled()) pass("confirm button disabled before typing");
    else fail("confirm button should be disabled before typing the phrase");

    await page.getByTestId("input-delete-account-confirm").fill("nope");
    if (await confirmButton.isDisabled()) pass("confirm button disabled on wrong phrase");
    else fail("confirm button should stay disabled on a wrong phrase");

    await page.getByTestId("input-delete-account-confirm").fill("DELETE");
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!(await confirmButton.isDisabled())) break;
      await page.waitForTimeout(100);
    }
    if (!(await confirmButton.isDisabled())) pass("confirm button enables on exact phrase");
    else fail("confirm button did not enable after typing DELETE");

    await confirmButton.click();
    await page.getByText("Account deleted").first().waitFor({ timeout: 15000 });
    pass("success toast shown");

    await page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 15000 });
    pass("user is signed out and back on the login screen");

    // Server-side: the account must be gone.
    if (!(await findStaffUser(adminCookie))) pass("account no longer exists server-side");
    else fail("account still exists server-side after self-delete");

    await context.close();
  } finally {
    await browser.close();
    // Belt and braces: remove the account if the UI delete failed.
    await deleteStaffUser(adminCookie);
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
