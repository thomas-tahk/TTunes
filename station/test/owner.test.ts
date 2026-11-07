import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import ownerApi from "../api/owner.ts";
import refresh from "../api/cron/refresh.ts";
import { insertSong } from "../lib/addSong.ts";
import { issueSession, SESSION_COOKIE } from "../lib/auth.ts";
import { createDb, sharedDb } from "../lib/db.ts";
import { migrate } from "../lib/migrate.ts";
import { lockStation } from "../lib/lock.ts";
import { getNowPlaying } from "../lib/schedule.ts";
import { purgeTrash, refreshStale } from "../lib/upkeep.ts";

let server: Server;
let base: string;
let cookie: string;
const realFetch = globalThis.fetch;

type H = (req: IncomingMessage, res: ServerResponse) => unknown;

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  process.env.YOUTUBE_API_KEY = "test-key";
  const db = createDb();
  await migrate(db);
  await db.end();
  server = createServer((req, res) => {
    const h: H = new URL(req.url!, "http://x").pathname === "/api/cron/refresh" ? refresh : ownerApi;
    void h(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await sharedDb().end();
});
beforeEach(async () => {
  const db = sharedDb();
  await db.query("truncate play_history, queue, station_state, songs, activity_log, trash_queue, library_exports restart identity cascade");
  for (const id of ["aaa", "bbb", "ccc", "ddd"]) await db.query("insert into songs (video_id, title, duration_sec) values ($1, $2, 300)", [id, `Song ${id}`]);
  cookie = `${SESSION_COOKIE}=${encodeURIComponent(await issueSession(db))}`;  // YouTube returns nothing for any id: upkeep treats every stale song as gone.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).hostname === "www.googleapis.com") return Response.json({ items: [] });
    return realFetch(input, init);
  });
});

