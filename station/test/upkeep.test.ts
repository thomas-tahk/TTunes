import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import refresh from "../api/cron/refresh.ts";
import ownerApi from "../api/owner.ts";
import { issueSession, SESSION_COOKIE } from "../lib/auth.ts";
import { createDb, sharedDb } from "../lib/db.ts";
import { migrate } from "../lib/migrate.ts";
import { KEEP_EXPORTS, purgeTrash } from "../lib/upkeep.ts";
import { getNowPlaying } from "../lib/schedule.ts";
import { parseIsoDuration } from "../lib/youtube.ts";

let server: Server;
let base: string;
const realFetch = globalThis.fetch;
const youtubeCalls: URL[] = [];
// What the stubbed YouTube returns, by id. Absent = YouTube does not return the video.
let youtube: Record<string, { title: string; duration: string; embeddable: boolean }> = {};

type H = (req: IncomingMessage, res: ServerResponse) => unknown;
const routes: Record<string, H> = { "/api/cron/refresh": refresh, "/api/owner/export": ownerApi };

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  process.env.CRON_SECRET = "cron-secret-123";
  process.env.YOUTUBE_API_KEY = "test-key";
  const db = createDb();
  await migrate(db);
  await db.end();
  server = createServer((req, res) => void routes[new URL(req.url!, "http://x").pathname]?.(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await sharedDb().end();
});
beforeEach(async () => {
  youtubeCalls.length = 0;
  youtube = {};
  const db = sharedDb();
  await db.query("truncate songs, queue, activity_log, library_exports restart identity cascade");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "www.googleapis.com") {
      youtubeCalls.push(url);
      const items = url.searchParams
        .get("id")!
        .split(",")
        .filter((id) => youtube[id])
        .map((id) => ({
          id,
          snippet: { title: youtube[id]!.title },
          contentDetails: { duration: youtube[id]!.duration },
          status: { embeddable: youtube[id]!.embeddable },
        }));
      return Response.json({ items });
    }
    if (!String(input).startsWith(base)) throw new Error(`unstubbed network call: ${input}`);
    return realFetch(input, init);
  });
});

async function addSong(id: string, ageDays: number, title = `old ${id}`): Promise<void> {
  await sharedDb().query(
    "insert into songs (video_id, title, duration_sec, metadata_refreshed_at) values ($1, $2, 100, now() - make_interval(days => $3))",
    [id, title, ageDays],
  );
}

const cron = (auth?: string) => fetch(`${base}/api/cron/refresh`, { headers: auth ? { authorization: auth } : {} });

it("parses ISO durations", () => {
  expect(parseIsoDuration("PT3M25S")).toBe(205);
  expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
  expect(parseIsoDuration("PT45S")).toBe(45);
  expect(parseIsoDuration("P0D")).toBe(0);
});

it("refreshes a stale song and leaves fresh ones unrequested", async () => {
  await addSong("stale1", 26);
  await addSong("fresh1", 3);
  youtube.stale1 = { title: "New Title", duration: "PT4M", embeddable: true };
  const res = await cron("Bearer cron-secret-123");
  expect(res.status).toBe(200);
  const { rows } = await sharedDb().query("select * from songs order by video_id");
  const stale = rows.find((r) => r.video_id === "stale1");
  expect(stale).toMatchObject({ title: "New Title", duration_sec: 240 });
  expect(Date.now() - stale.metadata_refreshed_at.getTime()).toBeLessThan(60_000);
  expect(rows.find((r) => r.video_id === "fresh1").title).toBe("old fresh1");
  expect(youtubeCalls).toHaveLength(1);
  expect(youtubeCalls[0]!.searchParams.get("id")).toBe("stale1");
  expect(youtubeCalls[0]!.searchParams.get("part")).toBe("snippet,contentDetails,status");
  expect(youtubeCalls[0]!.searchParams.has("maxResults")).toBe(false);
});

it("makes no YouTube call when nothing is stale", async () => {
  await addSong("fresh1", 24);
  expect((await cron("Bearer cron-secret-123")).status).toBe(200);
  expect(youtubeCalls).toHaveLength(0);
});

