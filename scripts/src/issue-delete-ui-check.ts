/**
 * Temporary UI check: verifies that an admin can delete an issue from the
 * Issues page via the trash button + confirmation dialog, that the issue
 * disappears from the list immediately, and that no unseen-count trace remains.
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

const MARKER = `UI check: delete-flow issue ${Date.now()}`;

async function main() {
  const loginRes = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`Admin login failed: ${loginRes.status}`);
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
  const hdrs = { "Content-Type": "application/json", Cookie: cookie };

  // Record a visit now so the created issue counts toward the unseen badge.
  await fetch(`${apiBase}/issues/last-seen`, { method: "POST", headers: hdrs });

  const appId = parseInt(
    execSync(`psql "$DATABASE_URL" -t -A -c "SELECT id FROM applications ORDER BY id LIMIT 1"`)
      .toString()
      .trim(),
    10,
  );
  if (Number.isNaN(appId))
    throw new Error("No applications available to report an issue against");

  await new Promise((r) => setTimeout(r, 1100));
  const created = await fetch(`${apiBase}/apps/${appId}/issues`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ comment: MARKER }),
  });
  if (created.status !== 201) throw new Error(`Issue create failed: ${created.status}`);
  const issue = (await created.json()) as { id: number };
  console.log(`Created issue #${issue.id}`);

  try {
    await runBrowserChecks();
  } finally {
    // Safety-net cleanup in case the UI delete failed.
    const res = await fetch(`${apiBase}/issues/${issue.id}`, {
      method: "DELETE",
      headers: hdrs,
    });
    if (res.ok) console.log(`Cleanup: deleted leftover issue #${issue.id} via API`);
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
      await page.getByText(MARKER).first().waitFor({ timeout: 15000 });

      // Find the card containing the marker text, then its delete button.
      const cardLoc = page
        .getByText(MARKER)
        .locator("xpath=ancestor::*[contains(@class,'p-4')][1]");
      const btn = cardLoc.getByRole("button", { name: "Delete issue" });
      if ((await btn.count()) > 0) pass("delete button visible on issue card for admin");
      else {
        fail("delete button not found on issue card");
        return;
      }

      await btn.first().click();
      const dialogTitle = page.getByText("Delete this issue?");
      await dialogTitle.waitFor({ timeout: 5000 });
      pass("confirmation dialog appears");

      // Cancel first — issue should remain.
      await page.getByRole("button", { name: "Cancel" }).click();
      await dialogTitle.waitFor({ state: "hidden", timeout: 5000 });
      if (await page.getByText(MARKER).first().isVisible())
        pass("cancel leaves the issue in place");
      else fail("issue vanished after cancel");

      // Now actually delete.
      await btn.first().click();
      await dialogTitle.waitFor({ timeout: 5000 });
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page
        .getByText(MARKER)
        .first()
        .waitFor({ state: "hidden", timeout: 10000 })
        .then(() => pass("issue removed from list immediately after delete"))
        .catch(() => fail("issue still visible after delete"));

      // No trace in unseen counts: a fresh check of the unseen-count endpoint
      // should not count the deleted issue's activity.
      const unseen = await fetch(`${apiBase}/issues/unseen-count`, { headers: hdrs });
      const { count } = (await unseen.json()) as { count: number };
      if (count === 0) pass("unseen count is 0 — no activity trace left");
      else fail(`unseen count is ${count}, expected 0 (activity trace remains)`);
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
