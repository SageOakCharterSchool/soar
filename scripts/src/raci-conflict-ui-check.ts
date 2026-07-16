/**
 * Browser-level RACI concurrent-edit check: drives two real admin browser
 * sessions against the RACI matrix page and verifies that:
 *   - When admin A edits a cell, admin B's page live-refreshes (SSE) and
 *     shows the new value without any interaction.
 *   - When admin B clicks a stale cell (A changed it while B's refresh was
 *     blocked), B gets the "Cell changed by another admin" conflict toast
 *     instead of silently overwriting.
 *   - After the conflict, both sessions converge on the same value.
 *   - When admin B has a stale "Rename task" dialog open (A renamed the same
 *     task first), B's save gets the "Changed by another admin" toast instead
 *     of overwriting A's rename, and both pages converge on A's name.
 *   - The same stale-rename conflict flow is verified for member renames and
 *     category renames (dialog closes, conflict toast, convergence on A's name).
 * Exits with code 1 (fails loudly) on any mismatch.
 *
 * Creates a temporary task row + member in the first RACI team and deletes
 * them afterwards, so no real matrix data is touched.
 *
 * Requires the web dashboard and API server workflows to be running.
 * Uses the Nix-provided chromium binary (CHROMIUM_PATH overrides).
 */
import { execSync } from "node:child_process";
import { chromium, type BrowserContext, type Page } from "playwright-core";

const appBase =
  process.env.APP_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "http://localhost:80");
const apiBase = `${appBase}/api`;

// Refuse to run against anything that isn't the local dev environment.
// This check mutates RACI data (a temporary row/member); never run in prod.
function assertNotProduction() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run RACI conflict UI check with NODE_ENV=production.",
    );
  }
  const host = new URL(appBase).hostname;
  const devHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);
  if (process.env.REPLIT_DEV_DOMAIN) devHosts.add(process.env.REPLIT_DEV_DOMAIN);
  if (!devHosts.has(host)) {
    throw new Error(
      `Refusing to run RACI conflict UI check against non-development host "${host}".`,
    );
  }
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@sageoak.org";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "sageoak-admin";
const ROW_NAME = "E2E Conflict Check Task";
const ROW_NAME_A = "E2E Conflict Check Task (renamed by A)";
const ROW_NAME_B = "E2E Conflict Check Task (renamed by B)";
const MEMBER_NAME = "E2E Conflict Tester";
const MEMBER_NAME_A = "E2E Conflict Tester (renamed by A)";
const MEMBER_NAME_B = "E2E Conflict Tester (renamed by B)";
const CATEGORY_NAME = "E2E Conflict Category";
const CATEGORY_NAME_A = "E2E Conflict Category (renamed by A)";
const CATEGORY_NAME_B = "E2E Conflict Category (renamed by B)";
const ROW_NAMES = [ROW_NAME, ROW_NAME_A, ROW_NAME_B];
const MEMBER_NAMES = [MEMBER_NAME, MEMBER_NAME_A, MEMBER_NAME_B];

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

