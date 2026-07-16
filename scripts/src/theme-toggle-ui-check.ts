/**
 * Browser-level dark mode toggle check: logs in as the admin user and
 * verifies that:
 *   - the header shows a theme toggle button
 *   - clicking it adds the `.dark` class and switches the header logo to the
 *     white tree asset
 *   - the choice persists across a page reload (localStorage)
 *   - toggling back restores light mode and the green tree logo
 * Exits with code 1 (fails loudly) on any mismatch.
 *
 * Requires the web dashboard and API server workflows to be running.
 * Uses the Nix-provided chromium binary (CHROMIUM_PATH overrides).
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
function fail(msg: string) {
  failures++;
  console.error(`  FAIL: ${msg}`);
}
function pass(msg: string) {
  console.log(`  ok: ${msg}`);
}

function chromiumPath(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return execSync("which chromium").toString().trim();
}

async function isDark(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains("dark"));
}

async function logoSrc(page: Page): Promise<string> {
  return (await page.getByTestId("img-app-logo").getAttribute("src")) ?? "";
}

async function storedTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem("sageoak-theme"));
}

async function run() {
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
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
    console.log("Logged in as admin");

    const toggle = page.getByTestId("button-theme-toggle");

    console.log("\nInitial state:");
    if ((await toggle.count()) === 1) pass("theme toggle is present in the header");
    else fail("theme toggle button not found");
    if (!(await isDark(page))) pass("starts in light mode");
    else fail("page unexpectedly started in dark mode");
    if ((await logoSrc(page)).includes("sageoak-tree-green.png")) {
      pass("light mode shows green tree logo");
    } else {
      fail(`light mode logo is "${await logoSrc(page)}", expected green tree`);
    }

    console.log("\nToggle to dark:");
    await toggle.click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    pass(".dark class applied");
    if ((await logoSrc(page)).includes("sageoak-tree-white.png")) {
      pass("dark mode shows white tree logo");
    } else {
      fail(`dark mode logo is "${await logoSrc(page)}", expected white tree`);
    }
    if ((await storedTheme(page)) === "dark") pass('localStorage stores "dark"');
    else fail(`localStorage theme is ${JSON.stringify(await storedTheme(page))}, expected "dark"`);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    console.log(`  info: body background in dark mode is ${bg}`);

    console.log("\nPersistence across reload:");
    await page.reload({ waitUntil: "load" });
    await page.getByRole("button", { name: "Overview" }).waitFor({ timeout: 15000 });
    if (await isDark(page)) pass("dark mode persists after reload");
    else fail("dark mode did not persist after reload");
    if ((await logoSrc(page)).includes("sageoak-tree-white.png")) {
      pass("white tree logo persists after reload");
    } else {
      fail(`logo after reload is "${await logoSrc(page)}", expected white tree`);
    }

    console.log("\nToggle back to light:");
    await toggle.click();
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    pass(".dark class removed");
    if ((await logoSrc(page)).includes("sageoak-tree-green.png")) {
      pass("green tree logo restored");
    } else {
      fail(`light mode logo is "${await logoSrc(page)}", expected green tree`);
    }
    if ((await storedTheme(page)) === "light") pass('localStorage stores "light"');
    else fail(`localStorage theme is ${JSON.stringify(await storedTheme(page))}, expected "light"`);
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll dark mode toggle checks passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
