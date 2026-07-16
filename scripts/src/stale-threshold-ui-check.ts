/**
 * UI check: verifies the admin "flag open issues after N days" control on the
 * Issues page actually saves via PUT /api/settings and that the amber
 * "Open for N days" badge re-evaluates against the new threshold.
 *
 * Flow:
 *   1. Create a test issue backdated 3 days.
 *   2. Set the threshold to 10 via the inline input -> badge should NOT be amber.
 *   3. Set the threshold to 2 via the inline input -> badge SHOULD be amber.
 *   4. Restore the original threshold and delete the test issue.
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

const BACKDATE_DAYS = 3;

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.error(`  FAIL: ${m}`);
};
const pass = (m: string) => console.log(`  ok: ${m}`);

async function main() {
  const loginRes = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`Admin login failed: ${loginRes.status}`);
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
  const hdrs = { "Content-Type": "application/json", Cookie: cookie };

  const settingsRes = await fetch(`${apiBase}/settings`, { headers: hdrs });
  if (!settingsRes.ok)
    throw new Error(`GET /settings failed: ${settingsRes.status}`);
  const originalThreshold = ((await settingsRes.json()) as { staleOpenDays: number })
    .staleOpenDays;
  console.log(`Original threshold: ${originalThreshold} days`);

  // Pick test values dynamically so neither equals the current threshold
  // (saving an unchanged value is a no-op with no toast). Loose must exceed
  // BACKDATE_DAYS, tight must be at or below it.
  const LOOSE_THRESHOLD = originalThreshold === 10 ? 11 : 10; // badge plain
  const TIGHT_THRESHOLD = originalThreshold === 2 ? 1 : 2; // badge amber

  const appId = parseInt(
    execSync(`psql "$DATABASE_URL" -t -A -c "SELECT id FROM applications ORDER BY id LIMIT 1"`)
      .toString()
      .trim(),
    10,
  );
  if (Number.isNaN(appId))
    throw new Error("No applications available to report an issue against");

  const createRes = await fetch(`${apiBase}/apps/${appId}/issues`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ comment: "UI check: stale-threshold test issue" }),
  });
  if (createRes.status !== 201)
    throw new Error(`Issue create failed: ${createRes.status}`);
  const issue = (await createRes.json()) as { id: number };
  execSync(
    `psql "$DATABASE_URL" -c "UPDATE app_issues SET created_at = now() - interval '${BACKDATE_DAYS} days' WHERE id = ${issue.id}"`,
  );
  console.log(`Created issue #${issue.id} backdated ${BACKDATE_DAYS} days`);

  try {
    await runBrowserChecks();
  } finally {
    const restored = await fetch(`${apiBase}/settings`, {
      method: "PUT",
      headers: hdrs,
      body: JSON.stringify({ staleOpenDays: originalThreshold }),
    });
    if (restored.ok) console.log(`Restored threshold to ${originalThreshold} days`);
    else fail(`failed to restore threshold: ${restored.status}`);

    const deleted = await fetch(`${apiBase}/issues/${issue.id}`, {
      method: "DELETE",
      headers: hdrs,
    });
    if (deleted.ok) console.log(`Deleted test issue #${issue.id}`);
    else fail(`cleanup delete of issue #${issue.id} failed: ${deleted.status}`);
  }

  async function runBrowserChecks() {
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_PATH ?? execSync("which chromium").toString().trim(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await page.goto(`${appBase}/`, { waitUntil: "load" });
      await page.getByPlaceholder("admin@sageoak.org").waitFor({ timeout: 15000 });
      await page.getByPlaceholder("admin@sageoak.org").fill(ADMIN_EMAIL);
      await page.getByPlaceholder("••••••••").fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("button", { name: "Overview" }).waitFor({ timeout: 15000 });

      await page.goto(`${appBase}/issues`, { waitUntil: "load" });
      await page
        .getByText("UI check: stale-threshold test issue")
        .first()
        .waitFor({ timeout: 15000 });

      const thresholdInput = page.getByLabel(
        "Days before an open issue is flagged as open too long",
      );
      await thresholdInput.waitFor({ timeout: 15000 });
      if ((await thresholdInput.inputValue()) === String(originalThreshold))
        pass(`threshold input shows current value (${originalThreshold})`);
      else
        fail(
          `threshold input shows "${await thresholdInput.inputValue()}", expected ${originalThreshold}`,
        );

      // Scope the badge to the card for our test issue so other issues with
      // the same age can't be matched by accident.
      const badge = page
        .locator("div")
        .filter({ hasText: "UI check: stale-threshold test issue" })
        .getByText(`Open for ${BACKDATE_DAYS} days`)
        .first();
      await badge.waitFor({ timeout: 15000 });

      const setThreshold = async (value: number) => {
        await thresholdInput.fill(String(value));
        await thresholdInput.press("Enter");
        // Wait on the unique success toast text for this specific save.
        await page
          .getByText(
            `Open issues are now flagged after ${value} ${value === 1 ? "day" : "days"}.`,
          )
          .first()
          .waitFor({ timeout: 15000 });
        pass(`saved threshold ${value} (success toast shown)`);
      };

      const badgeIsAmber = async () =>
        ((await badge.getAttribute("class")) ?? "").includes("amber");

      // Poll until the badge's amber styling matches the expected state (the
      // badge re-renders after the settings query is invalidated).
      const waitForAmber = async (expected: boolean) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          if ((await badgeIsAmber()) === expected) return;
          await page.waitForTimeout(250);
        }
      };

      // Loose threshold: 3-day-old issue should NOT be flagged.
      await setThreshold(LOOSE_THRESHOLD);
      await waitForAmber(false);
      if (!(await badgeIsAmber()))
        pass(`badge is unflagged with threshold ${LOOSE_THRESHOLD}`);
      else fail(`badge still amber with threshold ${LOOSE_THRESHOLD}`);

      // Tight threshold: same issue should now be flagged amber.
      await setThreshold(TIGHT_THRESHOLD);
      await waitForAmber(true);
      if (await badgeIsAmber())
        pass(`badge flips to amber with threshold ${TIGHT_THRESHOLD}`);
      else fail(`badge not amber with threshold ${TIGHT_THRESHOLD}`);

      // Confirm the tight threshold actually persisted server-side.
      const persisted = await fetch(`${apiBase}/settings`, { headers: hdrs });
      const persistedDays = ((await persisted.json()) as { staleOpenDays: number })
        .staleOpenDays;
      if (persistedDays === TIGHT_THRESHOLD)
        pass("threshold change persisted via PUT /api/settings");
      else fail(`server threshold is ${persistedDays}, expected ${TIGHT_THRESHOLD}`);
    } finally {
      await browser.close();
    }
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
