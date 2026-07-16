/**
 * Temporary UI check: verifies that clicking a RACI chip on the Issues page
 * and the Rostering board navigates to the RACI page with the matching row
 * selected, highlighted, and scrolled into view.
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

  // Find an application that has a RACI row with at least one R/A assignment
  // (so its chips are rendered on the board), straight from the dev DB.
  const q = `
    SELECT rr.application_id, a.name
    FROM raci_rows rr
    JOIN applications a ON a.id = rr.application_id
    JOIN raci_assignments ra ON ra.row_id = rr.id AND ra.value IN ('R','A')
    WHERE rr.application_id IS NOT NULL
    LIMIT 1`;
  const out = execSync(`psql "$DATABASE_URL" -t -A -F '|' -c "${q.replace(/\n/g, " ")}"`)
    .toString()
    .trim();
  if (!out) throw new Error("No RACI row linked to an application with R/A assignments");
  const [idStr, appName] = out.split("|") as [string, string];
  const appId = parseInt(idStr, 10);
  console.log(`Using application #${appId} (${appName})`);

  // Ensure there's an open issue for this app so the Issues page shows chips.
  const created = await fetch(`${apiBase}/apps/${appId}/issues`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ comment: "UI check: raci chip link" }),
  });
  if (created.status !== 201) throw new Error(`Issue create failed: ${created.status}`);
  const issue = (await created.json()) as { id: number };

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

    const checkHighlight = async (from: string) => {
      await page.waitForURL(new RegExp(`/raci\\?app=${appId}$`), { timeout: 15000 });
      pass(`${from}: navigated to /raci?app=${appId}`);
      const row = page.locator("tr[data-highlighted]");
      await row.first().waitFor({ timeout: 15000 });
      const count = await row.count();
      if (count === 1) pass(`${from}: exactly one highlighted row`);
      else fail(`${from}: expected 1 highlighted row, got ${count}`);
      const inView = await row.first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
      if (inView) pass(`${from}: highlighted row is scrolled into view`);
      else fail(`${from}: highlighted row not in viewport`);
    };

    // 1) Issues page chip
    await page.goto(`${appBase}/issues`, { waitUntil: "load" });
    await page.getByText("UI check: raci chip link").first().waitFor({ timeout: 15000 });
    const issueCard = page
      .locator("div", { hasText: "UI check: raci chip link" })
      .locator("button[title*='RACI matrix']")
      .first();
    await issueCard.click();
    await checkHighlight("issues");

    // 2) Rostering board chip
    await page.goto(`${appBase}/rostering`, { waitUntil: "load" });
    const boardChip = page.locator("button[title*='RACI matrix']").first();
    await boardChip.waitFor({ timeout: 15000 });
    await boardChip.click();
    await page.waitForURL(/\/raci\?app=\d+$/, { timeout: 15000 });
    pass("rostering: chip navigated to RACI page with app param");
    await page.locator("tr[data-highlighted]").first().waitFor({ timeout: 15000 });
    pass("rostering: a row is highlighted");
  } finally {
    await browser.close();
    // Clean up the test issue.
    await fetch(`${apiBase}/issues/${issue.id}`, {
      method: "PATCH",
      headers: hdrs,
      body: JSON.stringify({ status: "resolved" }),
    }).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll RACI chip link checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
