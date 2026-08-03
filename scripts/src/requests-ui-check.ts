/**
 * UI check: verifies the request submit-and-review flow end to end in a real
 * browser.
 *
 * Flow:
 *   1. Create a temporary staff account (random per-run password).
 *   2. As staff: open the New request dialog, pick a type, link an app,
 *      submit, and confirm the card appears with the New badge.
 *   3. As admin: move the request New -> Under review -> Approved via the
 *      per-card status select, verifying badges/labels update.
 *   4. As admin: delete the request through the confirm dialog.
 *   5. Clean up the staff account (and the request, if UI delete failed).
 */
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { chromium, type Page, type BrowserContext } from "playwright-core";

const appBase =
  process.env.APP_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:80");
const apiBase = `${appBase}/api`;

// This check creates a temporary staff account; it must never touch production.
if (process.env.NODE_ENV === "production") {
  throw new Error(
    "Refusing to run requests UI check with NODE_ENV=production. It creates a temporary test account and test data.",
  );
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@sageoak.org";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "sageoak-admin";
const STAFF_EMAIL = "requests-e2e@sageoak.org";
// Random per-run password; the account is deleted again after the run.
const STAFF_PASSWORD = randomBytes(24).toString("base64url");

const REQUEST_TITLE = `UI check: request flow ${Date.now()}`;
const TYPE_LABEL = "LTI integration / add-on";

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

async function deleteStaffUser(adminCookie: string): Promise<void> {
  const res = await fetch(`${apiBase}/users`, { headers: { Cookie: adminCookie } });
  if (!res.ok) return;
  const users = (await res.json()) as Array<{ id: number; email: string }>;
  const match = users.find((u) => u.email === STAFF_EMAIL);
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
      displayName: "Requests E2E",
      role: "staff",
    }),
  });
  if (!res.ok) throw new Error(`Could not create staff user: HTTP ${res.status}`);
  console.log(`Created staff test user ${STAFF_EMAIL} (random per-run password)`);
}

type ApiRequest = { id: number; title: string; status: string };

async function findRequestByTitle(adminCookie: string): Promise<ApiRequest | undefined> {
  const res = await fetch(`${apiBase}/requests`, { headers: { Cookie: adminCookie } });
  if (!res.ok) return undefined;
  const all = (await res.json()) as ApiRequest[];
  return all.find((r) => r.title === REQUEST_TITLE);
}

