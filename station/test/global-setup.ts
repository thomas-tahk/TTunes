import { randomBytes } from "node:crypto";
import pg from "pg";

// Each test run gets its own database, so parallel worktrees sharing one Postgres never collide.
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://ttunes:ttunes@localhost:55432/postgres";

export default async function setup(): Promise<() => Promise<void>> {
  const name = `ttunes_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  return async () => {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  };
}
