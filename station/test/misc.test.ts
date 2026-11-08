import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import timeHandler from "../api/time.ts";
import { createDb } from "../lib/db.ts";
import { migrate } from "../lib/migrate.ts";
import { seedSongs } from "../scripts/seed.ts";

it("GET /api/time returns the server clock, uncached", async () => {
  const server = createServer(timeHandler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const before = Date.now();
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/time`);
  server.close();
  const body = await res.json();
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(body.serverNow).toBeGreaterThanOrEqual(before);
});

it("migrate applies each numbered file once; seeding is separate", async () => {
  const db = createDb();
  await db.query("drop table if exists play_history, queue, station_state, songs, auth_state, activity_log, library_exports, trash_queue, requests, request_attempts, search_attempts, preview_attempts, settings, schema_migrations cascade");
  expect(await migrate(db)).toEqual(["001_init.sql", "002_auth.sql", "003_upkeep.sql", "004_queue_position.sql", "005_owner_controls.sql", "006_trash_queue_index.sql", "007_requests.sql", "008_request_attempts.sql", "009_search_attempts.sql", "010_preview_attempts.sql"]);
  expect(await migrate(db)).toEqual([]);
  expect((await db.query("select count(*)::int as n from songs")).rows[0].n).toBe(0);
  expect(await seedSongs(db)).toBeGreaterThan(0);
  await db.end();
});

async function twoRunnersMigrateOnce(viaPooler: string | null): Promise<void> {
  const admin = createDb();
  const name = `ttunes_mig_${Date.now()}`;
  await admin.query(`create database ${name}`);
  const direct = new URL(process.env.DATABASE_URL!);
  direct.pathname = `/${name}`;
  const runnerUrl = new URL(viaPooler ?? direct.toString());
  runnerUrl.pathname = `/${name}`;
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  writeFileSync(join(dir, "001_a.sql"), "create table hits (n int); select pg_sleep(0.5);");
  writeFileSync(join(dir, "002_b.sql"), "insert into hits values (1);");
  const [one, two] = [createDb(runnerUrl.toString()), createDb(runnerUrl.toString())];
  try {
    const results = await Promise.all([migrate(one, dir), migrate(two, dir)]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 2]);
    expect((await one.query("select count(*)::int as n from hits")).rows[0].n).toBe(1);
  } finally {
    await Promise.all([one.end(), two.end()]);
    await admin.query(`drop database ${name} with (force)`);
    await admin.end();
  }
}

it("regression: two concurrent migrate runs apply each file exactly once (direct connection)", () => twoRunnersMigrateOnce(null));

// Needs the optional PgBouncer (transaction mode): `npm run db:bouncer`, then
// BOUNCER_URL=postgres://ttunes:ttunes@localhost:56432/postgres npm test
const BOUNCER_URL = process.env.BOUNCER_URL;
if (!BOUNCER_URL) console.warn("SKIPPED pooled migrate test: BOUNCER_URL not set (run `npm run db:bouncer`, then set BOUNCER_URL)");
it.skipIf(!BOUNCER_URL)("two concurrent migrate runs apply each file exactly once through PgBouncer in transaction mode", () => twoRunnersMigrateOnce(BOUNCER_URL!));
