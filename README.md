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

The server refuses to start in production without `SESSION_SECRET`, and will not seed an admin without `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

## Deploying to Railway

1. Create a new Railway project and add a **PostgreSQL** database. Railway exposes `DATABASE_URL` automatically.
2. Add a service from this repository.
3. Set environment variables on the service: `SESSION_SECRET` (long random string), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `NODE_ENV=production`. Reference the database's `DATABASE_URL`.
4. Build command:
   ```bash
   corepack enable && pnpm install && pnpm run build
   ```
5. Pre-deploy (or one-off) command to apply the schema:
   ```bash
   pnpm --filter @workspace/db run push
   ```
6. Start command:
   ```bash
   node artifacts/api-server/dist/index.mjs
   ```
   The server binds to `PORT` and serves both the API and the built web app. On boot it creates the session table and seeds the admin user and the four school terms if missing.

## Embedding in another site (iframe)

The app sends no frame-blocking headers, so it can be embedded anywhere:

```html
<iframe
  src="https://YOUR-APP.up.railway.app/"
  style="width: 100%; height: 900px; border: 0;"
  title="Sage Oak App Dashboard"
></iframe>
```

## Monthly data upload routine

1. In Clever, export the "last 28 days" analytics CSVs (all 12 files).
2. Log in as an admin and go to **Upload Data**.
3. Drop in all 12 files. `ExportProperties.csv` is required — it provides the `Export_date` that keys the snapshot.
4. Review the import result: rows inserted/updated and any warnings (e.g. corrected values for previously-seen dates, or files missing from the batch).

Upload rules:

- Daily usage tables upsert by date — re-uploading overlapping windows corrects values and extends history; old dates are never deleted.
- Snapshot tables (by app, by school, device/browser/login mix, engagement, etc.) upsert by export date, so each monthly upload adds a new snapshot.
- New applications appearing in uploads are automatically added to the Rostering Status Board for the current term with "not started" statuses.
