/**
 * UI check: verifies invalid entries in the Issues page "flag open issues
 * after N days" input can never silently change the saved threshold.
 *
 * Flow (for each invalid value "0", "400", and blank):
 *   1. Type the value into the inline threshold input and press Enter.
 *   2. "0" / "400": the destructive "Invalid threshold" toast must appear.
 *      Blank: no toast is expected (the input just reverts).
 *   3. The input must revert to the original threshold.
 *   4. GET /api/settings must still return the original threshold.
 */
import { execSync } from "node:child_process";
import { chromium, type Page } from "playwright-core";

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

  const settingsRes = await fetch(`${apiBase}/settings`, { headers: hdrs });
  if (!settingsRes.ok)
    throw new Error(`GET /settings failed: ${settingsRes.status}`);
  const originalThreshold = ((await settingsRes.json()) as { staleOpenDays: number })
    .staleOpenDays;
  console.log(`Original threshold: ${originalThreshold} days`);

  const serverThreshold = async (): Promise<number> => {
    const res = await fetch(`${apiBase}/settings`, { headers: hdrs });
    if (!res.ok) throw new Error(`GET /settings failed: ${res.status}`);
    return ((await res.json()) as { staleOpenDays: number }).staleOpenDays;
  };

  try {
    await runBrowserChecks();
  } finally {
    // Belt-and-braces restore: the check should never change the value, but
    // if something went wrong, put the original back.
    const restored = await fetch(`${apiBase}/settings`, {
      method: "PUT",
      headers: hdrs,
      body: JSON.stringify({ staleOpenDays: originalThreshold }),
    });
    if (restored.ok) console.log(`Restored threshold to ${originalThreshold} days`);
    else fail(`failed to restore threshold: ${restored.status}`);
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
      const thresholdInput = page.getByLabel(
        "Days before an open issue is flagged as open too long",
      );
      await thresholdInput.waitFor({ timeout: 15000 });
      if ((await thresholdInput.inputValue()) === String(originalThreshold))
        pass(`threshold input shows current value (${originalThreshold})`);
      else
        fail(
          `threshold input shows "${await thresholdInput.inputValue()}", expected ${originalThreshold}`,
        );

      const invalidToast = page.getByText("Invalid threshold").first();

      const waitForNoInvalidToast = async () => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          if ((await page.getByText("Invalid threshold").count()) === 0) return;
          await page.waitForTimeout(250);
        }
        throw new Error("Invalid threshold toast never dismissed");
      };

      const submitInvalid = async (
        raw: string,
        label: string,
        expectToast: boolean,
      ) => {
        // Ensure no leftover toast from a previous step can be mistaken for
        // this step's toast (toasts auto-dismiss after a few seconds).
        await waitForNoInvalidToast();

        await thresholdInput.fill(raw);
        await thresholdInput.press("Enter");

        if (expectToast) {
          try {
            await invalidToast.waitFor({ state: "visible", timeout: 15000 });
            pass(`${label}: destructive "Invalid threshold" toast shown`);
          } catch {
            fail(`${label}: "Invalid threshold" toast did not appear`);
          }
        } else {
          await page.waitForTimeout(2000);
          if ((await page.getByText("Invalid threshold").count()) === 0)
            pass(`${label}: no toast (input silently reverts as designed)`);
          else fail(`${label}: unexpected "Invalid threshold" toast for blank input`);
        }

        // No success toast must ever appear for an invalid entry.
        if ((await page.getByText("Threshold updated").count()) > 0)
          fail(`${label}: unexpected "Threshold updated" success toast`);

        const shown = await thresholdInput.inputValue();
        if (shown === String(originalThreshold))
          pass(`${label}: input reverted to ${originalThreshold}`);
        else fail(`${label}: input shows "${shown}", expected ${originalThreshold}`);

        const persisted = await serverThreshold();
        if (persisted === originalThreshold)
          pass(`${label}: server still returns ${originalThreshold}`);
        else
          fail(`${label}: server threshold is ${persisted}, expected ${originalThreshold}`);
      };

      await submitInvalid("0", 'value "0"', true);
      await submitInvalid("400", 'value "400"', true);
      await submitInvalid("", "blank value", false);
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