async function call(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const now = () => getNowPlaying(sharedDb(), Date.now);
const queueIds = async (): Promise<string[]> => (await call("GET", "/api/owner/queue")).json.queue.map((q: { videoId: string }) => q.videoId);
const queueItems = async (): Promise<{ queueId: string; videoId: string }[]> => (await call("GET", "/api/owner/queue")).json.queue;
const logWhats = async () => (await call("GET", "/api/owner/log?limit=500")).json.entries.map((e: { what: string }) => e.what);
const trashIt = (videoId: string) => call("DELETE", "/api/owner/songs", { videoId });
const restoreIt = (videoId: string) => call("POST", "/api/owner/songs/restore", { videoId });

async function enqueue(...ids: string[]): Promise<void> {
  for (const id of ids) await sharedDb().query("insert into queue (video_id) values ($1)", [id]);
}

const info = (videoId: string) => ({ videoId, title: `Song ${videoId}`, durationSec: 300, embeddable: true, categoryId: "10", channelTitle: "c" });

it("every owner endpoint answers 401 without the owner cookie", async () => {
  const calls: [string, string, unknown?][] = [
    ["POST", "/api/owner/skip", { expectedVideoId: "aaa" }],
    ["GET", "/api/owner/queue"],
    ["DELETE", "/api/owner/queue", { queueId: 1 }],
    ["POST", "/api/owner/queue/move", { queueId: 1, toIndex: 0 }],
    ["DELETE", "/api/owner/songs", { videoId: "aaa" }],
    ["POST", "/api/owner/songs/restore", { videoId: "aaa" }],
    ["GET", "/api/owner/trash"],
    ["GET", "/api/owner/log"],
    ["GET", "/api/owner/library"],
  ];
  for (const [method, path, body] of calls) expect((await call(method, path, body, false)).status, `${method} ${path}`).toBe(401);
  expect((await call("GET", "/api/owner/log", undefined, false)).json).toEqual({ error: "owner only" });
  expect((await sharedDb().query("select 1 from activity_log")).rowCount).toBe(0);
});

it("an unknown owner path is a 404", async () => {
  expect((await call("GET", "/api/owner/nope")).status).toBe(404);
  expect((await call("GET", "/api/owner/toString")).status).toBe(404);
});

it("the rewrite form (?route=) reaches the same handlers", async () => {
  expect((await call("GET", "/api/owner?route=queue")).json).toEqual({ queue: [] });
});

it("skip moves /api/now to the next song and logs it", async () => {
  await enqueue("ccc");
  const first = (await now()).current!;
  const res = await call("POST", "/api/owner/skip", { expectedVideoId: first.videoId });
  expect(res.status).toBe(200);
  expect(res.json.current.videoId).not.toBe(first.videoId);
  expect((await now()).current!.videoId).toBe(res.json.current.videoId);
  const entry = (await call("GET", "/api/owner/log")).json.entries[0];
  expect(entry).toMatchObject({ who: "owner", what: "skip", details: { skipped: { videoId: first.videoId }, next: { videoId: res.json.current.videoId } } });
});

it("skip with a stale expectedVideoId is a 409 and moves nothing", async () => {
  const first = (await now()).current!;
  expect((await call("POST", "/api/owner/skip", { expectedVideoId: first.videoId })).status).toBe(200);
  const after = (await now()).current!.videoId;
  const stale = await call("POST", "/api/owner/skip", { expectedVideoId: first.videoId });
  expect(stale.status).toBe(409);
  expect(stale.json.current).toBe(after);
  expect((await now()).current!.videoId).toBe(after);
  expect((await call("POST", "/api/owner/skip", {})).status).toBe(400);
});

it("5 concurrent skips with the same expectedVideoId move the station exactly once", async () => {
  for (let round = 1; round <= 10; round++) {
    const current = (await now()).current!;
    const results = await Promise.all(Array.from({ length: 5 }, () => call("POST", "/api/owner/skip", { expectedVideoId: current.videoId })));
    expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([200, 409, 409, 409, 409]);
    expect((await sharedDb().query("select count(*)::int as n from play_history")).rows[0].n).toBe(round + 1);
  }
  expect((await call("GET", "/api/owner/log?limit=500")).json.entries.filter((e: { what: string }) => e.what === "skip")).toHaveLength(10);
});

it("skip still advances and logs null fields when the playing song was hard-deleted", async () => {
  const current = (await now()).current!.videoId;
  await sharedDb().query("delete from songs where video_id = $1", [current]); // what upkeep does
  const res = await call("POST", "/api/owner/skip", { expectedVideoId: current });
  expect(res.status).toBe(200);
  expect(res.json.current.videoId).not.toBe(current);
  const entry = (await call("GET", "/api/owner/log")).json.entries[0];
  expect(entry).toMatchObject({ what: "skip", details: { skipped: { videoId: current, title: null } } });
});

it("queue lists in order with titles; move and remove keep the order; queueIds are stable", async () => {
  await enqueue("aaa", "bbb", "ccc", "ddd");
  const listed = await queueItems();
  expect((await call("GET", "/api/owner/queue")).json.queue.map((q: any) => [q.index, q.videoId, q.title])).toEqual([[0, "aaa", "Song aaa"], [1, "bbb", "Song bbb"], [2, "ccc", "Song ccc"], [3, "ddd", "Song ddd"]]);

  const moved = await call("POST", "/api/owner/queue/move", { queueId: listed[3]!.queueId, toIndex: 1 });
  expect(moved.json.queue.map((q: any) => q.videoId)).toEqual(["aaa", "ddd", "bbb", "ccc"]);
  expect(await queueIds()).toEqual(["aaa", "ddd", "bbb", "ccc"]);
  expect((await queueItems()).map((q) => q.queueId).sort()).toEqual(listed.map((q) => q.queueId).sort());

  await call("POST", "/api/owner/queue/move", { queueId: listed[2]!.queueId, toIndex: 0 });
  expect(await queueIds()).toEqual(["ccc", "aaa", "ddd", "bbb"]);

  const removed = await call("DELETE", "/api/owner/queue", { queueId: listed[0]!.queueId });
  expect(removed.json.queue.map((q: any) => q.videoId)).toEqual(["ccc", "ddd", "bbb"]);
  expect((await call("DELETE", "/api/owner/queue", { queueId: listed[0]!.queueId })).status).toBe(404);
  expect((await call("POST", "/api/owner/queue/move", { queueId: listed[1]!.queueId, toIndex: 9 })).status).toBe(400);
  expect(await logWhats()).toEqual(["queue_remove", "queue_move", "queue_move"]);
});

it("the station plays the queue in the edited order", async () => {
  await enqueue("aaa", "bbb", "ccc");
  const items = await queueItems();
  await call("POST", "/api/owner/queue/move", { queueId: items[2]!.queueId, toIndex: 0 });
  const played: string[] = [];
  let t = 1_900_000_000_000;
  for (let i = 0; i < 3; i++) {
    const p = await getNowPlaying(sharedDb(), () => t);
    played.push(p.current!.videoId);
    t = p.startedAt! + 300_000;
  }
  expect(played).toEqual(["ccc", "aaa", "bbb"]);
});

it("three 'play next' adds, then every possible move, then a trash and restore: no errors, order correct", async () => {
  for (const id of ["aaa", "bbb", "ccc"]) expect((await insertSong(sharedDb(), info(id), "next")).ok).toBe(true);
  expect(await queueIds()).toEqual(["ccc", "bbb", "aaa"]); // negative positions
  for (const from of [0, 1, 2]) {
    for (const to of [0, 1, 2]) {
      const before = await queueItems();
      const res = await call("POST", "/api/owner/queue/move", { queueId: before[from]!.queueId, toIndex: to });
      expect(res.status, `move ${from}->${to}`).toBe(200);
      const expected = before.map((q) => q.videoId);
      expected.splice(to, 0, ...expected.splice(from, 1));
      expect(await queueIds(), `move ${from}->${to}`).toEqual(expected);
    }
  }
  const order = await queueIds();
  expect((await trashIt(order[1]!)).status).toBe(200);
  expect(await queueIds()).toEqual([order[0], order[2]]);
  expect((await restoreIt(order[1]!)).status).toBe(200);
  expect(await queueIds()).toEqual(order);
  expect((await insertSong(sharedDb(), info("ddd"), "next")).ok).toBe(true);
  expect((await queueIds())[0]).toBe("ddd");
});

it("concurrent queue edits leave one consistent order", async () => {
  await enqueue("aaa", "bbb", "ccc", "ddd");
  const items = await queueItems();
  await Promise.all([
    call("POST", "/api/owner/queue/move", { queueId: items[0]!.queueId, toIndex: 3 }),
    call("DELETE", "/api/owner/queue", { queueId: items[2]!.queueId }),
    call("POST", "/api/owner/queue/move", { queueId: items[3]!.queueId, toIndex: 0 }),
  ]);
  const after = await queueIds();
  expect(after).toHaveLength(3);
  expect(new Set(after)).toEqual(new Set(["aaa", "bbb", "ddd"]));
});

it("a deleted song leaves library and queue; restore brings it back with its queue spots", async () => {
  await enqueue("bbb", "ccc", "bbb", "ddd");
  expect((await trashIt("bbb")).json).toMatchObject({ videoId: "bbb", title: "Song bbb", removedFromQueue: 2 });
  expect((await call("GET", "/api/owner/library")).json.songs.map((s: any) => s.videoId)).toEqual(["aaa", "ccc", "ddd"]);
  expect(await queueIds()).toEqual(["ccc", "ddd"]);
  expect((await call("GET", "/api/owner/trash")).json.songs.map((s: any) => s.videoId)).toEqual(["bbb"]);
  expect((await trashIt("bbb")).status).toBe(404);
  expect((await restoreIt("bbb")).json).toMatchObject({ restoredToQueue: 2 });
  expect(await queueIds()).toEqual(["bbb", "ccc", "bbb", "ddd"]);
  expect((await call("GET", "/api/owner/library")).json.songs).toHaveLength(4);
  expect((await call("GET", "/api/owner/trash")).json.songs).toEqual([]);
  expect((await restoreIt("bbb")).status).toBe(404);
});

it("restore puts a song back beside the entries it sat between, not behind later additions", async () => {
  await enqueue("aaa", "bbb");
  await trashIt("bbb"); // bbb was last, after aaa
  await insertSong(sharedDb(), info("ccc"), "queue"); // added later, now at the end
  await insertSong(sharedDb(), info("ddd"), "queue");
  await restoreIt("bbb");
  expect(await queueIds()).toEqual(["aaa", "bbb", "ccc", "ddd"]);
});

it("restore falls back to before the next entry when the previous one is gone, and to the end if it was last", async () => {
  await enqueue("aaa", "bbb", "ccc");
  await trashIt("bbb"); // between aaa and ccc
  const [aaa] = await queueItems();
  await call("DELETE", "/api/owner/queue", { queueId: aaa!.queueId });
  await insertSong(sharedDb(), info("ddd"), "next");
  await restoreIt("bbb"); // prev (aaa) gone: sits right before ccc
  expect(await queueIds()).toEqual(["ddd", "bbb", "ccc"]);
});

it("restore with both neighbours gone uses the old index, clamped", async () => {
  await enqueue("aaa", "bbb", "ccc", "ddd");
  await trashIt("ccc"); // was index 2, between bbb and ddd
  const items = await queueItems();
  for (const id of ["bbb", "ddd"]) await call("DELETE", "/api/owner/queue", { queueId: items.find((q) => q.videoId === id)!.queueId });
  await restoreIt("ccc");
  expect(await queueIds()).toEqual(["aaa", "ccc"]);
});

it("restore of a last entry whose previous neighbour is gone goes to the end", async () => {
  await enqueue("aaa", "bbb", "ccc");
  await trashIt("ccc");
  const items = await queueItems();
  await call("DELETE", "/api/owner/queue", { queueId: items.find((q) => q.videoId === "bbb")!.queueId });
  await insertSong(sharedDb(), info("ddd"), "queue");
  await restoreIt("ccc");
  expect(await queueIds()).toEqual(["aaa", "ddd", "ccc"]);
});

it("a trashed song never comes up in the shuffle", async () => {
  await trashIt("bbb");
  const seen = new Set<string>();
  let t = 1_900_000_000_000;
  for (let i = 0; i < 12; i++) {
    const p = await getNowPlaying(sharedDb(), () => t);
    seen.add(p.current!.videoId);
    if (p.next) seen.add(p.next.videoId);
    t = p.startedAt! + 300_000;
  }
  expect(seen).toEqual(new Set(["aaa", "ccc", "ddd"]));
});

it("a song deleted while playing finishes, then never comes back", async () => {
  const playing = (await now()).current!.videoId;
  await trashIt(playing);
  const still = await now();
  expect(still.current!.videoId).toBe(playing);
  expect(still.next!.videoId).not.toBe(playing);
  let t = still.startedAt! + 300_000;
  for (let i = 0; i < 10; i++) {
    const p = await getNowPlaying(sharedDb(), () => t);
    expect(p.current!.videoId).not.toBe(playing);
    t = p.startedAt! + 300_000;
  }
});

it("re-adding a trashed song restores it to the library, clears its trash record and logs restoredFromTrash", async () => {
  await enqueue("bbb", "ccc");
  await trashIt("bbb");
  expect((await sharedDb().query("select 1 from trash_queue")).rowCount).toBe(1);
  expect((await insertSong(sharedDb(), { ...info("bbb"), title: "Fresh Title" }, "next")).ok).toBe(true);
  expect((await call("GET", "/api/owner/trash")).json.songs).toEqual([]);
  expect((await call("GET", "/api/owner/library")).json.songs.map((s: any) => s.videoId)).toContain("bbb");
  expect((await sharedDb().query("select 1 from trash_queue")).rowCount).toBe(0);
  expect(await queueIds()).toEqual(["bbb", "ccc"]);
  const entry = (await call("GET", "/api/owner/log")).json.entries[0];
  expect(entry).toMatchObject({ what: "song_added", details: { videoId: "bbb", title: "Fresh Title", restoredFromTrash: true } });
  await insertSong(sharedDb(), info("aaa"), "queue");
  expect((await call("GET", "/api/owner/log")).json.entries[0].details.restoredFromTrash).toBeUndefined();
});

it("upkeep purges trash older than 30 days, or with YouTube metadata older than 30 days, and cascades to trash_queue", async () => {
  await enqueue("aaa", "bbb", "ccc", "ddd");
  for (const id of ["aaa", "bbb", "ccc", "ddd"]) await trashIt(id);
  const q = (sql: string) => sharedDb().query(sql);
  await q("update songs set deleted_at = now() - interval '31 days' where video_id = 'aaa'"); // trashed too long
  await q("update songs set metadata_refreshed_at = now() - interval '31 days' where video_id = 'bbb'"); // YouTube cache rule
  await q("update songs set deleted_at = now() - interval '29 days', metadata_refreshed_at = now() - interval '29 days' where video_id = 'ccc'");
  expect((await purgeTrash(sharedDb())).sort()).toEqual(["aaa", "bbb"]);
  expect((await q("select video_id from songs where deleted_at is not null order by 1")).rows).toEqual([{ video_id: "ccc" }, { video_id: "ddd" }]);
  expect((await q("select distinct video_id from trash_queue order by 1")).rows).toEqual([{ video_id: "ccc" }, { video_id: "ddd" }]);
  const entries = (await call("GET", "/api/owner/log?limit=2")).json.entries;
  expect(entries.map((e: any) => [e.who, e.what]).every(([who, what]: string[]) => who === "system:upkeep" && what === "trash_purged")).toBe(true);
});

it("the daily cron purges old trash and does not refresh trashed songs", async () => {
  process.env.CRON_SECRET = "cron-secret-123";
  await trashIt("ccc");
  await sharedDb().query("update songs set deleted_at = now() - interval '40 days', metadata_refreshed_at = now() - interval '40 days' where video_id = 'ccc'");
  const res = await fetch(`${base}/api/cron/refresh`, { headers: { authorization: "Bearer cron-secret-123" } });
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.refresh.checked).toBe(0);
  expect(body.purged).toEqual(["ccc"]);
});

