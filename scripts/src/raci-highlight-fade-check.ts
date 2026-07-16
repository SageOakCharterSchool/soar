/**
 * Temporary UI check: verifies that the RACI row highlight (arrived at via
 * ?app=<id>) clears after a few seconds — the URL param is stripped and the
 * row is no longer marked highlighted — so a refresh shows no stale highlight.
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
  const q = `
    SELECT rr.application_id
    FROM raci_rows rr
    WHERE rr.application_id IS NOT NULL
    LIMIT 1`;
  const out = execSync(`psql "$DATABASE_URL" -t -A -c "${q.replace(/\n/g, " ")}"`)
    .toString()
    .trim();
  if (!out) throw new Error("No RACI row linked to an application");
  const appId = parseInt(out, 10);
  console.log(`Using application #${appId}`);

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

    await page.goto(`${appBase}/raci?app=${appId}`, { waitUntil: "load" });
    const row = page.locator("tr[data-highlighted]");
    await row.first().waitFor({ timeout: 15000 });
    pass("row is highlighted on arrival via ?app param");

    // Within a few seconds the ?app param should be stripped (replace) and
    // the highlight cleared.
    await page.waitForURL((u) => !u.search.includes("app="), { timeout: 10000 });
    pass("?app param removed from the URL after a moment");
    await row.first().waitFor({ state: "detached", timeout: 5000 });
    pass("highlight cleared after the flash");

    // A refresh must not bring back a stale highlight.
    await page.reload({ waitUntil: "load" });
    await page.getByRole("table").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(1000);
    if ((await row.count()) === 0) pass("refresh shows no stale highlight");
    else fail("refresh brought back a stale highlight");
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll RACI highlight fade checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
