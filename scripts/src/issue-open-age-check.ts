/**
 * Temporary UI check: verifies that open issue cards show how long they have
 * been open, and that issues open past the threshold get an amber warning badge.
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

  const appId = parseInt(
    execSync(`psql "$DATABASE_URL" -t -A -c "SELECT id FROM applications ORDER BY id LIMIT 1"`)
      .toString()
      .trim(),
    10,
  );
  if (Number.isNaN(appId))
    throw new Error("No applications available to report an issue against");

  const createIssue = async (comment: string) => {
    const res = await fetch(`${apiBase}/apps/${appId}/issues`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ comment }),
    });
    if (res.status !== 201) throw new Error(`Issue create failed: ${res.status}`);
    return (await res.json()) as { id: number };
  };

  const fresh = await createIssue("UI check: open-age fresh issue");
  const stale = await createIssue("UI check: open-age stale issue");
  // Backdate the stale issue 12 days.
  execSync(
    `psql "$DATABASE_URL" -c "UPDATE app_issues SET created_at = now() - interval '12 days' WHERE id = ${stale.id}"`,
  );
  console.log(`Created issues #${fresh.id} (fresh) and #${stale.id} (backdated 12 days)`);

  try {
    await runBrowserChecks();
  } finally {
    for (const id of [fresh.id, stale.id]) {
      const deleted = await fetch(`${apiBase}/issues/${id}`, {
        method: "DELETE",
        headers: hdrs,
      });
      if (deleted.ok) console.log(`Deleted test issue #${id}`);
      else fail(`cleanup delete of issue #${id} failed: ${deleted.status}`);
    }
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
      await page.getByText("UI check: open-age fresh issue").first().waitFor({ timeout: 15000 });

      const freshCard = page
        .locator("div")
        .filter({ hasText: "UI check: open-age fresh issue" })
        .getByText("Open for less than a day")
        .first();
      if (await freshCard.isVisible())
        pass("fresh open issue shows 'Open for less than a day'");
      else fail("fresh issue open-age badge missing");

      const staleBadge = page.getByText("Open for 12 days").first();
      if (await staleBadge.isVisible()) pass("stale issue shows 'Open for 12 days'");
      else fail("stale issue open-age badge missing");

      const staleClass = (await staleBadge.getAttribute("class")) ?? "";
      if (staleClass.includes("amber")) pass("stale badge uses amber warning styling");
      else fail(`stale badge lacks warning styling (class="${staleClass}")`);

      const freshClass =
        (await page.getByText("Open for less than a day").first().getAttribute("class")) ?? "";
      if (!freshClass.includes("amber")) pass("fresh badge has no warning styling");
      else fail("fresh badge unexpectedly styled as warning");
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
