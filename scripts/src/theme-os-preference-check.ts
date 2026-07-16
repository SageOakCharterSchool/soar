/**
 * Browser-level OS theme preference check. Verifies that the dashboard
 * follows the device's dark/light preference on first visit and that a
 * stored manual choice always wins:
 *   - first visit with a dark OS preference renders dark
 *   - first visit with a light OS preference renders light
 *   - stored "light" overrides a dark OS preference
 *   - stored "dark" overrides a light OS preference
 * Each scenario is checked both immediately after load (pre-paint script in
 * index.html) and after the React app hydrates (useTheme hook), so a
 * regression in either layer fails loudly (exit code 1).
 *
 * Requires the web dashboard workflow to be running.
 * Uses the Nix-provided chromium binary (CHROMIUM_PATH overrides).
 */
import { execSync } from "node:child_process";
import { chromium, type Browser } from "playwright-core";

const appBase =
  process.env.APP_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:80");

const STORAGE_KEY = "sageoak-theme";

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

async function checkScenario(
  browser: Browser,
  opts: {
    label: string;
    colorScheme: "dark" | "light";
    stored: "dark" | "light" | null;
    expectDark: boolean;
  },
) {
  const { label, colorScheme, stored, expectDark } = opts;
  console.log(`\n${label}:`);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    colorScheme,
  });
  try {
    if (stored !== null) {
      await context.addInitScript(
        ([key, value]) => {
          window.localStorage.setItem(key, value);
        },
        [STORAGE_KEY, stored] as const,
      );
    }
    const page = await context.newPage();
    await page.goto(`${appBase}/`, { waitUntil: "domcontentloaded" });

    // Pre-paint script in index.html runs before any React code.
    const preHydration = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    if (preHydration === expectDark) {
      pass(`pre-paint script applied ${expectDark ? "dark" : "light"}`);
    } else {
      fail(
        `pre-paint: html.dark is ${preHydration}, expected ${expectDark}`,
      );
    }

    // Wait for React to hydrate (login form or app shell), then re-check
    // that the useTheme hook agrees with the pre-paint decision.
    await page.waitForFunction(
      () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
      undefined,
      { timeout: 20000 },
    );
    const afterHydration = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    if (afterHydration === expectDark) {
      pass(`after hydration still ${expectDark ? "dark" : "light"}`);
    } else {
      fail(
        `after hydration: html.dark is ${afterHydration}, expected ${expectDark}`,
      );
    }

    // A first visit must not write a theme to localStorage (otherwise later
    // OS preference changes would be ignored).
    const storedAfter = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      STORAGE_KEY,
    );
    if (stored === null) {
      if (storedAfter === null) {
        pass("first visit leaves no stored theme");
      } else {
        fail(
          `first visit unexpectedly stored ${JSON.stringify(storedAfter)}`,
        );
      }
    } else if (storedAfter === stored) {
      pass(`stored choice ${JSON.stringify(stored)} preserved`);
    } else {
      fail(
        `stored theme changed to ${JSON.stringify(storedAfter)}, expected ${JSON.stringify(stored)}`,
      );
    }
  } finally {
    await context.close();
  }
}

async function run() {
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await checkScenario(browser, {
      label: "First visit, OS prefers dark",
      colorScheme: "dark",
      stored: null,
      expectDark: true,
    });
    await checkScenario(browser, {
      label: "First visit, OS prefers light",
      colorScheme: "light",
      stored: null,
      expectDark: false,
    });
    await checkScenario(browser, {
      label: 'Stored "light" overrides dark OS preference',
      colorScheme: "dark",
      stored: "light",
      expectDark: false,
    });
    await checkScenario(browser, {
      label: 'Stored "dark" overrides light OS preference',
      colorScheme: "light",
      stored: "dark",
      expectDark: true,
    });
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll OS theme preference checks passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
