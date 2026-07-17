/**
 * Permanent UI check: the RACI team and Rostering term selections are
 * remembered across a page refresh (localStorage keys `sageoak-raci-team` /
 * `sageoak-rostering-term`), and a stale stored id falls back to the default
 * without breaking the page. Also checks the RACI task search box
 * (`sageoak-raci-search`): typed text and the filtered rows survive a
 * refresh, a garbage stored value doesn't break the page, and the
 * "No tasks match your search." empty state offers a one-click
 * "Clear search" button that empties the box and the stored value.
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
const fail = (m: string) => {
  failures++;
  console.error(`  FAIL: ${m}`);
};
const pass = (m: string) => console.log(`  ok: ${m}`);

/**
 * The selected team/term button uses the filled (default) variant which has
 * aria-pressed-like styling via bg-primary; others are outlined.
 */
async function selectedButtonText(page: Page, container: string) {
  return page
    .locator(`${container} button.bg-primary, ${container} button[class*="bg-primary"]`)
    .first()
    .innerText();
}

async function checkPage(
  page: Page,
  opts: {
    label: string;
    path: string;
    storageKey: string;
  },
) {
  const { label, path, storageKey } = opts;
  console.log(`\n${label}:`);

  await page.goto(`${appBase}${path}`, { waitUntil: "load" });
  const buttons = page.locator("div.flex.flex-wrap.gap-1\\.5 > button");
  await buttons.first().waitFor({ timeout: 15000 });
  const count = await buttons.count();
  if (count < 2) {
    console.log(`  skip: only ${count} option(s), need 2 to test selection`);
    return;
  }

  // Click the second (non-default) option and confirm it is remembered.
  const secondText = (await buttons.nth(1).innerText()).trim();
  await buttons.nth(1).click();
  await page.waitForTimeout(300);
  const stored = await page.evaluate(
    (k: string) => localStorage.getItem(k),
    storageKey,
  );
  if (stored != null) pass(`selection stored in localStorage (${storageKey}=${stored})`);
  else fail(`nothing stored under ${storageKey} after selecting`);

  await page.reload({ waitUntil: "load" });
  await buttons.first().waitFor({ timeout: 15000 });
  const selectedAfter = (
    await selectedButtonText(page, "div.flex.flex-wrap.gap-1\\.5")
  ).trim();
  if (selectedAfter === secondText)
    pass(`selection "${secondText}" restored after refresh`);
  else
    fail(
      `expected "${secondText}" selected after refresh, got "${selectedAfter}"`,
    );

  // A stale stored id (deleted team/term) must fall back to a default
  // without breaking the page.
  await page.evaluate(
    (k: string) => localStorage.setItem(k, "999999"),
    storageKey,
  );
  await page.reload({ waitUntil: "load" });
  await buttons.first().waitFor({ timeout: 15000 });
  const fallback = (
    await selectedButtonText(page, "div.flex.flex-wrap.gap-1\\.5")
  ).trim();
  if (fallback.length > 0) pass(`stale stored id falls back to "${fallback}"`);
  else fail("no selection after a stale stored id");
}

const SEARCH_KEY = "sageoak-raci-search";
const SEARCH_PLACEHOLDER = "Search tasks, categories, or people...";

/** Count real data rows, excluding the in-table empty-state row. */
async function dataRowCount(page: Page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    return rows.filter((r) => !/No tasks/i.test(r.textContent ?? "")).length;
  });
}

