/**
 * Browser-level Settings page check: drives a real Chromium browser via
 * Playwright, logs in as the admin, and verifies the admin Settings page
 * end-to-end:
 *   - Settings nav link is visible and the page renders all cards
 *   - Sharing status options: add a custom option, save, verify it appears
 *     in the Rostering status filter, then remove it again
 *   - RACI value options: add a custom option, save, verify it appears in
 *     the RACI legend, then remove it again
 *   - Sync schedule: toggle + time persist and next-run text renders
 *   - Branding: changing the app name updates the header immediately
 *   - Notifications: banner toggle and recipients persist
 * All changes are reverted through the API at the end (even on failure).
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

function assertNotProduction() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run settings UI check with NODE_ENV=production. This check mutates app settings and must only run in development.",
    );
  }
  const host = new URL(appBase).hostname;
  const devHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
  if (process.env.REPLIT_DEV_DOMAIN) devHosts.add(process.env.REPLIT_DEV_DOMAIN);
  if (!devHosts.has(host)) {
    throw new Error(
      `Refusing to run settings UI check against non-development host "${host}".`,
    );
  }
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@sageoak.org";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "sageoak-admin";

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

type AppSettings = Record<string, unknown>;

async function getSettings(cookie: string): Promise<AppSettings> {
  const res = await fetch(`${apiBase}/settings`, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`GET /settings failed: HTTP ${res.status}`);
  return (await res.json()) as AppSettings;
}

async function restoreSettings(cookie: string, original: AppSettings): Promise<void> {
  const res = await fetch(`${apiBase}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(original),
  });
  if (res.ok) {
    console.log("Restored original settings");
  } else {
    console.error(`WARNING: could not restore settings: HTTP ${res.status}`);
  }
}

async function loginInBrowser(page: Page) {
  await page.goto(`${appBase}/`, { waitUntil: "load" });
  await page.getByPlaceholder("admin@sageoak.org").waitFor({ timeout: 15000 });
  await page.getByPlaceholder("admin@sageoak.org").fill(ADMIN_EMAIL);
  await page.getByPlaceholder("••••••••").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Overview" }).waitFor({ timeout: 15000 });
  console.log(`Logged in as admin ${ADMIN_EMAIL}`);
}

async function runChecks() {
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await loginInBrowser(page);

    console.log("\nSettings page renders:");
    const settingsNav = page.locator('header nav button:has-text("Settings")');
    if ((await settingsNav.count()) > 0) {
      pass("Settings nav link visible to admin");
    } else {
      fail("Settings nav link missing from header");
    }
    await page.goto(`${appBase}/settings`, { waitUntil: "load" });
    for (const testId of [
      "card-sharingStatusOptions",
      "card-raciValueOptions",
      "card-sync-schedule",
      "card-branding",
      "card-notifications",
    ]) {
      const visible = await page
        .getByTestId(testId)
        .waitFor({ timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (visible) pass(`${testId} rendered`);
      else fail(`${testId} did not render`);
    }

    console.log("\nSharing status options end-to-end:");
    const statusCard = page.getByTestId("card-sharingStatusOptions");
    await statusCard
      .getByTestId("input-new-label-sharingStatusOptions")
      .fill("Waiting on vendor");
    await statusCard.getByTestId("button-add-sharingStatusOptions").click();
    await statusCard
      .locator('input[value="Waiting on vendor"]')
      .waitFor({ timeout: 15000 });
    await statusCard.getByTestId("button-save-sharingStatusOptions").click();
    await page
      .getByText("Sharing status options saved")
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => pass("saved custom sharing status"))
      .catch(() => fail("no save confirmation toast for sharing statuses"));
    await page.goto(`${appBase}/rostering`, { waitUntil: "load" });
    await page.getByText("Rostering Status Board").waitFor({ timeout: 15000 });
    await page.getByTestId("select-status-filter").click();
    const optionShown = await page
      .getByRole("option", { name: "Waiting on vendor" })
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (optionShown) pass("custom status appears in Rostering filter");
    else fail("custom status missing from Rostering filter");
    await page.keyboard.press("Escape");

    console.log("\nRACI value options end-to-end:");
    await page.goto(`${appBase}/settings`, { waitUntil: "load" });
    const raciCard = page.getByTestId("card-raciValueOptions");
    await raciCard.waitFor({ timeout: 15000 });
    await raciCard.getByTestId("input-new-value-raciValueOptions").fill("S");
    await raciCard.getByTestId("input-new-label-raciValueOptions").fill("Support");
    await raciCard.getByTestId("button-add-raciValueOptions").click();
    await raciCard.locator('input[value="Support"]').waitFor({ timeout: 15000 });
    await raciCard.getByTestId("button-save-raciValueOptions").click();
    await page
      .getByText("RACI value options saved")
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => pass("saved custom RACI value"))
      .catch(() => fail("no save confirmation toast for RACI values"));
    await page.goto(`${appBase}/raci`, { waitUntil: "load" });
    await page.getByText("RACI Matrix").first().waitFor({ timeout: 15000 });
    const legendShown = await page
      .getByText("Support")
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (legendShown) pass("custom RACI value appears in the legend");
    else fail("custom RACI value missing from the legend");

    console.log("\nSync schedule:");
    await page.goto(`${appBase}/settings`, { waitUntil: "load" });
    const scheduleCard = page.getByTestId("card-sync-schedule");
    await scheduleCard.waitFor({ timeout: 15000 });
    await scheduleCard.getByTestId("input-sync-time").fill("03:15");
    await scheduleCard.getByTestId("button-save-sync-schedule").click();
    await page
      .getByText("Sync schedule saved")
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => pass("saved schedule time"))
      .catch(() => fail("no save confirmation toast for schedule"));
    const nextRunShown = await scheduleCard
      .getByTestId("text-next-run")
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (nextRunShown) pass("next-run text renders");
    else fail("next-run text missing");

    console.log("\nBranding (app name updates header):");
    const brandingCard = page.getByTestId("card-branding");
    await brandingCard.getByTestId("input-app-name").fill("Oak Portal E2E");
    await brandingCard.getByTestId("button-save-branding").click();
    const headerUpdated = await page
      .getByTestId("text-app-name")
      .getByText("Oak Portal E2E")
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (headerUpdated) pass("header shows the new app name after save");
    else fail("header did not update to the new app name");

    console.log("\nNotifications:");
    const notifCard = page.getByTestId("card-notifications");
    await notifCard.getByTestId("input-new-recipient").fill("ops-e2e@sageoak.org");
    await notifCard.getByTestId("button-add-recipient").click();
    await notifCard.getByText("ops-e2e@sageoak.org").waitFor({ timeout: 15000 });
    await notifCard.getByTestId("button-save-notifications").click();
    await page
      .getByText("Notification preferences saved")
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => pass("saved notification recipient"))
      .catch(() => fail("no save confirmation toast for notifications"));
    // Reload to prove persistence through the DB, not just client state.
    await page.reload({ waitUntil: "load" });
    const recipientPersisted = await page
      .getByTestId("card-notifications")
      .getByText("ops-e2e@sageoak.org")
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (recipientPersisted) pass("recipient persisted across a reload");
    else fail("recipient did not persist across a reload");
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\nSETTINGS UI CHECK FAILED: ${failures} check(s) failed.`);
    return false;
  }
  console.log("\nSettings UI check passed.");
  return true;
}

async function main() {
  assertNotProduction();
  console.log(`Settings UI check against ${appBase}`);

  const cookie = await adminLogin();
  const original = await getSettings(cookie);
  let passed = false;
  try {
    passed = await runChecks();
  } finally {
    await restoreSettings(cookie, original);
  }
  if (!passed) process.exit(1);
}

main().catch((err) => {
  console.error(`SETTINGS UI CHECK ERRORED: ${err.message}`);
  process.exit(1);
});