async function adminLoginCookie(): Promise<string> {
  // Retry on 5xx / network errors while the API server starts up.
  let loginRes: Response | undefined;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      loginRes = await fetch(`${apiBase}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      if (loginRes.status < 500) break;
    } catch {
      loginRes = undefined;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!loginRes?.ok) {
    throw new Error(`Admin login failed: HTTP ${loginRes?.status ?? "unreachable"}`);
  }
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("No admin session cookie returned");
  return cookie;
}

async function api(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${apiBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface Fixture {
  teamId: number;
  rowId: number;
  memberId: number;
}

async function cleanupLeftovers(cookie: string): Promise<void> {
  // Remove any row/member left behind by a previous interrupted run.
  const res = await api(cookie, "GET", "/raci");
  if (!res.ok) return;
  const { teams } = (await res.json()) as {
    teams: Array<{
      id: number;
      rows: Array<{ id: number; name: string }>;
      members: Array<{ id: number; name: string }>;
    }>;
  };
  for (const team of teams) {
    for (const row of team.rows.filter((r) => ROW_NAMES.includes(r.name))) {
      await api(cookie, "DELETE", `/raci/rows/${row.id}`);
    }
    for (const m of team.members.filter((m) => MEMBER_NAMES.includes(m.name))) {
      await api(cookie, "DELETE", `/raci/members/${m.id}`);
    }
  }
}

async function createFixture(cookie: string): Promise<Fixture> {
  await cleanupLeftovers(cookie);
  const matrixRes = await api(cookie, "GET", "/raci");
  if (!matrixRes.ok) throw new Error(`GET /raci failed: HTTP ${matrixRes.status}`);
  const { teams } = (await matrixRes.json()) as { teams: Array<{ id: number }> };
  if (teams.length === 0) throw new Error("No RACI teams exist; cannot run check");
  const teamId = teams[0].id;

  const rowRes = await api(cookie, "POST", "/raci/rows", {
    teamId,
    name: ROW_NAME,
    // A dedicated category so the category-rename conflict flow has a
    // category header to work with (deleted along with the row).
    category: CATEGORY_NAME,
  });
  if (!rowRes.ok) throw new Error(`Could not create test row: HTTP ${rowRes.status}`);
  const row = (await rowRes.json()) as { id: number };

  const memberRes = await api(cookie, "POST", "/raci/members", {
    teamId,
    name: MEMBER_NAME,
  });
  if (!memberRes.ok) {
    throw new Error(`Could not create test member: HTTP ${memberRes.status}`);
  }
  const member = (await memberRes.json()) as { id: number };
  console.log(
    `Created test fixture: row ${row.id} ("${ROW_NAME}") and member ${member.id} ("${MEMBER_NAME}") in team ${teamId}`,
  );
  return { teamId, rowId: row.id, memberId: member.id };
}

async function deleteFixture(cookie: string, fixture: Fixture): Promise<void> {
  const rowDel = await api(cookie, "DELETE", `/raci/rows/${fixture.rowId}`);
  const memberDel = await api(cookie, "DELETE", `/raci/members/${fixture.memberId}`);
  if (rowDel.ok && memberDel.ok) {
    console.log("Deleted test row and member");
  } else {
    console.error(
      `WARNING: fixture cleanup incomplete (row HTTP ${rowDel.status}, member HTTP ${memberDel.status})`,
    );
  }
}

// The cell button's aria-label is "<member> on <row>: <value|blank>", so a
// prefix locator finds the cell regardless of its current value.
const CELL_LABEL_PREFIX = `${MEMBER_NAME} on ${ROW_NAME}:`;
function cellButton(page: Page) {
  return page.locator(`button[aria-label^="${CELL_LABEL_PREFIX}"]`);
}

async function cellValue(page: Page): Promise<string> {
  const label = await cellButton(page).getAttribute("aria-label");
  return label?.slice(CELL_LABEL_PREFIX.length).trim() ?? "<missing>";
}

async function waitForCellValue(
  page: Page,
  value: string,
  timeout: number,
): Promise<boolean> {
  return page
    .locator(`button[aria-label="${CELL_LABEL_PREFIX} ${value}"]`)
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);
}

async function loginAndOpenRaci(context: BrowserContext, who: string): Promise<Page> {
  const page = await context.newPage();
  // The app keeps a server-sent events stream open for live updates, so
  // "networkidle" never fires — wait for "load" plus explicit element waits.
  await page.goto(`${appBase}/`, { waitUntil: "load" });
  await page.getByPlaceholder("admin@sageoak.org").waitFor({ timeout: 15000 });
  await page.getByPlaceholder("admin@sageoak.org").fill(ADMIN_EMAIL);
  await page.getByPlaceholder("••••••••").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Overview" }).waitFor({ timeout: 15000 });
  await page.goto(`${appBase}/raci`, { waitUntil: "load" });
  await cellButton(page).waitFor({ timeout: 15000 });
  console.log(`Admin ${who}: logged in, RACI matrix loaded, test cell visible`);
  return page;
}

async function runChecks(fixture: Fixture) {
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    // Two fully independent sessions (separate cookies), like two admins.
    const contextA = await browser.newContext({ ignoreHTTPSErrors: true });
    const contextB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await loginAndOpenRaci(contextA, "A");
    const pageB = await loginAndOpenRaci(contextB, "B");

    console.log("\nStep 1: admin A edits the cell; B must live-refresh:");
    // Clicking cycles blank -> R.
    await cellButton(pageA).click();
    if (await waitForCellValue(pageA, "R", 15000)) {
      pass("A's cell shows R after A's click");
    } else {
      fail(`A's cell did not update to R (shows "${await cellValue(pageA)}")`);
    }
    if (await waitForCellValue(pageB, "R", 15000)) {
      pass("B's page live-refreshed to R without any interaction (SSE)");
    } else {
      fail(
        `B's page did NOT live-refresh to R (shows "${await cellValue(pageB)}") — SSE refresh broken?`,
      );
    }

    console.log("\nStep 2: B goes stale (refresh delayed) while A edits again:");
    // Hold B's matrix refetches in-flight so B keeps rendering the stale
    // value R, exactly like an admin whose page hasn't caught up yet. The
    // held requests are released later so B's refresh then completes.
    const isMatrixGet = (url: URL) => url.pathname.endsWith("/api/raci");
    let holdMatrix = true;
    const heldRoutes: Array<() => void> = [];
    await contextB.route(
      (url) => isMatrixGet(url),
      (route) => {
        if (holdMatrix && route.request().method() === "GET") {
          heldRoutes.push(() => void route.continue());
        } else {
          void route.continue();
        }
      },
    );
    const releaseHeldRoutes = () => {
      holdMatrix = false;
      for (const release of heldRoutes.splice(0)) release();
    };
    // A cycles R -> A.
    await cellButton(pageA).click();
    if (await waitForCellValue(pageA, "A", 15000)) {
      pass("A's cell shows A after A's second click");
    } else {
      fail(`A's cell did not update to A (shows "${await cellValue(pageA)}")`);
    }
    // Give the SSE event a moment to reach B (its refetch will fail silently).
    await pageB.waitForTimeout(1500);
    const staleValue = await cellValue(pageB);
    if (staleValue === "R") {
      pass("B still shows the stale value R (refresh blocked)");
    } else {
      fail(`B was expected to be stale at R but shows "${staleValue}"`);
    }

    console.log("\nStep 3: B's stale click must get the conflict toast:");
    await cellButton(pageB).click();
    const gotToast = await pageB
      .getByText("Cell changed by another admin")
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (gotToast) {
      pass(`B got the "Cell changed by another admin" toast`);
    } else {
      fail("B did NOT get the conflict toast after clicking a stale cell");
    }
    // The toast must also say what the cell's current value is (A set it to
    // "A" while B was stale), so B knows whether a retry is still needed.
    const gotDetail = await pageB
      .getByText('It is now "A"')
      .first()
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (gotDetail) {
      pass(`B's conflict toast shows the current value ("A")`);
    } else {
      fail("B's conflict toast did NOT show the cell's current value");
    }

    console.log("\nStep 4: both sessions must converge on the same value:");
    // Release B's held refresh requests; the conflict handler invalidated
    // the matrix query, so B's refetch now completes with the server value A.
    releaseHeldRoutes();
    if (await waitForCellValue(pageB, "A", 30000)) {
      pass("B refreshed and shows the server value A");
    } else {
      fail(`B did not converge to A (shows "${await cellValue(pageB)}")`);
    }
    const finalA = await cellValue(pageA);
    const finalB = await cellValue(pageB);
    if (finalA === finalB) {
      pass(`A and B both show "${finalA}"`);
    } else {
      fail(`sessions diverged: A shows "${finalA}", B shows "${finalB}"`);
    }
    if (finalA !== "A") {
      fail(`final value should be A (A's last accepted edit), got "${finalA}"`);
    }

    // ---- Rename conflict flow ----
    const renameButton = (page: Page, rowName: string) =>
      page.locator(`button[aria-label="Rename ${rowName}"]`);
    const dialogInput = (page: Page) =>
      page.getByRole("dialog").getByRole("textbox");
    const dialogSave = (page: Page) =>
      page.getByRole("dialog").getByRole("button", { name: /^Save/ });

    console.log(
      "\nStep 5: B opens the rename dialog, then A renames the same task:",
    );
    await renameButton(pageB, ROW_NAME).click();
    await dialogInput(pageB).waitFor({ timeout: 15000 });
    pass("B's rename dialog is open (holding the original name)");

    await renameButton(pageA, ROW_NAME).click();
    await dialogInput(pageA).waitFor({ timeout: 15000 });
    await dialogInput(pageA).fill(ROW_NAME_A);
    await dialogSave(pageA).click();
    const aRenamed = await pageA
      .locator(`button[aria-label="Rename ${ROW_NAME_A}"]`)
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (aRenamed) {
      pass(`A renamed the task to "${ROW_NAME_A}"`);
    } else {
      fail("A's rename did not take effect");
    }

    console.log("\nStep 6: B saves the stale rename and must get a conflict:");
    await dialogInput(pageB).fill(ROW_NAME_B);
    await dialogSave(pageB).click();
    const gotRenameToast = await pageB
      .getByText("Changed by another admin")
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (gotRenameToast) {
      pass(`B got the "Changed by another admin" toast`);
    } else {
      fail("B did NOT get the rename conflict toast after a stale rename");
    }
    const toastNamesCurrent = await pageB
      .getByText(`It is now called "${ROW_NAME_A}"`)
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (toastNamesCurrent) {
      pass(`the conflict toast names the current name "${ROW_NAME_A}"`);
    } else {
      fail(
        `the conflict toast did not include the current name "${ROW_NAME_A}"`,
      );
    }
    const dialogClosed = await pageB
      .getByRole("dialog")
      .waitFor({ state: "hidden", timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (dialogClosed) {
      pass("B's rename dialog closed after the conflict");
    } else {
      fail("B's rename dialog stayed open after the conflict");
    }

    console.log("\nStep 7: both sessions must converge on A's name:");
    const waitForRow = (page: Page, name: string) =>
      page
        .locator(`button[aria-label="Rename ${name}"]`)
        .waitFor({ timeout: 30000 })
        .then(() => true)
        .catch(() => false);
    if (await waitForRow(pageB, ROW_NAME_A)) {
      pass(`B refreshed and shows A's name "${ROW_NAME_A}"`);
    } else {
      fail(`B did not converge to "${ROW_NAME_A}"`);
    }
    if (await waitForRow(pageA, ROW_NAME_A)) {
      pass(`A still shows "${ROW_NAME_A}" (B's stale rename was rejected)`);
    } else {
      fail(`A no longer shows "${ROW_NAME_A}" — B's stale rename overwrote it?`);
    }
    const bHasStaleName = await pageB
      .locator(`button[aria-label="Rename ${ROW_NAME_B}"]`)
      .count();
    if (bHasStaleName === 0) {
      pass("B's rejected name is nowhere in the matrix");
    } else {
      fail(`B's stale rename "${ROW_NAME_B}" ended up in the matrix`);
    }

    // ---- Member and category rename conflict flows ----
    // Toasts stay on screen a long time, so earlier "Changed by another
    // admin" toasts may still be visible. Wait for a NEW toast by comparing
    // against the count taken just before the stale save.
    const toastCount = (page: Page) =>
      page.getByText("Changed by another admin").count();
    const waitForNewToast = async (page: Page, before: number) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if ((await toastCount(page)) > before) return true;
        await page.waitForTimeout(250);
      }
      return false;
    };
    const dialogHidden = (page: Page) =>
      page
        .getByRole("dialog")
        .waitFor({ state: "hidden", timeout: 15000 })
        .then(() => true)
        .catch(() => false);

    // The member-name header button uses title="Rename member"; the category
    // header button uses title="Rename category". Filter by exact text.
    const memberButton = (page: Page, name: string) =>
      page
        .locator('button[title="Rename member"]')
        .filter({ hasText: name })
        .first();
    const categoryButton = (page: Page, name: string) =>
      page
        .locator('button[title="Rename category"]')
        .filter({ hasText: name })
        .first();
    const waitForButton = (locator: ReturnType<typeof memberButton>) =>
      locator
        .waitFor({ timeout: 30000 })
        .then(() => true)
        .catch(() => false);

    console.log(
      "\nStep 8: B opens the member rename dialog, then A renames the same member:",
    );
    await memberButton(pageB, MEMBER_NAME).click();
    await dialogInput(pageB).waitFor({ timeout: 15000 });
    pass("B's member rename dialog is open (holding the original name)");

    await memberButton(pageA, MEMBER_NAME).click();
    await dialogInput(pageA).waitFor({ timeout: 15000 });
    await dialogInput(pageA).fill(MEMBER_NAME_A);
    await dialogSave(pageA).click();
    if (await waitForButton(memberButton(pageA, MEMBER_NAME_A))) {
      pass(`A renamed the member to "${MEMBER_NAME_A}"`);
    } else {
      fail("A's member rename did not take effect");
    }

    console.log("\nStep 9: B saves the stale member rename and must get a conflict:");
    const memberToastsBefore = await toastCount(pageB);
    await dialogInput(pageB).fill(MEMBER_NAME_B);
    await dialogSave(pageB).click();
    if (await waitForNewToast(pageB, memberToastsBefore)) {
      pass(`B got the "Changed by another admin" toast for the member rename`);
    } else {
      fail("B did NOT get the conflict toast after a stale member rename");
    }
    if (await dialogHidden(pageB)) {
      pass("B's member rename dialog closed after the conflict");
    } else {
      fail("B's member rename dialog stayed open after the conflict");
    }

    console.log("\nStep 10: both sessions must converge on A's member name:");
    if (await waitForButton(memberButton(pageB, MEMBER_NAME_A))) {
      pass(`B refreshed and shows A's member name "${MEMBER_NAME_A}"`);
    } else {
      fail(`B did not converge to member name "${MEMBER_NAME_A}"`);
    }
    if (await waitForButton(memberButton(pageA, MEMBER_NAME_A))) {
      pass(`A still shows "${MEMBER_NAME_A}" (B's stale member rename was rejected)`);
    } else {
      fail(
        `A no longer shows "${MEMBER_NAME_A}" — B's stale member rename overwrote it?`,
      );
    }
    if (
      (await pageB
        .locator('button[title="Rename member"]')
        .filter({ hasText: MEMBER_NAME_B })
        .count()) === 0
    ) {
      pass("B's rejected member name is nowhere in the matrix");
    } else {
      fail(`B's stale member rename "${MEMBER_NAME_B}" ended up in the matrix`);
    }

    console.log(
      "\nStep 11: B opens the category rename dialog, then A renames the same category:",
    );
    await categoryButton(pageB, CATEGORY_NAME).click();
    await dialogInput(pageB).waitFor({ timeout: 15000 });
    pass("B's category rename dialog is open (holding the original name)");

    await categoryButton(pageA, CATEGORY_NAME).click();
    await dialogInput(pageA).waitFor({ timeout: 15000 });
    await dialogInput(pageA).fill(CATEGORY_NAME_A);
    await dialogSave(pageA).click();
    if (await waitForButton(categoryButton(pageA, CATEGORY_NAME_A))) {
      pass(`A renamed the category to "${CATEGORY_NAME_A}"`);
    } else {
      fail("A's category rename did not take effect");
    }

    console.log(
      "\nStep 12: B saves the stale category rename and must get a conflict:",
    );
    const categoryToastsBefore = await toastCount(pageB);
    await dialogInput(pageB).fill(CATEGORY_NAME_B);
    await dialogSave(pageB).click();
    if (await waitForNewToast(pageB, categoryToastsBefore)) {
      pass(`B got the "Changed by another admin" toast for the category rename`);
    } else {
      fail("B did NOT get the conflict toast after a stale category rename");
    }
    const categoryToastNamesCurrent = await pageB
      .getByText(`It is now called "${CATEGORY_NAME_A}"`)
      .first()
      .waitFor({ timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (categoryToastNamesCurrent) {
      pass(
        `the category conflict toast names the current name "${CATEGORY_NAME_A}"`,
      );
    } else {
      fail(
        `the category conflict toast did not include the current name "${CATEGORY_NAME_A}"`,
      );
    }
    if (await dialogHidden(pageB)) {
      pass("B's category rename dialog closed after the conflict");
    } else {
      fail("B's category rename dialog stayed open after the conflict");
    }

    console.log("\nStep 13: both sessions must converge on A's category name:");
    if (await waitForButton(categoryButton(pageB, CATEGORY_NAME_A))) {
      pass(`B refreshed and shows A's category name "${CATEGORY_NAME_A}"`);
    } else {
      fail(`B did not converge to category name "${CATEGORY_NAME_A}"`);
    }
    if (await waitForButton(categoryButton(pageA, CATEGORY_NAME_A))) {
      pass(
        `A still shows "${CATEGORY_NAME_A}" (B's stale category rename was rejected)`,
      );
    } else {
      fail(
        `A no longer shows "${CATEGORY_NAME_A}" — B's stale category rename overwrote it?`,
      );
    }
    if (
      (await pageB
        .locator('button[title="Rename category"]')
        .filter({ hasText: CATEGORY_NAME_B })
        .count()) === 0
    ) {
      pass("B's rejected category name is nowhere in the matrix");
    } else {
      fail(`B's stale category rename "${CATEGORY_NAME_B}" ended up in the matrix`);
    }
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(
      `\nRACI CONFLICT UI CHECK FAILED: ${failures} problem(s) in the two-admin edit flow.`,
    );
    return false;
  }
  console.log(
    "\nRACI conflict UI check passed: live refresh, conflict toast, and convergence all verified.",
  );
  return true;
}

async function main() {
  assertNotProduction();
  console.log(`RACI conflict UI check against ${appBase}`);

  const cookie = await adminLoginCookie();
  const fixture = await createFixture(cookie);
  let passed = false;
  try {
    passed = await runChecks(fixture);
  } finally {
    // Always remove the temporary row/member, even if checks failed.
    await deleteFixture(cookie, fixture);
  }
  if (!passed) process.exit(1);
}

main().catch((err) => {
  console.error(`RACI CONFLICT UI CHECK ERRORED: ${err.message}`);
  process.exit(1);
});