it("the export leaves out trashed songs", async () => {
  await trashIt("bbb");
  const res = await call("GET", "/api/owner/export");
  expect(res.status).toBe(200);
  expect(res.json.songs.map((s: any) => s.videoId)).toEqual(["aaa", "ccc", "ddd"]);
});

it("upkeep removals and owner edits run concurrently without a deadlock", async () => {
  const db = sharedDb();
  for (let round = 0; round < 5; round++) {
    await db.query("truncate queue, songs, trash_queue, activity_log restart identity cascade");
    const ids = Array.from({ length: 8 }, (_, i) => `s${round}${i}`);
    for (const id of ids) await db.query("insert into songs (video_id, title, duration_sec, metadata_refreshed_at) values ($1, $1, 300, now() - interval '40 days')", [id]);
    for (const id of ids) await db.query("insert into queue (video_id) values ($1)", [id]);
    await db.query("update songs set deleted_at = now() - interval '40 days' where video_id = any($1)", [ids.slice(0, 2)]);
    const owner = ids.slice(2).map((id, i) => (i % 2 ? trashIt(id) : call("POST", "/api/owner/queue/move", { queueId: String(i + 3), toIndex: 0 })));
    const upkeep = [refreshStale(db), purgeTrash(db)];
    const results = await Promise.all([...owner, ...upkeep]);
    for (const r of results) if (r && "status" in r) expect(r.status).not.toBe(500);
  }
}, 30_000);

