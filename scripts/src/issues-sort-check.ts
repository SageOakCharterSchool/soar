/**
 * Temporary UI check: verifies the Issues page defaults to "Longest waiting"
 * order (oldest open issues on top) and that "Newest first" flips the order.
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

  const FRESH = "UI check: sort fresh issue";
  const STALE = "UI check: sort stale issue";
  const fresh = await createIssue(FRESH);
  const stale = await createIssue(STALE);
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
      await page.getByText(FRESH).first().waitFor({ timeout: 15000 });
      await page.getByText(STALE).first().waitFor({ timeout: 15000 });

      const orderOf = async () => {
        const texts = await page
          .locator("p.text-sm")
          .allTextContents();
        const staleIdx = texts.findIndex((t) => t.includes(STALE));
        const freshIdx = texts.findIndex((t) => t.includes(FRESH));
        return { staleIdx, freshIdx };
      };

      // Default sort should be "Longest waiting" with stale issue on top.
      const def = await orderOf();
      if (def.staleIdx >= 0 && def.freshIdx >= 0 && def.staleIdx < def.freshIdx)
        pass("default sort puts 12-day-old issue above fresh issue");
      else fail(`default sort order wrong (stale=${def.staleIdx}, fresh=${def.freshIdx})`);

      // Switch to "Newest first" — fresh issue should come first.
      await page.getByRole("button", { name: "Newest first" }).click();
      await page.waitForTimeout(300);
      const newest = await orderOf();
      if (newest.freshIdx >= 0 && newest.staleIdx >= 0 && newest.freshIdx < newest.staleIdx)
        pass("'Newest first' puts fresh issue above 12-day-old issue");
      else
        fail(`newest-first order wrong (stale=${newest.staleIdx}, fresh=${newest.freshIdx})`);

      // Switch back to "Longest waiting".
      await page.getByRole("button", { name: "Longest waiting" }).click();
      await page.waitForTimeout(300);
      const back = await orderOf();
      if (back.staleIdx >= 0 && back.freshIdx >= 0 && back.staleIdx < back.freshIdx)
        pass("switching back to 'Longest waiting' restores oldest-first order");
      else fail(`longest-waiting order wrong after toggle (stale=${back.staleIdx}, fresh=${back.freshIdx})`);
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
