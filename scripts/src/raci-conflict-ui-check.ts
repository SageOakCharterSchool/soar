/**
 * Browser-level RACI concurrent-edit check: drives two real admin browser
 * sessions against the RACI matrix page and verifies that:
 *   - When admin A edits a cell, admin B's page live-refreshes (SSE) and
 *     shows the new value without any interaction.
 *   - When admin B clicks a stale cell (A changed it while B's refresh was
 *     blocked), B gets the "Cell changed by another admin" conflict toast
 *     instead of silently overwriting.
 *   - After the conflict, both sessions converge on the same value.
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
const MEMBER_NAME = "E2E Conflict Tester";

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
    for (const row of team.rows.filter((r) => r.name === ROW_NAME)) {
      await api(cookie, "DELETE", `/raci/rows/${row.id}`);
    }
    for (const m of team.members.filter((m) => m.name === MEMBER_NAME)) {
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
    category: null,
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
