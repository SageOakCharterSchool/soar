/**
 * Browser-level check for the archived-activity CSV export:
 *   - Logs in as admin in a real Chromium browser (playwright-core + Nix chromium)
 *   - Opens Rostering -> "Archived history" dialog
 *   - Clicks "Download CSV" and captures the real blob download
 *   - Verifies the file has the expected header row plus all data rows
 *   - Observes the network requests and verifies snapshot pinning:
 *       page 1 (offset=0) is sent WITHOUT archivedBefore,
 *       page 2+ carries archivedBefore equal to the X-Archive-Snapshot
 *       header the server returned on page 1
 *
 * Seeds ~1500 temporary archive rows (export page size is 1000, so the
 * export spans two pages) via psql, tagged with a sentinel actor name, and
 * deletes them again afterwards. Requires the web dashboard and API server
 * workflows to be running. Development-only.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const appBase =
  process.env.APP_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:80");
const apiBase = `${appBase}/api`;

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@sageoak.org";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "sageoak-admin";

const SEED_ACTOR = "archive-csv-check-seed";
const SEED_COUNT = 1500; // export page size is 1000 -> forces 2 pages

function assertNotProduction() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run archive CSV check with NODE_ENV=production.");
  }
  const host = new URL(appBase).hostname;
  const devHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
  if (process.env.REPLIT_DEV_DOMAIN) devHosts.add(process.env.REPLIT_DEV_DOMAIN);
  if (!devHosts.has(host)) {
    throw new Error(`Refusing to run against non-development host "${host}".`);
  }
}

let failures = 0;
function fail(msg: string) {
  failures++;
  console.error(`  FAIL: ${msg}`);
}
function pass(msg: string) {
  console.log(`  ok: ${msg}`);
}

function psql(sqlText: string): string {
  return execSync(`psql "$DATABASE_URL" -t -A`, {
    shell: "/bin/bash",
    input: sqlText,
  })
    .toString()
    .trim();
}

function seedArchiveRows() {
  // Negative original_id range so seeds can never collide with real rows
  // (real archived rows copy positive activity ids).
  psql(`DELETE FROM app_activity_archive WHERE actor_name = '${SEED_ACTOR}'`);
  psql(
    `INSERT INTO app_activity_archive
       (original_id, app_name, event_type, detail, actor_name, created_at, archived_at)
     SELECT -g,
            'Seed App ' || (g % 7),
            'status_change',
            'seeded archive row ' || g || ' with, comma and "quote"',
            '${SEED_ACTOR}',
            now() - interval '400 days' - (g || ' minutes')::interval,
            now() - interval '1 day'
     FROM generate_series(1, ${SEED_COUNT}) g`,
  );
  const n = psql(
    `SELECT count(*) FROM app_activity_archive WHERE actor_name = '${SEED_ACTOR}'`,
  );
  console.log(`Seeded ${n} archive rows (actor "${SEED_ACTOR}")`);
  if (parseInt(n, 10) !== SEED_COUNT) {
    throw new Error(`Expected ${SEED_COUNT} seeded rows, got ${n}`);
  }
}

function cleanupSeedRows() {
  psql(`DELETE FROM app_activity_archive WHERE actor_name = '${SEED_ACTOR}'`);
  console.log("Deleted seeded archive rows");
}

function chromiumPath(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return execSync("which chromium").toString().trim();
}

// Wait for the API to be up (workflows may still be restarting).
async function waitForApi() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await fetch(`${apiBase}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      if (res.status < 500) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("API server unreachable");
}

interface ObservedRequest {
  offset: number;
  archivedBefore: string | null;
  isCsv: boolean;
  snapshotHeader: string | null;
  status: number;
}

async function run() {
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
    });
    const page = await context.newPage();

    // Record every archive API request/response the browser makes.
    const observed: ObservedRequest[] = [];
    page.on("response", (res) => {
      const url = new URL(res.url());
      if (!url.pathname.endsWith("/rostering/activity/archive")) return;
      void res
        .headerValue("x-archive-snapshot")
        .then((snapshotHeader) => {
          observed.push({
            offset: parseInt(url.searchParams.get("offset") ?? "0", 10),
            archivedBefore: url.searchParams.get("archivedBefore"),
            isCsv: url.searchParams.get("format") === "csv",
            snapshotHeader,
            status: res.status(),
          });
        })
        .catch(() => {});
    });

    // Log in through the real form. The app holds an SSE stream open, so
    // "networkidle" never fires — use "load" + explicit waits.
    await page.goto(`${appBase}/`, { waitUntil: "load" });
    await page.getByPlaceholder("admin@sageoak.org").waitFor({ timeout: 15000 });
    await page.getByPlaceholder("admin@sageoak.org").fill(ADMIN_EMAIL);
    await page.getByPlaceholder("••••••••").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Overview" }).waitFor({ timeout: 15000 });
    console.log(`Logged in as ${ADMIN_EMAIL}`);

    await page.goto(`${appBase}/rostering`, { waitUntil: "load" });
    await page.getByText("Rostering Status Board").waitFor({ timeout: 15000 });

    await page.getByRole("button", { name: "Archived history" }).click();
    await page.getByText("Archived activity history").waitFor({ timeout: 15000 });
    // Wait for the dialog's first page of rows (seeded rows must appear).
    await page.getByText(SEED_ACTOR).first().waitFor({ timeout: 15000 });
    console.log("Archived history dialog open with seeded rows visible");

    console.log("\nCSV download:");
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
    await page.getByRole("button", { name: "Download CSV" }).click();
    const download = await downloadPromise;

    if (download.suggestedFilename() === "activity-archive.csv") {
      pass(`download triggered with filename "${download.suggestedFilename()}"`);
    } else {
      fail(`unexpected download filename "${download.suggestedFilename()}"`);
    }

    const filePath = await download.path();
    if (!filePath) throw new Error("download.path() returned no file path");
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    const expectedHeader = "app,event_type,detail,actor,occurred_at,archived_at";
    if (lines[0] === expectedHeader) {
      pass("header row present exactly once at the top");
    } else {
      fail(`first line is not the expected header: ${JSON.stringify(lines[0])}`);
    }
    const extraHeaders = lines.slice(1).filter((l) => l === expectedHeader).length;
    if (extraHeaders === 0) {
      pass("no duplicated header rows between pages");
    } else {
      fail(`${extraHeaders} duplicate header row(s) found in the body`);
    }
    // CSV records can span lines (quoted newlines) but our seeded rows do
    // not; count records containing the seed actor.
    const seedLines = lines.filter((l) => l.includes(SEED_ACTOR)).length;
    if (seedLines === SEED_COUNT) {
      pass(`all ${SEED_COUNT} seeded data rows present (no duplicates, no gaps)`);
    } else {
      fail(`expected ${SEED_COUNT} seeded rows in the CSV, found ${seedLines}`);
    }
    if (lines.length >= 1 + SEED_COUNT) {
      pass(`file has ${lines.length} lines total (header + data)`);
    } else {
      fail(`file too short: ${lines.length} lines`);
    }

    console.log("\nSnapshot pinning (network requests observed in the browser):");
    // The response listener records entries asynchronously (header reads);
    // wait deterministically until both expected CSV page requests are
    // recorded rather than sleeping a fixed interval.
    const expectedCsvPages = Math.ceil(SEED_COUNT / 1000) + (SEED_COUNT % 1000 === 0 ? 1 : 0);
    for (let i = 0; i < 100 && observed.filter((r) => r.isCsv).length < expectedCsvPages; i++) {
      await page.waitForTimeout(100);
    }
    const csvReqs = observed
      .filter((r) => r.isCsv)
      .sort((a, b) => a.offset - b.offset);
    if (csvReqs.length >= 2) {
      pass(`export made ${csvReqs.length} paged CSV requests`);
    } else {
      fail(`expected >= 2 paged CSV requests, saw ${csvReqs.length}`);
    }
    const first = csvReqs[0];
    if (first && first.offset === 0 && first.archivedBefore === null) {
      pass("page 1 (offset=0) sent without archivedBefore");
    } else if (first) {
      fail(
        `page 1 unexpected: offset=${first.offset}, archivedBefore=${first.archivedBefore}`,
      );
    }
    if (first?.snapshotHeader) {
      pass(`server returned X-Archive-Snapshot on page 1 (${first.snapshotHeader})`);
    } else {
      fail("no X-Archive-Snapshot header observed on page 1");
    }
    for (const req of csvReqs.slice(1)) {
      if (req.archivedBefore && req.archivedBefore === first?.snapshotHeader) {
        pass(
          `page at offset=${req.offset} pinned with archivedBefore=${req.archivedBefore}`,
        );
      } else {
        fail(
          `page at offset=${req.offset} not pinned to page-1 snapshot ` +
            `(archivedBefore=${req.archivedBefore}, expected ${first?.snapshotHeader})`,
        );
      }
      if (req.status !== 200) fail(`page at offset=${req.offset} returned ${req.status}`);
    }
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\nARCHIVE CSV CHECK FAILED: ${failures} check(s) failed.`);
    return false;
  }
  console.log("\nArchive CSV check passed: download works end to end with snapshot pinning.");
  return true;
}

async function main() {
  assertNotProduction();
  console.log(`Archive CSV check against ${appBase}`);
  await waitForApi();
  seedArchiveRows();
  let passed = false;
  try {
    passed = await run();
  } finally {
    cleanupSeedRows();
  }
  if (!passed) process.exit(1);
}

main().catch((err) => {
  console.error(`ARCHIVE CSV CHECK ERRORED: ${err.message}`);
  cleanupSeedRows();
  process.exit(1);
});