async function cleanupLeftoverRequests(adminCookie: string): Promise<void> {
  // Remove requests left behind by previous interrupted runs.
  const res = await fetch(`${apiBase}/requests`, { headers: { Cookie: adminCookie } });
  if (!res.ok) return;
  const all = (await res.json()) as ApiRequest[];
  for (const r of all.filter((x) => x.title.startsWith("UI check: request flow"))) {
    const del = await fetch(`${apiBase}/requests/${r.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    if (del.ok) console.log(`Cleaned up leftover test request #${r.id}`);
  }
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

async function staffSubmitsRequest(page: Page): Promise<void> {
  console.log("\nStaff submits a request:");
  await page.goto(`${appBase}/requests`, { waitUntil: "load" });
  await page.getByTestId("button-new-request").waitFor({ timeout: 15000 });
  await page.getByTestId("button-new-request").click();
  await page.getByText("Submit a request").waitFor({ timeout: 15000 });
  pass("New request dialog opens");

  // Pick a request type via the Radix select (options render in a portal).
  await page.getByTestId("select-request-type").click();
  await page.getByRole("option", { name: TYPE_LABEL }).click();
  pass(`picked request type "${TYPE_LABEL}"`);

  // Link an app: pick the first real app option (skip "No specific app").
  await page.getByTestId("select-request-app").click();
  const options = page.getByRole("option");
  await options.first().waitFor({ timeout: 15000 });
  const count = await options.count();
  let linkedApp: string | null = null;
  for (let i = 0; i < count; i++) {
    const text = (await options.nth(i).innerText()).trim();
    if (text && text !== "No specific app") {
      linkedApp = text;
      await options.nth(i).click();
      break;
    }
  }
  if (!linkedApp) throw new Error("No app available to link in the app picker");
  pass(`linked app "${linkedApp}"`);

  await page.getByTestId("input-request-title").fill(REQUEST_TITLE);
  await page.getByTestId("button-submit-request").click();
  await page.getByText("Request submitted").first().waitFor({ timeout: 15000 });
  pass("submit succeeded (success toast shown)");

  // The new card should show the title, New badge, type label, and app badge.
  const card = page
    .locator('[data-testid^="card-request-"]')
    .filter({ hasText: REQUEST_TITLE })
    .first();
  await card.waitFor({ timeout: 15000 });
  for (const expected of ["New", TYPE_LABEL, linkedApp]) {
    if ((await card.getByText(expected, { exact: false }).count()) > 0)
      pass(`card shows "${expected}"`);
    else fail(`card is missing "${expected}"`);
  }
}

async function adminReviewsRequest(page: Page, requestId: number): Promise<void> {
  console.log("\nAdmin reviews the request:");
  await page.goto(`${appBase}/requests`, { waitUntil: "load" });
  const card = page.getByTestId(`card-request-${requestId}`);
  await card.waitFor({ timeout: 15000 });
  if ((await card.getByText("New").count()) > 0) pass("admin sees the request as New");
  else fail("request card is not labelled New for admin");

  const setStatus = async (label: string) => {
    await card.getByTestId(`select-status-${requestId}`).click();
    await page.getByRole("option", { name: label }).click();
    // The badge re-renders once the requests query refetches.
    const badge = card.getByText(label);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if ((await badge.count()) >= 2) break; // badge + select trigger both show it
      await page.waitForTimeout(250);
    }
    if ((await badge.count()) >= 2) pass(`status moved to "${label}" (badge updated)`);
    else fail(`badge did not update to "${label}"`);
  };

  await setStatus("Under review");
  await setStatus("Approved");
}

async function adminDeletesRequest(page: Page, requestId: number): Promise<void> {
  console.log("\nAdmin deletes the request:");
  const card = page.getByTestId(`card-request-${requestId}`);
  await card.getByRole("button", { name: "Delete request" }).click();
  await page.getByText("Delete this request?").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByText("Request deleted").first().waitFor({ timeout: 15000 });
  pass("delete confirmed (toast shown)");

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if ((await card.count()) === 0) break;
    await page.waitForTimeout(250);
  }
  if ((await card.count()) === 0) pass("request card removed from the list");
  else fail("request card is still visible after delete");
}

async function main() {
  const adminCookie = await adminLogin();
  await cleanupLeftoverRequests(adminCookie);
  await createStaffUser(adminCookie);

  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    // Staff submits the request.
    const staffContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const staffPage = await loginViaForm(staffContext, STAFF_EMAIL, STAFF_PASSWORD);
    console.log(`Logged in as staff user ${STAFF_EMAIL}`);
    await staffSubmitsRequest(staffPage);
    await staffContext.close();

    // Look up the request id the UI just created.
    const created = await findRequestByTitle(adminCookie);
    if (!created) throw new Error("Submitted request not found via GET /requests");
    if (created.status === "new") pass("server stored the request with status new");
    else fail(`server stored status "${created.status}", expected "new"`);

    // Admin reviews and deletes it.
    const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const adminPage = await loginViaForm(adminContext, ADMIN_EMAIL, ADMIN_PASSWORD);
    console.log(`Logged in as admin ${ADMIN_EMAIL}`);
    await adminReviewsRequest(adminPage, created.id);
    await adminDeletesRequest(adminPage, created.id);
    await adminContext.close();

    // Confirm it is really gone server-side.
    if (!(await findRequestByTitle(adminCookie)))
      pass("request no longer returned by GET /requests");
    else fail("request still exists server-side after UI delete");
  } finally {
    await browser.close();
    // Belt and braces: remove the request if the UI delete failed, then the
    // temporary staff account.
    const leftover = await findRequestByTitle(adminCookie);
    if (leftover) {
      const del = await fetch(`${apiBase}/requests/${leftover.id}`, {
        method: "DELETE",
        headers: { Cookie: adminCookie },
      });
      if (del.ok) console.log(`Cleaned up test request #${leftover.id} via API`);
      else fail(`could not clean up test request #${leftover.id}: HTTP ${del.status}`);
    }
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
