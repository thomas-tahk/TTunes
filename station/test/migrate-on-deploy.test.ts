import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const run = (env: Record<string, string | undefined>) =>
  spawnSync("node", ["scripts/migrate-on-deploy.mjs"], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, encoding: "utf8" });

it.each([{ VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, {}])("skips cleanly off production: %j", (env) => {
  const result = run(env);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("skipped");
});

it("on production, a failing migration fails the build", () => {
  const result = run({ VERCEL_ENV: "production", DATABASE_URL_UNPOOLED: "postgres://nobody:x@127.0.0.1:1/none" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("failing the build");
});

it("on production, migrations run against DATABASE_URL_UNPOOLED, not the pooled URL", () => {
  const result = run({ VERCEL_ENV: "production", DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/none", DATABASE_URL_UNPOOLED: process.env.DATABASE_URL! });
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/Applied|up to date/);
});
