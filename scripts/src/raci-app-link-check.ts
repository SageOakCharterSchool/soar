/**
 * Temporary UI check: verifies that an admin can link, change, and clear a
 * RACI row's linked application from the picker on the RACI page, and that
 * the row shows the linked app name (or a "Link app" affordance when none).
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
  const loginRes = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`Admin login failed: ${loginRes.status}`);
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

  // Sanity check the options endpoint before driving the UI.
  const optsRes = await fetch(`${apiBase}/raci/app-options`, {
    headers: { Cookie: cookie },
  });
  if (!optsRes.ok) throw new Error(`app-options failed: ${optsRes.status}`);
  const opts = (await optsRes.json()) as { id: number; name: string }[];
  if (opts.length > 0 && opts.every((o) => typeof o.id === "number" && o.name))
    pass(`app-options returns ${opts.length} applications`);
  else fail("app-options returned no usable applications");

  // Find an unlinked RACI row in the first team, straight from the dev DB.
  const q = `
    SELECT rr.id, rr.name, rr.team_id
    FROM raci_rows rr
    WHERE rr.application_id IS NULL
    ORDER BY rr.team_id, rr.sort_order
    LIMIT 1`;
  const out = execSync(
    `psql "$DATABASE_URL" -t -A -F '|' -c "${q.replace(/\n/g, " ")}"`,
  )
    .toString()
    .trim();
  if (!out) throw new Error("No unlinked RACI row found to test with");
  const [rowIdStr, rowName] = out.split("|") as [string, string];
  const rowId = parseInt(rowIdStr, 10);
  const targetApp = opts[0]!;
  console.log(
    `Using row #${rowId} ("${rowName}"), linking to "${targetApp.name}"`,
  );

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

    await page.goto(`${appBase}/raci`, { waitUntil: "load" });
    // Search narrows the matrix to our row regardless of team pagination.
    const searchBox = page.getByPlaceholder(
      "Search tasks, categories, or people...",
    );
    await searchBox.waitFor({ timeout: 15000 });

    const openRowTeam = async () => {
      // The row may live on a non-default team; click through team buttons
      // until the row is visible.
      await searchBox.fill(rowName);
      const rowCell = page.getByRole("row").filter({ hasText: rowName }).first();
      const teamButtons = page.locator("div.flex.flex-wrap.gap-1\\.5 > button");
      const teamCount = await teamButtons.count();
      for (let i = 0; i < teamCount; i++) {
        if (await rowCell.isVisible().catch(() => false)) return rowCell;
        await teamButtons.nth(i).click();
        await page.waitForTimeout(300);
      }
      await rowCell.waitFor({ timeout: 5000 });
      return rowCell;
    };

    const rowLocator = await openRowTeam();

    // 1) Unlinked row shows the "Link app" affordance.
    const linkBtn = rowLocator.getByRole("button", {
      name: `Link ${rowName} to an app`,
    });
    await linkBtn.waitFor({ timeout: 15000 });
    pass("unlinked row shows a 'Link app' button");

    // 2) Link it to the first application via the dialog.
    await linkBtn.click();
    await page.getByText(`Linked app for "${rowName}"`).waitFor({ timeout: 10000 });
    await page.getByRole("combobox", { name: "Linked application" }).click();
    await page.getByRole("option", { name: targetApp.name, exact: true }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await rowLocator
      .getByRole("button", { name: `Change linked app for ${rowName}` })
      .waitFor({ timeout: 15000 });
    const appLink = rowLocator.getByTitle(
      `Linked to ${targetApp.name} — open the Rostering board`,
    );
    if (await appLink.isVisible()) pass(`row now shows linked app "${targetApp.name}"`);
    else fail("row does not show the linked app name after linking");

    // 3) Clear the link again.
    await rowLocator
      .getByRole("button", { name: `Change linked app for ${rowName}` })
      .click();
    await page.getByText(`Linked app for "${rowName}"`).waitFor({ timeout: 10000 });
    await page.getByRole("combobox", { name: "Linked application" }).click();
    await page.getByRole("option", { name: "None (no linked app)" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await rowLocator
      .getByRole("button", { name: `Link ${rowName} to an app` })
      .waitFor({ timeout: 15000 });
    pass("clearing the link restores the 'Link app' button");
  } finally {
    await browser.close();
    // Safety net: make sure the row ends up unlinked even if a step failed.
    await fetch(`${apiBase}/raci/rows/${rowId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ applicationId: null }),
    }).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll RACI app link checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