it("upkeep's removal and purge wait for the station lock (the one global lock order)", async () => {
  const db = sharedDb();
  await db.query("update songs set metadata_refreshed_at = now() - interval '40 days' where video_id = 'aaa'");
  await db.query("update songs set deleted_at = now() - interval '40 days' where video_id = 'bbb'");
  const holder = await db.connect();
  await holder.query("begin");
  await lockStation(holder);
  const pending = [refreshStale(db), purgeTrash(db)];
  await new Promise((r) => setTimeout(r, 300));
  expect((await db.query("select count(*)::int as n from songs")).rows[0].n).toBe(4); // both blocked, nothing deleted yet
  await holder.query("commit");
  holder.release();
  await Promise.all(pending);
  expect((await db.query("select video_id from songs order by 1")).rows).toEqual([{ video_id: "ccc" }, { video_id: "ddd" }]);
});

it("every owner action appears in the log, newest first, with a limit", async () => {
  await enqueue("aaa", "bbb", "ccc", "ddd");
  const first = (await now()).current!.videoId;
  await call("POST", "/api/owner/skip", { expectedVideoId: first });
  const items = await queueItems();
  await call("POST", "/api/owner/queue/move", { queueId: items[0]!.queueId, toIndex: 1 });
  await call("DELETE", "/api/owner/queue", { queueId: (await queueItems())[0]!.queueId });
  await trashIt("ddd");
  await restoreIt("ddd");
  await sharedDb().query("insert into activity_log (who, what) values ('system:upkeep', 'song_removed')");
  expect(await logWhats()).toEqual(["song_removed", "song_restored", "song_trashed", "queue_remove", "queue_move", "skip"]);
  expect((await call("GET", "/api/owner/log?limit=2")).json.entries).toHaveLength(2);
  const owner = (await call("GET", "/api/owner/log")).json.entries.filter((e: any) => e.who === "owner");
  expect(owner).toHaveLength(5);
  expect(owner.every((e: any) => e.details && Object.keys(e.details).length > 0)).toBe(true);
});

