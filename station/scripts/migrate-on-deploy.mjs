// Build step: applies migrations on Vercel production builds only. Preview builds have no DB and
// local builds must keep working. A failed migration exits non-zero, which fails the build.
import { spawnSync } from "node:child_process";

if (process.env.VERCEL_ENV !== "production") {
  console.log(`migrate-on-deploy: skipped (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"})`);
  process.exit(0);
}
const result = spawnSync("npm", ["run", "db:migrate"], { stdio: "inherit" }); // db:migrate prefers DATABASE_URL_UNPOOLED
if (result.status !== 0) {
  console.error("migrate-on-deploy: migration failed, failing the build");
  process.exit(result.status ?? 1);
}