it("removes unembeddable and vanished songs from library and queue, and logs each", async () => {
  await addSong("blocked", 30);
  await addSong("gone", 30);
  await addSong("ok", 30);
  await sharedDb().query("insert into queue (video_id) values ('blocked'), ('gone'), ('ok')");
  youtube.blocked = { title: "Blocked", duration: "PT3M", embeddable: false };
  youtube.ok = { title: "Fine", duration: "PT3M", embeddable: true };
  expect((await cron("Bearer cron-secret-123")).status).toBe(200);
  const db = sharedDb();
  expect((await db.query("select video_id from songs")).rows).toEqual([{ video_id: "ok" }]);
  expect((await db.query("select video_id from queue")).rows).toEqual([{ video_id: "ok" }]);
  const log = (await db.query("select who, what, details from activity_log order by id")).rows;
  expect(log).toHaveLength(2);
  expect(log.every((r) => r.who === "system:upkeep" && r.what === "song_removed")).toBe(true);
  expect(log.map((r) => r.details.videoId).sort()).toEqual(["blocked", "gone"]);
  expect(log.find((r) => r.details.videoId === "blocked").details.reason).toBe("no longer embeddable");
});

it("removes a live/upcoming (zero-duration) song and logs it", async () => {
  await addSong("live", 30);
  youtube.live = { title: "Live", duration: "P0D", embeddable: true };
  expect((await cron("Bearer cron-secret-123")).status).toBe(200);
  expect((await sharedDb().query("select 1 from songs")).rowCount).toBe(0);
  const log = (await sharedDb().query("select details from activity_log")).rows;
  expect(log).toHaveLength(1);
  expect(log[0].details).toMatchObject({ videoId: "live", reason: "no playable duration (live or upcoming)" });
});

it("skips a song with an unparseable duration, logs the error, and finishes the run", async () => {
  await addSong("weird", 30);
  await addSong("fine", 30);
  youtube.weird = { title: "Weird", duration: "garbage", embeddable: true };
  youtube.fine = { title: "Fine now", duration: "PT2M", embeddable: true };
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect((await cron("Bearer cron-secret-123")).status).toBe(200);
    expect(err.mock.calls.flat().join(" ")).toContain("weird");
  } finally {
    err.mockRestore();
  }
  const { rows } = await sharedDb().query("select video_id, title, duration_sec from songs order by video_id");
  expect(rows).toEqual([
    { video_id: "fine", title: "Fine now", duration_sec: 120 },
    { video_id: "weird", title: "old weird", duration_sec: 100 },
  ]);
  expect((await sharedDb().query("select 1 from activity_log")).rowCount).toBe(0);
});

it("batches 50 ids per YouTube call", async () => {
  for (let i = 0; i < 120; i++) {
    const id = `v${String(i).padStart(3, "0")}`;
    await addSong(id, 40);
    youtube[id] = { title: id, duration: "PT1M", embeddable: true };
  }
  expect((await cron("Bearer cron-secret-123")).status).toBe(200);
  expect(youtubeCalls.map((u) => u.searchParams.get("id")!.split(",").length)).toEqual([50, 50, 20]);
});

it("a YouTube outage removes nothing, fails loudly, and still takes the backup", async () => {
  await addSong("stale1", 40);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input)).hostname === "www.googleapis.com" ? new Response("quota", { status: 403 }) : realFetch(input, init),
  );
  const res = await cron("Bearer cron-secret-123");
  expect(res.status).toBe(500);
  expect((await res.json()).failures).toEqual(["refresh"]);
  expect((await sharedDb().query("select 1 from songs")).rowCount).toBe(1);
  expect((await sharedDb().query("select 1 from library_exports")).rowCount).toBe(1);
});

it("cron deletes finished requests 30+ days old, expires old queued ones, leaves fresh rows alone", async () => {
  const db = sharedDb();
  await db.query("truncate requests, request_attempts cascade");
  const rows: [string, string, number][] = [
    ["oldPlayed01", "played", 31], ["oldDenied01", "denied", 31], ["oldExpired1", "expired", 31], ["oldQueued01", "queued", 31],
    ["freshPlay01", "played", 29], ["freshQueue1", "queued", 29],
  ];
  for (const [vid, status, days] of rows) {
    await db.query(
      "insert into requests (video_id, title, duration_sec, name, status, listener_id, created_at, queued_at) values ($1, 'T', 100, 'Sam', $2, 'l', now() - make_interval(days => $3), now())",
      [vid, status, days],
    );
  }
  expect((await cron("Bearer cron-secret-123")).status).toBe(200);
  expect((await db.query("select video_id, status from requests order by video_id")).rows).toEqual([
    { video_id: "freshPlay01", status: "played" },
    { video_id: "freshQueue1", status: "queued" },
  ]);
  const log = (await db.query("select who, what, details from activity_log where what = 'request_expired'")).rows;
  expect(log).toEqual([{ who: "system:upkeep", what: "request_expired", details: { id: expect.any(Number), videoId: "oldQueued01" } }]);
  await db.query("truncate requests, request_attempts cascade");
});