async function checkRaciSearch(page: Page) {
  console.log("\nRACI search persistence:");

  // Start from a clean slate so a leftover stored search doesn't skew counts.
  await page.goto(`${appBase}/raci`, { waitUntil: "load" });
  await page.evaluate((k: string) => localStorage.removeItem(k), SEARCH_KEY);
  await page.reload({ waitUntil: "load" });

  const searchBox = page.getByPlaceholder(SEARCH_PLACEHOLDER);
  await searchBox.waitFor({ timeout: 15000 });
  await page.locator("tbody tr").first().waitFor({ timeout: 15000 });
  const totalRows = await dataRowCount(page);
  if (totalRows === 0) {
    console.log("  skip: no RACI rows to filter");
    return;
  }

  // Search for the first member's name (people are searchable), which
  // matches a subset of rows without depending on task naming.
  const term = (
    await page.locator("thead th").nth(1).innerText()
  ).trim().split(/\s+/)[0];
  if (!term) {
    fail("could not derive a search term from the member header");
    return;
  }

  await searchBox.fill(term);
  await page.waitForTimeout(400);
  const stored = await page.evaluate(
    (k: string) => localStorage.getItem(k),
    SEARCH_KEY,
  );
  if (stored === term) pass(`search term stored (${SEARCH_KEY}=${stored})`);
  else fail(`expected ${SEARCH_KEY}="${term}" in localStorage, got "${stored}"`);

  const filteredBefore = await dataRowCount(page);
  if (filteredBefore <= totalRows)
    pass(`search filters rows (${filteredBefore}/${totalRows} shown)`);
  else fail(`filtered count ${filteredBefore} exceeds total ${totalRows}`);

  await page.reload({ waitUntil: "load" });
  await searchBox.waitFor({ timeout: 15000 });
  const restored = await searchBox.inputValue();
  if (restored === term) pass(`search text "${term}" restored after refresh`);
  else fail(`expected search "${term}" after refresh, got "${restored}"`);

  await page.locator("tbody tr").first().waitFor({ timeout: 15000 });
  const filteredAfter = await dataRowCount(page);
  if (filteredAfter === filteredBefore)
    pass(`filtered rows restored after refresh (${filteredAfter})`);
  else
    fail(
      `expected ${filteredBefore} filtered row(s) after refresh, got ${filteredAfter}`,
    );

  // A garbage stored value (quotes, angle brackets, unicode) must not break
  // the page: the search box and table still render, showing either matching
  // rows or the search empty state.
  const garbage = `"><script>ζ${"x".repeat(200)}`;
  await page.evaluate(
    ([k, v]: string[]) => localStorage.setItem(k, v),
    [SEARCH_KEY, garbage],
  );
  await page.reload({ waitUntil: "load" });
  await searchBox.waitFor({ timeout: 15000 });
  const garbageValue = await searchBox.inputValue();
  if (garbageValue === garbage)
    pass("garbage stored value shows up in the search box without crashing");
  else fail("search box did not reflect the garbage stored value");
  await page.locator("tbody tr").first().waitFor({ timeout: 15000 });
  const rowsWithGarbage = await dataRowCount(page);
  const emptyStateVisible = await page
    .getByText("No tasks match your search.")
    .first()
    .isVisible()
    .catch(() => false);
  if (rowsWithGarbage > 0 || emptyStateVisible)
    pass("page still renders with a garbage stored search");
  else fail("neither rows nor the search empty state rendered with garbage value");

  // Clean up so later runs (and admins on this browser) start fresh.
  await page.evaluate((k: string) => localStorage.removeItem(k), SEARCH_KEY);
}

/**
 * The search is shared across teams: switching teams with a remembered
 * search must keep the filter applied to the new team's rows, and a search
 * matching nothing must show "No tasks match your search." rather than
 * looking like the team has no data.
 */