it("log comes back newest first in numeric id order past 10 entries (ids are not sorted as text)", async () => {
  const db = sharedDb();
  for (let i = 1; i <= 12; i++) await db.query("insert into activity_log (who, what, details) values ('owner', 'note', $1)", [{ n: i }]);
  const entries = (await call("GET", "/api/owner/log?limit=50")).json.entries as { details: { n: number } }[];
  expect(entries.map((e) => e.details.n)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

it("queue, trash and stale-skip responses carry the fresh playing info", async () => {
  await now(); // station running, as it always is in prod
  await enqueue("ccc", "bbb");
  const items = await queueItems();
  const moved = await call("POST", "/api/owner/queue/move", { queueId: items[1]!.queueId, toIndex: 0 });
  expect(moved.json.playing.next.videoId).toBe((await now()).next!.videoId);
  const removed = await call("DELETE", "/api/owner/queue", { queueId: items[0]!.queueId });
  expect(removed.json.playing.next.videoId).toBe((await now()).next!.videoId);
  const trashed = await trashIt("ddd");
  expect(trashed.json.playing.current.videoId).toBe((await now()).current!.videoId);
  expect((await restoreIt("ddd")).json.playing).toBeTruthy();
  const stale = await call("POST", "/api/owner/skip", { expectedVideoId: "nope" });
  expect(stale.status).toBe(409);
  expect(stale.json.playing.current.videoId).toBe((await now()).current!.videoId);
});
