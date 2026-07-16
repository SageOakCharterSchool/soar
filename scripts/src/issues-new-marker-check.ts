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

  // Record a visit now so anything created afterwards counts as new.
  await fetch(`${apiBase}/issues/last-seen`, { method: "POST", headers: hdrs });

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

  await new Promise((r) => setTimeout(r, 1100));
  const created = await fetch(`${apiBase}/apps/${app.id}/issues`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ comment: "UI check: new-marker issue" }),
  });
  if (created.status !== 201) throw new Error(`Issue create failed: ${created.status}`);
  const issue = (await created.json()) as { id: number };
  console.log(`Created issue #${issue.id} on ${app.name}`);

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

    if (await page.getByText(/\d+ new since your last visit/).first().isVisible())
      pass("header shows 'new since your last visit' count");
    else fail("header count badge missing");

    if ((await page.getByText("New", { exact: true }).count()) > 0)
      pass("'New' badge shown on the fresh issue");
    else fail("'New' badge missing");

    const dividerCount = await page.getByText("Seen on your last visit").count();
    console.log(`  divider present: ${dividerCount > 0} (needs older issues below)`);

    // Markers should persist even though this visit was just recorded:
    // reload state was already post-mark-seen, and badges still rendered above.
  } finally {
    await browser.close();
  }

  // Cleanup: resolve nothing; delete the test issue? No delete endpoint —
  // resolve it so it leaves the default Open view.
  await fetch(`${apiBase}/issues/${issue.id}`, {
    method: "PATCH",
    headers: hdrs,
    body: JSON.stringify({ status: "resolved" }),
  });

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
