/**
 * Browser-level Google SSO login-page check: drives a real Chromium browser
 * via Playwright against the running dashboard and verifies the login page's
 * Google sign-in behavior:
 *   1. With SSO unconfigured (no GOOGLE_CLIENT_ID/SECRET on the running API
 *      server), the "Sign in with Google" button is hidden.
 *   2. A second API server instance is booted with dummy
 *      GOOGLE_CLIENT_ID/SECRET; its /api/auth/config reports googleEnabled
 *      and /api/auth/google issues a 302 to accounts.google.com.
 *   3. With the browser's /api/auth/config and /api/auth/google requests
 *      proxied to that configured instance, the button is visible and
 *      clicking it navigates the page to accounts.google.com.
 *   4. Visiting /?ssoError=wrong_domain shows the "use your Sage Oak
 *      account" toast and scrubs ssoError from the URL.
 * Exits with code 1 if any behavior regressed.
 *
 * Requires the web dashboard and API server workflows to be running.
 * Uses the Nix-provided chromium binary (CHROMIUM_PATH overrides).
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

const appBase =
  process.env.APP_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:80");
const apiBase = `${appBase}/api`;

// Port for the temporary SSO-configured API server instance.
const SSO_API_PORT = Number(process.env.SSO_CHECK_PORT ?? 4873);
const ssoApiBase = `http://127.0.0.1:${SSO_API_PORT}/api`;

const GOOGLE_BUTTON = "Sign in with Google";
const WRONG_DOMAIN_TOAST = "use your Sage Oak account";

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

// Retry on 5xx / network errors while workflows are still starting up.
async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let res: Response | undefined;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      res = await fetch(url, init);
      if (res.status < 500) return res;
    } catch {
      res = undefined;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!res) throw new Error(`Unreachable: ${url}`);
  return res;
}

/**
 * Boot a second API server instance from the built bundle with dummy Google
 * credentials so the "SSO configured" behavior can be exercised without real
 * secrets. It shares the dev database but listens on a private port.
 */
function startConfiguredApiServer(): ChildProcess {
  const serverDir = path.resolve(import.meta.dirname, "../../artifacts/api-server");
  if (!existsSync(path.join(serverDir, "dist/index.mjs"))) {
    console.log("Building api-server bundle (dist/index.mjs missing)...");
    execSync("pnpm run build", { cwd: serverDir, stdio: "inherit" });
  }
  const child = spawn("node", ["--enable-source-maps", "./dist/index.mjs"], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(SSO_API_PORT),
      GOOGLE_CLIENT_ID: "sso-check-dummy-client-id",
      GOOGLE_CLIENT_SECRET: "sso-check-dummy-client-secret",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return child;
}

async function waitForSsoApi(): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      const res = await fetch(`${ssoApiBase}/auth/config`);
      if (res.ok) return;
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("SSO-configured API server did not become ready");
}

async function gotoLogin(page: Page, url: string): Promise<void> {
  // The app keeps an SSE stream open, so "networkidle" never fires — wait
  // for "load" plus explicit element waits instead.
  await page.goto(url, { waitUntil: "load" });
  await page.getByPlaceholder("admin@sageoak.org").waitFor({ timeout: 20000 });
}

async function checkUnconfiguredState(page: Page): Promise<void> {
  console.log("\nSSO unconfigured (real dev API server):");
  const configRes = await fetchWithRetry(`${apiBase}/auth/config`);
  const config = (await configRes.json()) as { googleEnabled?: boolean };
  if (config.googleEnabled === false) {
    pass("/api/auth/config reports googleEnabled: false");
  } else {
    fail(
      `expected googleEnabled: false from the dev API server, got ${JSON.stringify(config)} — is GOOGLE_CLIENT_ID set in dev?`,
    );
  }

  await gotoLogin(page, `${appBase}/`);
  // Give the config query a moment to resolve, then assert the button never
  // appeared.
  await page.waitForTimeout(2000);
  if ((await page.getByRole("button", { name: GOOGLE_BUTTON }).count()) === 0) {
    pass("Google button is hidden when SSO is unconfigured");
  } else {
    fail("Google button is visible even though SSO is unconfigured");
  }
}

