/**
 * Temporary UI check: verifies that /raci?app=<id> for an application with no
 * matrix row shows a dismissible notice, and that plain /raci does not.
 */
import { execSync } from "node:child_process";
import { chromium } from "playwright-core";

const appBase =
  process.env.APP_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:80");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@sageoak.org";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "sageoak-admin";

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.error(`  FAIL: ${m}`);
};
const pass = (m: string) => console.log(`  ok: ${m}`);

async function main() {
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

    const notice = page.getByTestId("raci-missing-row-notice");

    // 1) ?app= pointing at a nonexistent row shows the notice.
    await page.goto(`${appBase}/raci?app=99999999`, { waitUntil: "load" });
    await notice.waitFor({ timeout: 15000 });
    const text = await notice.textContent();
    if (text?.includes("no longer has a RACI row"))
      pass("notice shown with expected message for missing row");
    else fail(`notice text unexpected: ${text}`);

    // 2) Dismiss button hides it.
    await notice.getByRole("button", { name: "Dismiss notice" }).click();
    await notice.waitFor({ state: "detached", timeout: 5000 });
    pass("notice dismisses on click");

    // 3) Plain /raci shows no notice.
    await page.goto(`${appBase}/raci`, { waitUntil: "load" });
    await page
      .getByRole("heading", { name: "RACI Matrix" })
      .waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    if ((await notice.count()) === 0) pass("no notice on plain /raci");
    else fail("notice unexpectedly shown on plain /raci");

    // 4) ?app= for an application that HAS a row: no notice, row highlighted.
    const out = execSync(
      `psql "$DATABASE_URL" -t -A -c "SELECT application_id FROM raci_rows WHERE application_id IS NOT NULL LIMIT 1"`,
    )
      .toString()
      .trim();
    if (out) {
      await page.goto(`${appBase}/raci?app=${out}`, { waitUntil: "load" });
      await page.locator("tr[data-highlighted]").first().waitFor({ timeout: 15000 });
      if ((await notice.count()) === 0)
        pass("existing row: highlighted with no notice");
      else fail("existing row: notice unexpectedly shown");
    } else {
      console.log("  skip: no application-linked RACI rows to test highlight");
    }
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll RACI missing-row notice checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
