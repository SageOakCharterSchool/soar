/**
 * Browser-level check for the Overview "columns hidden" indicator:
 *   1. Logs in as admin and verifies no note is shown when the current
 *      snapshot's data implies no hidden columns (and vice versa).
 *   2. Simulates a partial Clever sync by intercepting the by-school and
 *      applist API responses (nulling adoption % / active-time, fabricating
 *      rows if the snapshot is empty) and verifies the notes appear.
 *
 * Requires the web dashboard and API server workflows to be running.
 * Uses the Nix-provided chromium binary (CHROMIUM_PATH overrides).
 */
import { execSync } from "node:child_process";
import { chromium } from "playwright-core";

const appBase =
  process.env.APP_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:80");
const apiBase = `${appBase}/api`;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@sageoak.org";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "sageoak-admin";

async function main() {
  let token = "";
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await fetch(`${apiBase}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      if (res.ok) {
        token = ((await res.json()) as { token: string }).token;
        break;
      }
      if (res.status < 500) throw new Error(`login failed: ${res.status}`);
    } catch (e) {
      if (attempt === 10) throw e;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  const auth = { Authorization: `Bearer ${token}` };

  const bySchool = (await (
    await fetch(`${apiBase}/usage/by-school`, { headers: auth })
  ).json()) as Array<Record<string, unknown>>;
  const engagement = (await (
    await fetch(`${apiBase}/usage/applist`, { headers: auth })
  ).json()) as Array<Record<string, unknown>>;

  const schoolHidden =
    bySchool.length > 0 &&
    (["uniqueUsers", "scopedUsers", "adoptionPct"] as const).some(
      (k) => !bySchool.some((s) => s[k] != null),
    );
  const engHidden =
    engagement.length > 0 &&
    !engagement.some((e) => e.activeTimePerUserMinutes != null);
  const expectNote = schoolHidden || engHidden;
  console.log(`data: schoolHidden=${schoolHidden} engHidden=${engHidden}`);

  const exe =
    process.env.CHROMIUM_PATH ?? execSync("which chromium").toString().trim();
  const browser = await chromium.launch({
    executablePath: exe,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto(appBase, { waitUntil: "domcontentloaded" });
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForSelector("text=Usage Overview", { timeout: 20000 });
  await page.waitForTimeout(2000);

  const noteCount = await page
    .locator('[data-testid="hidden-columns-note"]')
    .count();
  console.log(`notes on page: ${noteCount}, expected some: ${expectNote}`);
  if (expectNote && noteCount === 0) {
    console.error("FAIL: expected hidden-columns note but none rendered");
    process.exit(1);
  }
  if (!expectNote && noteCount > 0) {
    console.error("FAIL: note rendered although all columns have data");
    process.exit(1);
  }

  // Positive case: simulate a partial sync by nulling active-time and
  // by-school adoption in the API responses, then reload and expect notes.
  await page.route("**/usage/applist**", async (route) => {
    const res = await route.fetch();
    let rows = (await res.json()) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      rows = [
        {
          appName: "Test App",
          studentCount: 10,
          studentPercent: 50,
          teacherCount: 2,
          teacherPercent: 20,
          activeTimePerUserMinutes: null,
        },
      ];
    } else {
      for (const r of rows) r.activeTimePerUserMinutes = null;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rows),
    });
  });
  await page.route("**/usage/by-school**", async (route) => {
    const res = await route.fetch();
    let rows = (await res.json()) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      rows = [{ school: "Test School", uniqueUsers: 5, scopedUsers: 10, adoptionPct: null }];
    } else {
      for (const r of rows) r.adoptionPct = null;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rows),
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Usage Overview", { timeout: 20000 });
  await page.waitForTimeout(2000);

  const simulatedNotes = await page
    .locator('[data-testid="hidden-columns-note"]')
    .count();
  console.log(`simulated partial sync: notes=${simulatedNotes} (expect 2)`);
  if (simulatedNotes < 2) {
    console.error("FAIL: notes did not appear for simulated partial sync");
    process.exit(1);
  }
  const noteText = await page
    .locator('[data-testid="hidden-columns-note"]')
    .first()
    .textContent();
  console.log(`note text: ${noteText?.trim()}`);

  console.log("OK");
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