async function checkConfiguredServer(): Promise<void> {
  console.log("\nSSO configured (dummy-credential API server):");
  const configRes = await fetchWithRetry(`${ssoApiBase}/auth/config`);
  const config = (await configRes.json()) as { googleEnabled?: boolean };
  if (config.googleEnabled === true) {
    pass("/api/auth/config reports googleEnabled: true with credentials set");
  } else {
    fail(`configured server returned ${JSON.stringify(config)}`);
  }

  const authRes = await fetch(`${ssoApiBase}/auth/google`, {
    redirect: "manual",
  });
  const location = authRes.headers.get("location") ?? "";
  if (
    authRes.status === 302 &&
    location.startsWith("https://accounts.google.com/")
  ) {
    pass("/api/auth/google redirects to accounts.google.com");
  } else {
    fail(
      `/api/auth/google returned ${authRes.status} with Location "${location}"`,
    );
  }
}

async function checkConfiguredButtonFlow(page: Page): Promise<void> {
  console.log("\nLogin page with SSO enabled (API proxied to configured server):");

  // Proxy the auth endpoints to the dummy-configured instance so the real
  // frontend sees googleEnabled: true and a real server-issued redirect.
  await page.route("**/api/auth/config", async (route) => {
    const res = await fetch(`${ssoApiBase}/auth/config`);
    await route.fulfill({
      status: res.status,
      contentType: "application/json",
      body: await res.text(),
    });
  });
  // Chromium cannot intercept the follow-up request of a fulfilled redirect,
  // so instead of replaying the 302 we capture the real server-issued
  // Location header and serve a stub page for the click's navigation.
  let clickRedirectLocation: string | null = null;
  await page.route("**/api/auth/google", async (route) => {
    const res = await fetch(`${ssoApiBase}/auth/google`, { redirect: "manual" });
    clickRedirectLocation = res.headers.get("location");
    await route.fulfill({
      contentType: "text/html",
      body: "<title>sso-check stub</title>",
    });
  });

  await gotoLogin(page, `${appBase}/`);
  const button = page.getByRole("button", { name: GOOGLE_BUTTON });
  try {
    await button.waitFor({ timeout: 15000 });
    pass("Google button is visible when googleEnabled is true");
  } catch {
    fail("Google button did not appear even though googleEnabled is true");
    return;
  }

  await button.click();
  try {
    await page.waitForURL(/\/api\/auth\/google$/, { timeout: 15000 });
    pass("clicking the button navigates the page to /api/auth/google");
  } catch {
    fail(`clicking the button did not navigate to /api/auth/google (at ${page.url()})`);
  }
  // TS can't see the assignment inside the route callback above.
  const redirectLocation = clickRedirectLocation as string | null;
  if (redirectLocation?.startsWith("https://accounts.google.com/")) {
    pass("the server redirects that navigation to accounts.google.com");
  } else {
    fail(
      `the click's /api/auth/google request was not redirected to accounts.google.com (Location: "${clickRedirectLocation}")`,
    );
  }

  await page.unroute("**/api/auth/config");
  await page.unroute("**/api/auth/google");
}

async function checkSsoErrorToast(page: Page): Promise<void> {
  console.log("\nssoError toast:");
  await gotoLogin(page, `${appBase}/?ssoError=wrong_domain`);
  try {
    // .first(): Radix mirrors the toast text into a hidden aria-live
    // announcement, so the text matches more than one element.
    await page.getByText(WRONG_DOMAIN_TOAST).first().waitFor({ timeout: 15000 });
    pass(`"${WRONG_DOMAIN_TOAST}" toast shown for ssoError=wrong_domain`);
  } catch {
    fail(`toast containing "${WRONG_DOMAIN_TOAST}" did not appear`);
  }
  if (!page.url().includes("ssoError")) {
    pass("ssoError parameter is scrubbed from the URL");
  } else {
    fail(`ssoError still present in URL: ${page.url()}`);
  }
}

async function main() {
  console.log(`Google SSO UI check against ${appBase}`);

  const ssoServer = startConfiguredApiServer();
  let browser;
  try {
    await waitForSsoApi();

    browser = await chromium.launch({
      executablePath: chromiumPath(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    await checkUnconfiguredState(page);
    await checkConfiguredServer();
    await checkConfiguredButtonFlow(page);
    await checkSsoErrorToast(page);
  } finally {
    await browser?.close();
    ssoServer.kill("SIGTERM");
  }

  if (failures > 0) {
    console.error(`\nGOOGLE SSO UI CHECK FAILED: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nGoogle SSO UI check passed: login page SSO behavior intact.");
}

main().catch((err) => {
  console.error(`GOOGLE SSO UI CHECK ERRORED: ${err.message}`);
  process.exit(1);
});
