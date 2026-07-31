/**
 * UI check: verifies the in-dialog rename and delete flow for apps on the
 * Rostering board. Creates a throwaway app via the API, then drives the Edit
 * dialog in a real browser to rename it (checking the "App renamed" toast and
 * board refresh) and delete it via the confirm panel (checking the
 * "App deleted" toast and that the row disappears).
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

const stamp = Date.now();
const APP_NAME = `UI Check Throwaway ${stamp}`;
const RENAMED_NAME = `UI Check Renamed ${stamp}`;

async function main() {
  const loginRes = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`Admin login failed: ${loginRes.status}`);
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

  // Pick the same term a fresh browser session would default to:
  // the current term, else the first by sort order.
  const termsRes = await fetch(`${apiBase}/terms`, { headers: { Cookie: cookie } });
  if (!termsRes.ok) throw new Error(`Fetching terms failed: ${termsRes.status}`);
  const terms = (await termsRes.json()) as {
    id: number;
    label: string;
    sortOrder: number;
    isCurrent: boolean;
  }[];
  if (terms.length === 0) throw new Error("No terms exist to test with");
  const sorted = [...terms].sort((a, b) => a.sortOrder - b.sortOrder);
  const term = sorted.find((t) => t.isCurrent) ?? sorted[0]!;
  console.log(`Using term #${term.id} ("${term.label}")`);

  // Create a throwaway app on that term's board.
  const createRes = await fetch(`${apiBase}/apps`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: APP_NAME, termId: term.id }),
  });
  if (!createRes.ok)
    throw new Error(`Creating throwaway app failed: ${createRes.status}`);
  const created = (await createRes.json()) as { applicationId?: number };
  const appId = created.applicationId;
  if (typeof appId !== "number")
    throw new Error(`Create response had no app id: ${JSON.stringify(created)}`);
  console.log(`Created throwaway app #${appId} ("${APP_NAME}")`);

  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ?? execSync("which chromium").toString().trim(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  let deletedViaUi = false;
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${appBase}/`, { waitUntil: "load" });
    await page.getByPlaceholder("admin@sageoak.org").waitFor({ timeout: 15000 });
    await page.getByPlaceholder("admin@sageoak.org").fill(ADMIN_EMAIL);
    await page.getByPlaceholder("••••••••").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Overview" }).waitFor({ timeout: 15000 });

    await page.goto(`${appBase}/rostering`, { waitUntil: "load" });
    const searchBox = page.getByPlaceholder("Search apps, category, owner...");
    await searchBox.waitFor({ timeout: 15000 });

    // 1) The throwaway app shows up on the board.
    await searchBox.fill(APP_NAME);
    const row = page.getByRole("row").filter({ hasText: APP_NAME }).first();
    await row.waitFor({ timeout: 15000 });
    pass("throwaway app appears on the board");

    // 2) Rename it via the Edit dialog.
    await row.getByRole("button", { name: `Edit ${APP_NAME}` }).click();
    const nameInput = page.getByTestId("input-edit-app-name");
    await nameInput.waitFor({ timeout: 10000 });
    await nameInput.fill(RENAMED_NAME);
    // The rename hint appears once the name differs from the stored one.
    await page
      .getByText("Renaming keeps this app's history", { exact: false })
      .waitFor({ timeout: 5000 });
    pass("rename hint appears when the name is edited");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // Toast text is unique per run, so waiting on it is race-free.
    await page
      .getByText(`Now shown as ${RENAMED_NAME}.`)
      .first()
      .waitFor({ timeout: 15000 });
    pass('"App renamed" toast appears with the new name');

    // Board refreshes: new name present, old name gone.
    await searchBox.fill(RENAMED_NAME);
    const renamedRow = page
      .getByRole("row")
      .filter({ hasText: RENAMED_NAME })
      .first();
    await renamedRow.waitFor({ timeout: 15000 });
    pass("board shows the renamed app");
    await searchBox.fill(APP_NAME);
    await page
      .getByRole("row")
      .filter({ hasText: APP_NAME })
      .first()
      .waitFor({ state: "detached", timeout: 15000 })
      .catch(() => fail("old app name still on the board after rename"));
    if (failures === 0) pass("old app name no longer on the board");

    // 3) Delete it via the confirm panel in the Edit dialog.
    await searchBox.fill(RENAMED_NAME);
    await renamedRow.waitFor({ timeout: 15000 });
    await renamedRow
      .getByRole("button", { name: `Edit ${RENAMED_NAME}` })
      .click();
    await page.getByTestId("button-delete-app").waitFor({ timeout: 10000 });
    await page.getByTestId("button-delete-app").click();
    const confirmPanel = page.getByTestId("confirm-delete-app");
    await confirmPanel.waitFor({ timeout: 10000 });
    if (await confirmPanel.getByText(`Delete ${RENAMED_NAME}?`).isVisible())
      pass("confirm panel names the app being deleted");
    else fail("confirm panel does not name the app");

    // "Keep app" backs out without deleting.
    await confirmPanel.getByRole("button", { name: "Keep app" }).click();
    await confirmPanel.waitFor({ state: "detached", timeout: 5000 });
    pass('"Keep app" dismisses the confirm panel');

    // Now delete for real.
    await page.getByTestId("button-delete-app").click();
    await page.getByTestId("confirm-delete-app").waitFor({ timeout: 10000 });
    await page.getByTestId("button-confirm-delete-app").click();
    await page
      .getByText(`${RENAMED_NAME} was removed`, { exact: false })
      .first()
      .waitFor({ timeout: 15000 });
    pass('"App deleted" toast appears');
    deletedViaUi = true;

    // Row is gone from the board.
    await page
      .getByRole("row")
      .filter({ hasText: RENAMED_NAME })
      .first()
      .waitFor({ state: "detached", timeout: 15000 })
      .catch(() => fail("deleted app still on the board"));
    if (failures === 0) pass("deleted app no longer on the board");
  } finally {
    await browser.close();
    // Safety net: remove the throwaway app if a step failed before deletion.
    if (!deletedViaUi) {
      await fetch(`${apiBase}/apps/${appId}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      }).catch(() => {});
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll app rename/delete checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
