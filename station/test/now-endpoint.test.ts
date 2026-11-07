import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import handler from "../api/now.ts";
import { createDb, migrate, sharedDb } from "../lib/db.ts";

let server: Server;

beforeAll(async () => {
  const db = createDb();
  await migrate(db);
  await db.query("truncate play_history, queue, station_state, songs restart identity cascade");
  await db.query("insert into songs (video_id, title, duration_sec) values ('aaa','A',120), ('bbb','B',120)");
  await db.end();
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
});
afterAll(async () => {
  server.close();
  await sharedDb().end();
});

it("serves JSON that a CDN may cache until the song ends", async () => {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/now`);
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.current.durationSec).toBe(120);
  expect(typeof body.serverNow).toBe("number");
  const match = /s-maxage=(\d+)/.exec(res.headers.get("cache-control") ?? "");
  const remaining = (body.startedAt + 120_000 - body.serverNow) / 1000;
  expect(Number(match![1])).toBeLessThanOrEqual(remaining);
  expect(Number(match![1])).toBeGreaterThan(0);
});
