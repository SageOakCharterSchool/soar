/**
 * Browser check: logs in as admin, opens the Overview page, clicks an
 * additional-resource row, and verifies the full-size usage history dialog
 * opens with the chart (or the single/no-snapshot fallback message).
 *
 * Requires the web dashboard and API server workflows to be running.
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

async function adminCookie(): Promise<string> {
  let res: Response | undefined;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      res = await fetch(`${apiBase}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      if (res.status < 500) break;
    } catch {
      res = undefined;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!res?.ok) throw new Error(`Admin login failed: HTTP ${res?.status ?? "unreachable"}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("No session cookie returned");
  return cookie;
}

async function main() {
  const cookie = await adminCookie();
  const historyRes = await fetch(`${apiBase}/usage/additional-resources/history`, {
    headers: { Cookie: cookie },
  });
  if (!historyRes.ok) throw new Error(`history endpoint HTTP ${historyRes.status}`);
  const history = (await historyRes.json()) as {
    resources: Array<{ link: string; points: unknown[] }>;
  };
  if (history.resources.length === 0) {
    throw new Error("No additional resources in data; cannot exercise the dialog.");
  }
  const target = [...history.resources].sort(
    (a, b) => b.points.length - a.points.length,
  )[0];
  console.log(`Target resource: ${target.link} (${target.points.length} snapshots)`);

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

    const row = page.locator(`[data-testid="resource-row-${target.link}"]`);
    await row.waitFor({ timeout: 15000 });
    pass("resource row is rendered as a clickable control");
    await row.click();

    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 10000 });
    pass("dialog opened on click");

    if (await dialog.getByText(target.link).first().isVisible()) {
      pass("dialog title shows the resource link");
    } else {
      fail("dialog title does not show the resource link");
    }

    if (target.points.length >= 2) {
      const chart = dialog.locator('[data-testid="resource-history-chart"]');
      await chart.waitFor({ timeout: 10000 });
      // amCharts renders into a canvas; verify one exists inside the chart div.
      const canvases = await chart.locator("canvas").count();
      if (canvases > 0) {
        pass(`full-size chart rendered (${canvases} canvas element(s))`);
      } else {
        fail("chart container present but no canvas rendered");
      }
      if (await dialog.getByText("unique users and total opens").isVisible()) {
        pass("dialog describes both metrics");
      } else {
        fail("dialog description missing");
      }
    } else if (target.points.length === 1) {
      if (await dialog.getByText("Only one snapshot so far").isVisible()) {
        pass("single-snapshot fallback shown");
      } else {
        fail("single-snapshot fallback missing");
      }
    }

    // Close via Escape and confirm it goes away.
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 5000 });
    pass("dialog closes with Escape");
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll resource-history dialog checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
