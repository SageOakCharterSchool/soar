# Sage Oak App Dashboard

Internal analytics and rostering operations dashboard for Sage Oak Charter Schools.

- **Usage analytics** — upload the 12 Clever "last 28 days" CSV exports; the app accumulates history over time (daily tables upsert by date, snapshot tables upsert by export date — old dates are never deleted).
- **Rostering Status Board** — per-term tracking of each application's student/staff data-sharing status, sync method, owner and notes, with staff upvotes and issue reporting.

## Stack

- Frontend: React + Vite, amCharts 5, TanStack Query (generated hooks from OpenAPI)
- Backend: Express 5, Drizzle ORM, PostgreSQL
- Auth: local email/password (bcryptjs) with httpOnly cookie sessions (express-session + connect-pg-simple)

## Local development

```bash
pnpm install
pnpm --filter @workspace/db run push        # apply schema to DATABASE_URL
pnpm --filter @workspace/api-server run dev # API
pnpm --filter @workspace/sage-oak-dashboard run dev # web app
```

Dev admin login (used only when `ADMIN_EMAIL`/`ADMIN_PASSWORD` are not set and not in production): `admin@sageoak.org` / `sageoak-admin`.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `PORT` | no | Server port (Railway sets this automatically) |
| `SESSION_SECRET` | prod: yes | Secret for signing session cookies |
| `ADMIN_EMAIL` | prod: yes | Seeded admin account email |
| `ADMIN_PASSWORD` | prod: yes | Seeded admin account password |
| `SFTP_HOST` | no | Clever Reports SFTP host (`reports-sftp.clever.com`) — enables the daily automatic report sync |
| `SFTP_PORT` | no | SFTP port (default `22`) |
| `SFTP_USERNAME` | no | Clever SFTP username |
| `SFTP_PASSWORD` | no | Clever SFTP password |
| `SFTP_REMOTE_DIR` | no | Remote directory to scan for report CSVs (default `/`) |

The server refuses to start in production without `SESSION_SECRET`, and will not seed an admin without `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

## Deploying to Railway

This repo deploys as **one single service** (the API server also serves the built web app). The root `railway.json` already defines the build and start commands, and `package.json` pins `pnpm@10.26.1` — Railway must use pnpm 10, or the install fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.

1. Create a new Railway project and add a **PostgreSQL** database. Railway exposes `DATABASE_URL` automatically.
2. Add **one** service from this repository, with the **root directory left as `/`** (the repo root). If Railway auto-detected the pnpm workspace and created a service per package (`@workspace/db`, `@workspace/api-zod`, etc.), delete those extra services — only the single root service is needed.
3. Set environment variables on the service: `SESSION_SECRET` (long random string), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `NODE_ENV=production`. Reference the database's `DATABASE_URL`.
4. Build and start commands come from `railway.json`:
   - Build: `corepack enable && corepack prepare pnpm@10.26.1 --activate && pnpm install --frozen-lockfile && pnpm run build`
   - Start: `node artifacts/api-server/dist/index.mjs`
5. Deploy. The server binds to `PORT` and serves both the API and the web app at the root URL. On boot it applies the database schema automatically (bundled SQL migrations), then seeds the admin user and the four school terms if missing — no manual schema step is needed. (Optional fallback: `pnpm --filter @workspace/db run push-force` from a one-off shell if you ever need to force-sync the schema manually.)

## Embedding in another site (iframe)

The app sends no frame-blocking headers, so it can be embedded anywhere:

```html
<iframe
  src="https://YOUR-APP.up.railway.app/"
  style="width: 100%; height: 900px; border: 0;"
  title="Sage Oak App Dashboard"
></iframe>
```

## Automatic Clever SFTP report sync

If `SFTP_HOST`, `SFTP_USERNAME`, and `SFTP_PASSWORD` are set (Railway Variables / Replit secrets — never stored in the database), the server connects to Clever's Reports SFTP endpoint on startup and once a day, pulls any reports whose date is not yet in the import log, and imports them through the same pipeline as manual uploads (logged with source `sftp`). Already-imported snapshots are skipped, so the sync is safe to re-run. Admins can also click **Sync now** on the Upload Data page, which shows the last sync time, result, and any error. Manual upload keeps working unchanged.

Two remote layouts are supported (verified against Clever's real server on 2026-07-16):

- **Clever's real daily reports** — `daily-participation/` and `resource-usage/` directories containing raw per-user files named `YYYY-MM-DD-<report>-{students|teachers|staff}.csv`. Each day's files are aggregated (active users, logins, per-app and per-school unique users) into one snapshot keyed by the report date.
- **Aggregated snapshot batches** — directories (or the root) containing `ExportProperties.csv` plus the analytics CSVs, keyed by `Export_date`. This matches the manual-upload format.

## Monthly data upload routine

1. In Clever, export the "last 28 days" analytics CSVs (all 12 files).
2. Log in as an admin and go to **Upload Data**.
3. Drop in all 12 files. `ExportProperties.csv` is required — it provides the `Export_date` that keys the snapshot.
4. Review the import result: rows inserted/updated and any warnings (e.g. corrected values for previously-seen dates, or files missing from the batch).

Upload rules:

- Daily usage tables upsert by date — re-uploading overlapping windows corrects values and extends history; old dates are never deleted.
- Snapshot tables (by app, by school, device/browser/login mix, engagement, etc.) upsert by export date, so each monthly upload adds a new snapshot.
- New applications appearing in uploads are automatically added to the Rostering Status Board for the current term with "not started" statuses.