it("an old queued request never plays after the cron ran", async () => {
  const db = sharedDb();
  await db.query("truncate requests, request_attempts, station_state, play_history, queue cascade");
  await db.query("insert into requests (video_id, title, duration_sec, name, status, listener_id, created_at, queued_at) values ('oldQueued01', 'T', 100, 'Sam', 'queued', 'l', now() - interval '31 days', now() - interval '31 days')");
  expect((await cron("Bearer cron-secret-123")).status).toBe(200);
  expect((await getNowPlaying(db, Date.now)).current).toBeNull();
  await db.query("truncate requests, request_attempts cascade");
});

it("cron route refuses missing or wrong bearer", async () => {
  await addSong("stale1", 40);
  expect((await cron()).status).toBe(401);
  expect((await cron("Bearer nope")).status).toBe(401);
  expect((await cron("cron-secret-123")).status).toBe(401);
  expect(youtubeCalls).toHaveLength(0);
  expect((await sharedDb().query("select 1 from library_exports")).rowCount).toBe(0);
});

it("cron route refuses everyone when CRON_SECRET is unset", async () => {
  delete process.env.CRON_SECRET;
  try {
    expect((await cron("Bearer undefined")).status).toBe(401);
    expect((await cron("Bearer ")).status).toBe(401);
  } finally {
    process.env.CRON_SECRET = "cron-secret-123";
  }
});

it("keeps only the last 14 exports", async () => {
  await addSong("a", 1);
  for (let i = 0; i < KEEP_EXPORTS + 3; i++) expect((await cron("Bearer cron-secret-123")).status).toBe(200);
  const { rows } = await sharedDb().query("select id, data from library_exports order by id");
  expect(rows).toHaveLength(14);
  expect(rows[0].id).toBe("4"); // ids 1-3 pruned
  expect(rows[13].data.songs).toEqual([{ videoId: "a", addedAt: expect.any(String) }]); // no title/duration saved
});

it("daily cron strips YouTube titles from activity_log rows older than 30 days, keeps newer ones", async () => {
  const db = sharedDb();
  await db.query("delete from activity_log");
  const old = "now() - interval '31 days'";
  await db.query(`insert into activity_log (who, what, at, details) values
    ('owner','queue_move', ${old}, '{"videoId":"a","title":"Old Song","from":1}'),
    ('owner','skip', ${old}, '{"skipped":{"videoId":"a","title":"Old"},"next":{"videoId":"b","title":"Next"}}'),
    ('owner','skip', ${old}, '{"skipped":{"videoId":"a","title":"Old"},"next":null}'),
    ('owner','queue_move', now(), '{"videoId":"c","title":"New Song"}')`);
  expect((await cron("Bearer cron-secret-123")).status).toBe(200);
  const { rows } = await db.query("select details from activity_log order by id");
  expect(rows[0].details).toEqual({ videoId: "a", from: 1 });
  expect(rows[1].details).toEqual({ skipped: { videoId: "a" }, next: { videoId: "b" } });
  expect(rows[2].details).toEqual({ skipped: { videoId: "a" }, next: null });
  expect(rows[3].details).toEqual({ videoId: "c", title: "New Song" });
});

it("purging an expired trashed song logs its videoId only, no title", async () => {
  const db = sharedDb();
  await db.query("delete from activity_log");
  await addSong("gone", 1);
  await db.query("update songs set deleted_at = now() - interval '31 days' where video_id = 'gone'");
  expect(await purgeTrash(db)).toEqual(["gone"]);
  const { rows } = await db.query("select details from activity_log where what = 'trash_purged'");
  expect(rows).toEqual([{ details: { videoId: "gone" } }]);
});

it("owner export returns every library song as a download; non-owner gets 401", async () => {
  await addSong("a", 1, "Song A");
  await addSong("b", 50, "Song B");
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(await issueSession(sharedDb()))}`;
  const res = await fetch(`${base}/api/owner/export`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="ttunes-library-\d{4}-\d{2}-\d{2}\.json"$/);
  const body = await res.json();
  expect(body.songs.map((s: { videoId: string; title: string }) => [s.videoId, s.title]).sort()).toEqual([
    ["a", "Song A"],
    ["b", "Song B"],
  ]);
  expect((await fetch(`${base}/api/owner/export`)).status).toBe(401);
  expect((await fetch(`${base}/api/owner/export`, { headers: { cookie: `${SESSION_COOKIE}=garbage` } })).status).toBe(401);
});
