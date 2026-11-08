// Final build step: applies migrations on Vercel production builds only. Preview builds must never touch the
// production DB (the Neon integration is set to Production only, so they have no DATABASE_URL) and local builds
// must keep working. A failed migration exits non-zero, which fails the build.
import { spawnSync } from "node:child_process";

const { VERCEL, VERCEL_ENV, DATABASE_URL_UNPOOLED } = process.env;
// With the toggle off, VERCEL and VERCEL_ENV are both unset. Neon is Production only, so DATABASE_URL_UNPOOLED means prod.
if ((VERCEL || DATABASE_URL_UNPOOLED) && !VERCEL_ENV) {
  console.error("migrate-on-deploy: VERCEL_ENV is not set although this looks like a Vercel build. Turn on 'Enable access to System Environment Variables' in the Vercel project settings.");
  process.exit(1);
}
if (VERCEL_ENV !== "production") {
  console.log(`migrate-on-deploy: skipped (VERCEL_ENV=${VERCEL_ENV ?? "unset"})`);
  process.exit(0);
}
// Prefer the direct (non-PgBouncer) URL; only this script does, so a plain `DATABASE_URL=x npm run db:migrate` stays on x.
const env = DATABASE_URL_UNPOOLED ? { ...process.env, DATABASE_URL: DATABASE_URL_UNPOOLED } : process.env;
const result = spawnSync("npm", ["run", "db:migrate"], { stdio: "inherit", env });
if (result.status !== 0) {
  console.error("migrate-on-deploy: migration failed, failing the build");
  process.exit(result.status ?? 1);
}
