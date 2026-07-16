/**
 * Temporary UI check: verifies that resolved issues without a recorded
 * resolvedAt date show an explanatory note, and that the average turnaround
 * badge states how many resolved issues it covers when some lack dates.
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
  if (Number.isNaN(appId)) throw new Error("No applications available");

  // Create two synthetic issues: one resolved normally (gets a date), one
  // made to look like a legacy row (resolved_at nulled directly in the DB).
  const mk = async (comment: string) => {
    const res = await fetch(`${apiBase}/apps/${appId}/issues`, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ comment }),
    });
    if (res.status !== 201) throw new Error(`Issue create failed: ${res.status}`);
    return ((await res.json()) as { id: number }).id;
  };
  const datedId = await mk("UI check: dated resolved issue");
  const legacyId = await mk("UI check: legacy resolved issue");
  for (const id of [datedId, legacyId]) {
    const res = await fetch(`${apiBase}/issues/${id}`, {
      method: "PATCH",
      headers: hdrs,
      body: JSON.stringify({ status: "resolved" }),
    });
    if (!res.ok) throw new Error(`Resolve failed for #${id}: ${res.status}`);
  }
  execSync(
    `psql "$DATABASE_URL" -c "UPDATE app_issues SET resolved_at = NULL WHERE id = ${legacyId}"`,
  );
  console.log(`Created issues: dated #${datedId}, legacy #${legacyId}`);

  try {
    await runBrowserChecks();
  } finally {
    for (const id of [datedId, legacyId]) {
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
      await page.getByRole("button", { name: "Resolved" }).click();
      await page.getByText("UI check: legacy resolved issue").first().waitFor({ timeout: 15000 });

      if (
        (await page
          .getByText("Resolved (date not recorded — resolved before dates were tracked)")
          .count()) > 0
      )
        pass("legacy resolved issue explains its date is unknown");
      else fail("legacy resolved issue missing 'date not recorded' note");

      const dated = page.getByText("UI check: dated resolved issue").first();
      const datedCard = dated.locator("xpath=ancestor::div[contains(@class,'space-y-1')]");
      if ((await datedCard.getByText(/Resolved on /).count()) > 0)
        pass("dated resolved issue still shows 'Resolved on' date");
      else fail("dated resolved issue missing 'Resolved on' date");

      const badge = page.getByText(/Avg turnaround:/).first();
      if (await badge.isVisible()) {
        const text = (await badge.textContent()) ?? "";
        if (/based on \d+ of \d+ resolved issues/.test(text) && /no recorded date/.test(text))
          pass(`avg badge states coverage: "${text.trim()}"`);
        else fail(`avg badge missing coverage note: "${text.trim()}"`);
      } else fail("avg turnaround badge not visible despite a dated resolved issue");
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
