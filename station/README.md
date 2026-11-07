# TTunes station (M2)

The hosted station: one shared schedule everyone listens to in sync. Vite + React front end, Vercel Functions in `api/`, Postgres via `pg` (Neon in production). The owner signs in with GitHub to add songs, skip, reorder and trash.

## Environment variables (names only)

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres URL the app uses (Neon pooled URL in production) |
| `DATABASE_URL_UNPOOLED` | Direct Postgres URL; the production build runs migrations through it |
| `YOUTUBE_API_KEY` | YouTube Data API |
| `GITHUB_CLIENT_ID` | GitHub OAuth app |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app |
| `SESSION_SECRET` | Signs session cookies, at least 32 bytes |
| `CRON_SECRET` | Bearer secret for the daily cron route |

Neon's Vercel integration provides both database URLs. Never commit values.

## Local development

```
npm ci
npm run db:up        # Docker Postgres on port 55432
npm run db:migrate   # applies migrations/*.sql once each
npm run dev
```

Without `DATABASE_URL` the app uses `postgres://ttunes:ttunes@localhost:55432/ttunes_station`. `npm run db:seed` loads sample songs; local only, never on production.

## Migrations

`npm run db:migrate` applies numbered files in `migrations/` in order, once each, in one transaction guarded by `pg_advisory_xact_lock`, so concurrent runs are safe and it works through PgBouncer. It uses `DATABASE_URL`.
The Vercel build runs it as its **last** step, after `vite build`, only when `VERCEL_ENV=production` (`scripts/migrate-on-deploy.mjs`, which points it at `DATABASE_URL_UNPOOLED` when set). A failed migration fails the build. Preview and local builds skip it; if `VERCEL` is set without `VERCEL_ENV` the build fails (turn on "Automatically expose System Environment Variables").

**Rule: every migration must be additive or otherwise safe for the code that is currently live.** The old deployment keeps serving on the new schema until the new one is promoted, and Instant Rollback puts old code on the new schema later. Drop or rename in a later release, after no live code uses the old shape.

## Tests

```
npm test             # starts Docker Postgres, runs vitest on a throwaway database per run
npm run typecheck
npm run check:build  # vercel build + imports every built function, checks function count
```

Each e2e needs its own throwaway database (macOS has no `timeout`; run them one at a time):

```
docker exec $(docker ps -qf publish=55432) psql -U ttunes -d postgres -qc "create database e2e_x"
DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/e2e_x node test/e2e/addlink.e2e.mjs
docker exec $(docker ps -qf publish=55432) psql -U ttunes -d postgres -qc "drop database e2e_x with (force)"
```

Same for `test/e2e/controls.e2e.mjs` and `npm run e2e` (sync).

## Deploy (Vercel + Neon)

1. Create the Vercel project from this repo with **Root Directory = `station`**.
2. Add Neon through the Vercel integration, in the same region as the functions (**iad1**), and tick **Production only** for its environments. Otherwise Preview deployments would point PR code at the production database. It sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
3. Set `YOUTUBE_API_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `CRON_SECRET`.
4. GitHub OAuth app callback URL: `https://<prod domain>/api/auth/github/callback`.
5. Deploy to production; the build applies migrations. **Never run `db:seed` on production.**
6. After the first deploy, check the cron: Vercel dashboard, Cron Jobs, `/api/cron/refresh` (daily 09:00 UTC); run it once and confirm a 200.
7. Share the production domain, not deployment URLs (those sit behind deployment protection).
