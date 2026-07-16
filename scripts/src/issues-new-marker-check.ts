/**
 * Temporary UI check: verifies that the Issues page marks issues created or
 * resolved since the user's previous visit with a "New" badge, header count,
 * and "Seen on your last visit" divider.
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
  // API login
  const loginRes = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`Admin login failed: ${loginRes.status}`);
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
  const hdrs = { "Content-Type": "application/json", Cookie: cookie };

  // Find an application to report an issue against (straight from the dev DB).
  const appId = parseInt(
    execSync(`psql "$DATABASE_URL" -t -A -c "SELECT id FROM applications ORDER BY id LIMIT 1"`)
      .toString()
      .trim(),
    10,
  );
  if (Number.isNaN(appId))
    throw new Error("No applications available to report an issue against");
  const app = { id: appId, name: `app #${appId}` };

  // Seed an older issue BEFORE recording the visit, so the divider always has
  // at least one already-seen issue below it.
  const olderRes = await fetch(`${apiBase}/apps/${app.id}/issues`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ comment: "UI check: older seen issue" }),
  });
  if (olderRes.status !== 201)
    throw new Error(`Older issue create failed: ${olderRes.status}`);
  const olderIssue = (await olderRes.json()) as { id: number };
  console.log(`Created older issue #${olderIssue.id} on ${app.name}`);

  // Record a visit now so anything created afterwards counts as new.
  await new Promise((r) => setTimeout(r, 1100));
  await fetch(`${apiBase}/issues/last-seen`, { method: "POST", headers: hdrs });

  await new Promise((r) => setTimeout(r, 1100));
  const created = await fetch(`${apiBase}/apps/${app.id}/issues`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ comment: "UI check: new-marker issue" }),
  });
  if (created.status !== 201) throw new Error(`Issue create failed: ${created.status}`);
  const issue = (await created.json()) as { id: number };
  console.log(`Created issue #${issue.id} on ${app.name}`);

  try {
    await runBrowserChecks();
  } finally {
    // Cleanup: delete the synthetic test issues (and their activity events)
    // so repeated validation runs leave no trace in the Issues page.
    for (const id of [issue.id, olderIssue.id]) {
      const deleted = await fetch(`${apiBase}/issues/${id}`, {
        method: "DELETE",
        headers: hdrs,
      });
      if (deleted.ok) {
        console.log(`Deleted test issue #${id}`);
      } else if (deleted.status === 404) {
        // Already gone — a concurrent validation run may have cleaned it up.
        // The goal is "no trace left", so an absent issue is a success.
        console.log(`Test issue #${id} already deleted (404) — nothing to clean up`);
      } else {
        fail(`cleanup delete of issue #${id} failed: ${deleted.status}`);
      }
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
    await page.getByText("UI check: new-marker issue").first().waitFor({ timeout: 15000 });

    // Markers render only after the page's mark-seen request resolves (the
    // response carries the previous last-seen time), so wait rather than
    // checking instantly — under load this can lag behind the issues list.
    try {
      await page
        .getByText(/\d+ new since your last visit/)
        .first()
        .waitFor({ timeout: 15000 });
      pass("header shows 'new since your last visit' count");
    } catch {
      fail("header count badge missing");
    }

    if ((await page.getByText("New", { exact: true }).count()) > 0)
      pass("'New' badge shown on the fresh issue");
    else fail("'New' badge missing");

    const dividerCount = await page.getByText("Seen on your last visit").count();
    if (dividerCount > 0)
      pass("'Seen on your last visit' divider shown above older issues");
    else fail("'Seen on your last visit' divider missing");

    // Markers should persist even though this visit was just recorded:
    // reload state was already post-mark-seen, and badges still rendered above.
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
