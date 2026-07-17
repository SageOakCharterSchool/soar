/**
 * Permanent UI check: the RACI team and Rostering term selections are
 * remembered across a page refresh (localStorage keys `sageoak-raci-team` /
 * `sageoak-rostering-term`), and a stale stored id falls back to the default
 * without breaking the page.
 */
import { execSync } from "node:child_process";
import { chromium, type Page } from "playwright-core";

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

/**
 * The selected team/term button uses the filled (default) variant which has
 * aria-pressed-like styling via bg-primary; others are outlined.
 */
async function selectedButtonText(page: Page, container: string) {
  return page
    .locator(`${container} button.bg-primary, ${container} button[class*="bg-primary"]`)
    .first()
    .innerText();
}

async function checkPage(
  page: Page,
  opts: {
    label: string;
    path: string;
    storageKey: string;
  },
) {
  const { label, path, storageKey } = opts;
  console.log(`\n${label}:`);

  await page.goto(`${appBase}${path}`, { waitUntil: "load" });
  const buttons = page.locator("div.flex.flex-wrap.gap-1\\.5 > button");
  await buttons.first().waitFor({ timeout: 15000 });
  const count = await buttons.count();
  if (count < 2) {
    console.log(`  skip: only ${count} option(s), need 2 to test selection`);
    return;
  }

  // Click the second (non-default) option and confirm it is remembered.
  const secondText = (await buttons.nth(1).innerText()).trim();
  await buttons.nth(1).click();
  await page.waitForTimeout(300);
  const stored = await page.evaluate(
    (k: string) => localStorage.getItem(k),
    storageKey,
  );
  if (stored != null) pass(`selection stored in localStorage (${storageKey}=${stored})`);
  else fail(`nothing stored under ${storageKey} after selecting`);

  await page.reload({ waitUntil: "load" });
  await buttons.first().waitFor({ timeout: 15000 });
  const selectedAfter = (
    await selectedButtonText(page, "div.flex.flex-wrap.gap-1\\.5")
  ).trim();
  if (selectedAfter === secondText)
    pass(`selection "${secondText}" restored after refresh`);
  else
    fail(
      `expected "${secondText}" selected after refresh, got "${selectedAfter}"`,
    );

  // A stale stored id (deleted team/term) must fall back to a default
  // without breaking the page.
  await page.evaluate(
    (k: string) => localStorage.setItem(k, "999999"),
    storageKey,
  );
  await page.reload({ waitUntil: "load" });
  await buttons.first().waitFor({ timeout: 15000 });
  const fallback = (
    await selectedButtonText(page, "div.flex.flex-wrap.gap-1\\.5")
  ).trim();
  if (fallback.length > 0) pass(`stale stored id falls back to "${fallback}"`);
  else fail("no selection after a stale stored id");
}

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

    await checkPage(page, {
      label: "RACI team selection",
      path: "/raci",
      storageKey: "sageoak-raci-team",
    });
    await checkPage(page, {
      label: "Rostering term selection",
      path: "/rostering",
      storageKey: "sageoak-rostering-term",
    });
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll stored-filter checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
