/**
 * One-off, re-runnable data-entry script: seeds RACI rows on the
 * "Software Squad" team for third-party SaaS vendors under a new
 * "SaaS & Third-Party Services" category, via the admin API (so activity
 * logging and sort order stay correct).
 *
 * - A vendor is skipped (case-insensitive, trimmed match) if a row with that
 *   name already exists ANYWHERE on the Software Squad team.
 * - New rows are created with no R/A/C/I assignments.
 * - Pass --dry-run to log what would happen without writing.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run add-saas-vendor-raci-rows -- --dry-run
 *   pnpm --filter @workspace/scripts run add-saas-vendor-raci-rows
 */

export {}; // treat this file as a module so top-level names don't clash across scripts

const base =
  process.env.API_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/api`
    : "http://localhost:3001/api");

// No hardcoded fallbacks: this script writes to the real matrix, so it must
// fail loudly when credentials are not provided via the environment.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error(
    "SAAS VENDOR RACI SEED ERRORED: ADMIN_EMAIL and ADMIN_PASSWORD must be set in the environment (no hardcoded credential fallbacks).",
  );
  process.exit(1);
}
const adminEmail: string = ADMIN_EMAIL;
const adminPassword: string = ADMIN_PASSWORD;

const TEAM_NAME = "Software Squad";
const CATEGORY = "SaaS & Third-Party Services";

const VENDORS = [
  "Clerk",
  "Google Workspace",
  "Mailgun",
  "Resend",
  "Supabase",
  "LocationIQ",
  "Canva",
  "Lovable",
  "Snowflake",
  "Replit",
  "Google Cloud Platform (SageOakCMS)",
  "IncidentIQ",
  "Railway",
  "AWS",
  "WP Engine",
  "GoDaddy",
  "Route53",
  "ClickUp",
  "Apple Developer Program",
  "Google Play Console",
  "Chrome Web Store",
];

const dryRun = process.argv.includes("--dry-run");

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

async function loginOnce(): Promise<Response> {
  return fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
}

async function login(): Promise<string> {
  // Retry on 5xx / network errors: the API server may still be starting up.
  let res: Response | undefined;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      res = await loginOnce();
      if (res.status < 500) break;
    } catch {
      res = undefined;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!res) throw new Error(`Could not reach API server at ${base}`);
  if (!res.ok) throw new Error(`Login failed for ${ADMIN_EMAIL}: HTTP ${res.status}`);
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("No session cookie returned");
  return cookie.split(";")[0];
}

type MatrixRow = { id: number; category: string | null; name: string };
type MatrixTeam = { id: number; name: string; rows: MatrixRow[] };

async function main() {
  console.log(`SaaS vendor RACI seed — API base URL: ${base}`);
  console.log(dryRun ? "Mode: DRY RUN (no writes)" : "Mode: LIVE (rows will be created)");

  const cookie = await login();

  const matrixRes = await fetch(`${base}/raci`, { headers: { Cookie: cookie } });
  if (!matrixRes.ok) throw new Error(`GET /raci failed: HTTP ${matrixRes.status}`);
  const { teams } = (await matrixRes.json()) as { teams: MatrixTeam[] };

  const team = teams.find((t) => t.name === TEAM_NAME);
  if (!team) {
    throw new Error(
      `Team "${TEAM_NAME}" not found. Teams present: ${teams.map((t) => t.name).join(", ")}`,
    );
  }
  console.log(`\nResolved team "${team.name}" (id ${team.id}) with ${team.rows.length} existing row(s).`);

  // Every existing row name on the team, across all categories.
  const existing = new Map<string, MatrixRow>();
  for (const row of team.rows) {
    if (!existing.has(normalize(row.name))) existing.set(normalize(row.name), row);
  }

  const created: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const vendor of VENDORS) {
    const match = existing.get(normalize(vendor));
    if (match) {
      const where = match.category ? `under "${match.category}"` : "(uncategorized)";
      skipped.push({ name: vendor, reason: `already exists as "${match.name}" ${where}` });
      console.log(`  skip:   ${vendor} — already exists as "${match.name}" ${where}`);
      continue;
    }
    if (dryRun) {
      created.push(vendor);
      console.log(`  would create: ${vendor} under "${CATEGORY}"`);
      continue;
    }
    const res = await fetch(`${base}/raci/rows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ teamId: team.id, name: vendor, category: CATEGORY }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Failed to create "${vendor}": HTTP ${res.status} ${body.slice(0, 300)}`);
    }
    const row = (await res.json()) as { id: number };
    created.push(vendor);
    // Guard against duplicates if the same name appears twice in VENDORS.
    existing.set(normalize(vendor), { id: row.id, category: CATEGORY, name: vendor });
    console.log(`  created: ${vendor} (row id ${row.id}) under "${CATEGORY}"`);
  }

  console.log(`\nSummary (${dryRun ? "dry run" : "live"}):`);
  console.log(`  ${dryRun ? "would create" : "created"}: ${created.length}`);
  for (const name of created) console.log(`    + ${name}`);
  console.log(`  skipped: ${skipped.length}`);
  for (const s of skipped) console.log(`    - ${s.name}: ${s.reason}`);
}

main().catch((err) => {
  console.error(`SAAS VENDOR RACI SEED ERRORED: ${(err as Error).message}`);
  process.exit(1);
});
