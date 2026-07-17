/**
 * Browser-level login-page branding check: drives a real Chromium browser via
 * Playwright against the running dashboard and verifies the SageStride
 * branding on the login page:
 *   1. The white tree logo (data-testid="img-login-logo") uses
 *      sageoak-tree-white.png and actually loads (non-zero natural size).
 *   2. The "Sage Oak" / "Charter Schools" wordmark is visible.
 *   3. The "Operations Dashboard" heading is visible and rendered with a
 *      serif font family.
 *   4. The page background uses the slate-teal gradient (a gradient
 *      background-image on the login container).
 * Exits with code 1 if any branding element regressed.
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

async function gotoLogin(page: Page): Promise<void> {
  // The app keeps an SSE stream open, so "networkidle" never fires — wait
  // for "load" plus explicit element waits instead. Retry a few times while
  // workflows are still starting up.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await page.goto(`${appBase}/`, { waitUntil: "load" });
      await page
        .getByPlaceholder("admin@sageoak.org")
        .waitFor({ timeout: 20000 });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("login page did not load");
}

async function checkTreeLogo(page: Page): Promise<void> {
  console.log("\nWhite tree logo:");
  const logo = page.getByTestId("img-login-logo");
  try {
    await logo.waitFor({ timeout: 15000 });
  } catch {
    fail('logo element with data-testid="img-login-logo" not found');
    return;
  }

  const src = (await logo.getAttribute("src")) ?? "";
  if (src.includes("sageoak-tree-white.png")) {
    pass(`logo src uses sageoak-tree-white.png ("${src}")`);
  } else {
    fail(`logo src does not reference sageoak-tree-white.png ("${src}")`);
  }

  // Confirm the image actually loaded (asset exists and is not broken).
  const loaded = await logo.evaluate((el) => {
    const img = el as unknown as { complete: boolean; naturalWidth: number };
    return img.complete && img.naturalWidth > 0;
  });
  if (loaded) {
    pass("logo image loaded successfully (non-zero natural size)");
  } else {
    fail("logo image failed to load (broken image / missing asset)");
  }
}

async function checkWordmark(page: Page): Promise<void> {
  console.log("\nWordmark:");
  for (const text of ["Sage Oak", "Charter Schools"]) {
    // .first(): "Sage Oak" also appears in the logo's alt text.
    const el = page.getByText(text, { exact: true }).first();
    if (await el.isVisible().catch(() => false)) {
      pass(`"${text}" wordmark line is visible`);
    } else {
      fail(`"${text}" wordmark line is not visible`);
    }
  }
}

async function checkSerifHeading(page: Page): Promise<void> {
  console.log("\nHeading:");
  const heading = page.getByRole("heading", { name: "Operations Dashboard" });
  if (!(await heading.isVisible().catch(() => false))) {
    fail('"Operations Dashboard" heading is not visible');
    return;
  }
  pass('"Operations Dashboard" heading is visible');

  const fontFamily = await heading.evaluate(
    (el) => getComputedStyle(el).fontFamily,
  );
  // The heading uses Tailwind's font-serif; assert the computed stack is a
  // serif stack (mentions "serif" but is not a sans-serif/mono stack).
  const lower = fontFamily.toLowerCase();
  if (/(^|[^-])serif/.test(lower.replace(/sans-serif/g, ""))) {
    pass(`heading uses a serif font family ("${fontFamily}")`);
  } else {
    fail(`heading font family is not serif ("${fontFamily}")`);
  }
}

async function checkGradientBackground(page: Page): Promise<void> {
  console.log("\nBackground:");
  const backgroundImage = await page
    .getByTestId("img-login-logo")
    .evaluate((el) => {
      // Walk up from the logo to the full-page login container and read its
      // computed background-image.
      let node: (typeof el)["parentElement"] = el;
      while (node) {
        const bg = getComputedStyle(node).backgroundImage;
        if (bg && bg !== "none") return bg;
        node = node.parentElement;
      }
      return "none";
    });
  if (backgroundImage.includes("linear-gradient")) {
    pass("login container has a gradient background");
  } else {
    fail(
      `no gradient background found on the login container (background-image: "${backgroundImage}")`,
    );
  }
}

async function main() {
  console.log(`Login branding check against ${appBase}`);

  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    await gotoLogin(page);
    await checkTreeLogo(page);
    await checkWordmark(page);
    await checkSerifHeading(page);
    await checkGradientBackground(page);
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\nLOGIN BRANDING CHECK FAILED: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nLogin branding check passed: SageStride branding intact.");
}

main().catch((err) => {
  console.error(`LOGIN BRANDING CHECK ERRORED: ${err.message}`);
  process.exit(1);
});