async function checkRaciSearchAcrossTeams(page: Page) {
  console.log("\nRACI search across team switches:");

  await page.goto(`${appBase}/raci`, { waitUntil: "load" });
  await page.evaluate((k: string) => localStorage.removeItem(k), SEARCH_KEY);
  await page.reload({ waitUntil: "load" });

  const teamButtons = page.locator("div.flex.flex-wrap.gap-1\\.5 > button");
  await teamButtons.first().waitFor({ timeout: 15000 });
  const teamCount = await teamButtons.count();
  if (teamCount < 2) {
    console.log(`  skip: only ${teamCount} team(s), need 2 to test switching`);
    return;
  }

  const searchBox = page.getByPlaceholder(SEARCH_PLACEHOLDER);
  await searchBox.waitFor({ timeout: 15000 });

  // Start on the first team and store a search that matches nothing anywhere.
  await teamButtons.nth(0).click();
  await page.locator("tbody tr").first().waitFor({ timeout: 15000 });
  const noMatch = "zz-no-match-xq7";
  await searchBox.fill(noMatch);
  await page.waitForTimeout(400);

  const noMatchState = page.getByText("No tasks match your search.").first();
  if (await noMatchState.isVisible().catch(() => false))
    pass("no-match search shows the search empty state on the first team");
  else fail("no-match search did not show the search empty state on the first team");

  // Switch teams: the remembered search must carry over ...
  await teamButtons.nth(1).click();
  await page.waitForTimeout(400);
  const carried = await searchBox.inputValue();
  if (carried === noMatch)
    pass(`search "${noMatch}" carried over to the second team`);
  else fail(`expected search "${noMatch}" on the second team, got "${carried}"`);

  // ... and stay applied: no data rows, and the empty state must say the
  // search matched nothing (not that the team has no tasks).
  const rowsOnSecond = await dataRowCount(page);
  const searchEmptyVisible = await noMatchState.isVisible().catch(() => false);
  const noTasksYetVisible = await page
    .getByText("No tasks yet for this team.")
    .first()
    .isVisible()
    .catch(() => false);
  if (rowsOnSecond === 0 && searchEmptyVisible && !noTasksYetVisible)
    pass('second team shows "No tasks match your search." with the filter applied');
  else
    fail(
      `expected search empty state on second team (rows=${rowsOnSecond}, ` +
        `searchEmpty=${searchEmptyVisible}, noTasksYet=${noTasksYetVisible})`,
    );

  // The search empty state offers a one-click "Clear search" button; it must
  // empty the box, remove the stored value, and reveal the second team's
  // real state (rows, or the genuine "no tasks yet" empty state) — proving
  // the filter, not missing data, hid the rows.
  const clearButton = page.getByRole("button", { name: "Clear search" });
  if (await clearButton.isVisible().catch(() => false))
    pass('empty state shows a "Clear search" button');
  else fail('no "Clear search" button in the search empty state');
  await clearButton.click();
  await page.waitForTimeout(400);
  const clearedValue = await searchBox.inputValue();
  if (clearedValue === "") pass('"Clear search" emptied the search box');
  else fail(`expected empty search box after "Clear search", got "${clearedValue}"`);
  const storedAfterClear = await page.evaluate(
    (k: string) => localStorage.getItem(k),
    SEARCH_KEY,
  );
  if (storedAfterClear == null)
    pass(`"Clear search" removed the stored value (${SEARCH_KEY})`);
  else
    fail(`expected ${SEARCH_KEY} removed after "Clear search", got "${storedAfterClear}"`);
  const rowsCleared = await dataRowCount(page);
  const noTasksYetAfterClear = await page
    .getByText("No tasks yet for this team.")
    .first()
    .isVisible()
    .catch(() => false);
  if (rowsCleared > 0 || noTasksYetAfterClear)
    pass(
      rowsCleared > 0
        ? `clearing the search reveals the second team's rows (${rowsCleared})`
        : "clearing the search reveals the second team's genuine empty state",
    );
  else fail("clearing the search revealed neither rows nor the no-tasks empty state");

  // A remembered search should also survive a reload while on the switched
  // team and still filter that team's rows.
  if (rowsCleared > 0) {
    const memberTerm = (
      await page.locator("thead th").nth(1).innerText()
    ).trim().split(/\s+/)[0];
    if (memberTerm) {
      await searchBox.fill(memberTerm);
      await page.waitForTimeout(400);
      const filtered = await dataRowCount(page);
      await page.reload({ waitUntil: "load" });
      await searchBox.waitFor({ timeout: 15000 });
      const restoredTerm = await searchBox.inputValue();
      await page.locator("tbody tr").first().waitFor({ timeout: 15000 });
      const filteredAfterReload = await dataRowCount(page);
      if (restoredTerm === memberTerm && filteredAfterReload === filtered)
        pass(
          `reload on the switched team keeps search "${memberTerm}" and its ${filtered} filtered row(s)`,
        );
      else
        fail(
          `after reload on switched team expected search "${memberTerm}" with ${filtered} row(s), ` +
            `got "${restoredTerm}" with ${filteredAfterReload}`,
        );
    }
  }

  // Clean up so later runs (and admins on this browser) start fresh.
  await page.evaluate((k: string) => localStorage.removeItem(k), SEARCH_KEY);
}

async function main() {
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

    await checkPage(page, {
      label: "RACI team selection",
      path: "/raci",
      storageKey: "sageoak-raci-team",
    });
    await checkPage(page, {
      label: "Rostering term selection",
      path: "/rostering",
      storageKey: "sageoak-rostering-term",
    });
    await checkRaciSearch(page);
    await checkRaciSearchAcrossTeams(page);
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll stored-filter checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
