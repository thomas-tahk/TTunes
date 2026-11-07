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
  await db.query("drop table if exists play_history, queue, station_state, songs, schema_migrations cascade");
  expect(await migrate(db)).toEqual(["001_init.sql"]);
  expect(await migrate(db)).toEqual([]);
  expect((await db.query("select count(*)::int as n from songs")).rows[0].n).toBe(0);
  expect(await seedSongs(db)).toBeGreaterThan(0);
  await db.end();
});
