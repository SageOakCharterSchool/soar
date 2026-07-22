/**
 * End-to-end check: a usage upload that creates a new application whose name
 * matches an unlinked RACI row must relink the row and render its chip on the
 * Rostering board. Guards against app-list re-imports orphaning
 * raci_rows.application_id (which made board chips silently vanish).
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

// Unique per run so parallel history/other data can't collide.
const APP_NAME = `Reimport Chip Check ${Date.now()}`;
// Old date so the snapshot never becomes the dashboard's "latest".
const SNAPSHOT_DATE = "2019-01-01";

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.error(`  FAIL: ${m}`);
};
const pass = (m: string) => console.log(`  ok: ${m}`);

function sql(query: string): string {
  return execSync(`psql "$DATABASE_URL" -t -A -F '|' -c "${query.replace(/\n/g, " ")}"`)
    .toString()
    .trim();
}

async function main() {
  // --- Seed an unlinked RACI row with an R assignment ---
  const memberOut = sql(
    "SELECT m.id, m.name, m.team_id FROM raci_members m JOIN raci_teams t ON t.id = m.team_id LIMIT 1",
  );
  if (!memberOut) throw new Error("No RACI members found to seed an assignment");
  const [memberIdStr, memberName, teamIdStr] = memberOut.split("|") as [string, string, string];

  // psql prints the returned row followed by the "INSERT 0 1" command tag;
  // keep only the first line.
  const rowIdStr = sql(
    `INSERT INTO raci_rows (team_id, name, application_id) VALUES (${teamIdStr}, '${APP_NAME}', NULL) RETURNING id`,
  ).split("\n")[0]!.trim();
  sql(
    `INSERT INTO raci_assignments (row_id, member_id, value) VALUES (${rowIdStr}, ${memberIdStr}, 'R')`,
  );
  console.log(`Seeded unlinked RACI row #${rowIdStr} ("${APP_NAME}", R: ${memberName})`);

  const cleanup = () => {
    try {
      sql(`DELETE FROM raci_rows WHERE id = ${rowIdStr}`);
      sql(`DELETE FROM app_activity WHERE application_id IN (SELECT id FROM applications WHERE name = '${APP_NAME}')`);
      sql(`DELETE FROM app_term_status WHERE application_id IN (SELECT id FROM applications WHERE name = '${APP_NAME}')`);
      sql(`DELETE FROM applications WHERE name = '${APP_NAME}'`);
      sql(`DELETE FROM usage_applist WHERE app_name = '${APP_NAME}'`);
      sql(`DELETE FROM import_log WHERE snapshot_date = '${SNAPSHOT_DATE}' AND files_included::text LIKE '%raci-reimport-chip-check%'`);
    } catch (e) {
      console.error("cleanup failed:", e);
    }
  };

  try {
    // --- Upload a usage batch containing an app with the matching name ---
    const loginRes = await fetch(`${apiBase}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (!loginRes.ok) throw new Error(`Admin login failed: ${loginRes.status}`);
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

    const uploadRes = await fetch(`${apiBase}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        files: [
          {
            name: "ExportProperties_raci-reimport-chip-check.csv",
            content: `Property,Value\nExport_date,${SNAPSHOT_DATE}\n`,
          },
          {
            name: "AppList_raci-reimport-chip-check.csv",
            content: `App Name,Student Count,% of Students,Teacher Count,% of Teachers\n${APP_NAME},5,1,2,1\n`,
          },
        ],
      }),
    });
    if (!uploadRes.ok) {
      throw new Error(`Upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
    }
    pass("usage upload accepted");

    // --- Verify the importer relinked the RACI row to the new application ---
    const linked = sql(
      `SELECT rr.application_id, a.name FROM raci_rows rr JOIN applications a ON a.id = rr.application_id WHERE rr.id = ${rowIdStr}`,
    );
    if (!linked) {
      fail("RACI row is still unlinked after the upload (relink did not run)");
      return;
    }
    const [appIdStr, linkedName] = linked.split("|") as [string, string];
    if (linkedName === APP_NAME) pass(`RACI row relinked to application #${appIdStr}`);
    else fail(`RACI row linked to unexpected application "${linkedName}"`);

    // --- Verify the chip renders on the Rostering board ---
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

      await page.goto(`${appBase}/rostering`, { waitUntil: "load" });
      const search = page.getByPlaceholder("Search apps, category, owner...");
      await search.waitFor({ timeout: 15000 });
      await search.fill(APP_NAME);

      // The name also shows up in the recent-activity feed; scope to the table.
      const appCell = page.getByRole("table").getByText(APP_NAME, { exact: true });
      await appCell.waitFor({ timeout: 15000 });
      pass("new application appears on the Rostering board");

      const chip = page
        .locator("tr", { hasText: APP_NAME })
        .locator("button[title*='RACI matrix']")
        .first();
      await chip.waitFor({ timeout: 15000 });
      const chipText = ((await chip.innerText()) ?? "").trim();
      if (chipText.startsWith("R") && chipText.includes(memberName)) {
        pass(`chip renders with role and member name ("${chipText}")`);
      } else {
        fail(`expected chip text "R · ${memberName}", got "${chipText}"`);
      }

      await chip.click();
      await page.waitForURL(new RegExp(`/raci\\?app=${appIdStr}$`), { timeout: 15000 });
      pass(`chip navigates to /raci?app=${appIdStr}`);
      await page.locator("tr[data-highlighted]").first().waitFor({ timeout: 15000 });
      pass("linked RACI row is highlighted on the RACI page");
    } finally {
      await browser.close();
    }
  } finally {
    cleanup();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll RACI re-import chip checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
