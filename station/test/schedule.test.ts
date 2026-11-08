import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../lib/db.ts";
import { migrate } from "../lib/migrate.ts";
import { cacheSeconds, getNowPlaying, MAX_CACHE_SECONDS, OFF_AIR_CACHE_SECONDS } from "../lib/schedule.ts";

const T0 = 1_800_000_000_000; // fake clock origin, epoch ms
const sec = (n: number) => n * 1000;
const SONGS = [
  { videoId: "aaa", title: "A", durationSec: 10 },
  { videoId: "bbb", title: "B", durationSec: 20 },
  { videoId: "ccc", title: "C", durationSec: 30 },
];

let db: Db;
const playAt = (database: Db, t: number) => getNowPlaying(database, () => t);

async function seed(songs = SONGS) {
  for (const s of songs) await db.query("insert into songs (video_id, title, duration_sec) values ($1,$2,$3)", [s.videoId, s.title, s.durationSec]);
}

beforeAll(async () => {
  db = createDb();
  await migrate(db);
});
afterAll(() => db.end());
beforeEach(async () => {
  await db.query("truncate play_history, queue, station_state, songs restart identity cascade");
});

// Plays through `count` songs, jumping the fake clock to each song's end; returns the ids in order.
async function playThrough(count: number, from = T0): Promise<string[]> {
  const ids: string[] = [];
  let now = from;
  for (let i = 0; i < count; i++) {
    const playing = await playAt(db, now);
    ids.push(playing.current!.videoId);
    now = playing.startedAt! + sec(playing.current!.durationSec);
  }
  return ids;
}

describe("GET /api/now schedule", () => {
  it("starts the station on the first request and reports current, next and server time", async () => {
    await seed();
    const playing = await playAt(db, T0);
    expect(playing.current).not.toBeNull();
    expect(playing.startedAt).toBe(T0);
    expect(playing.serverNow).toBe(T0);
    expect(playing.next).not.toBeNull();
    expect(playing.next!.videoId).not.toBe(playing.current!.videoId);
  });

  it("(a) returns the song it announced as next once the current one has ended", async () => {
    await seed();
    const first = await playAt(db, T0);
    const during = await playAt(db, T0 + sec(first.current!.durationSec) - 1);
    expect(during.current).toEqual(first.current);
    const after = await playAt(db, T0 + sec(first.current!.durationSec));
    expect(after.current).toEqual(first.next);
    expect(after.startedAt).toBe(T0 + sec(first.current!.durationSec));
  });

  it("(b) advances exactly once when 10 requests hit the boundary together", async () => {
    await seed();
    const first = await playAt(db, T0);
    const boundary = T0 + sec(first.current!.durationSec);
    const results = await Promise.all(Array.from({ length: 10 }, () => playAt(db, boundary)));
    expect(new Set(results.map((r) => r.current!.videoId)).size).toBe(1);
    expect(new Set(results.map((r) => r.startedAt)).size).toBe(1);
    const { rows } = await db.query("select count(*)::int as n from play_history");
    expect(rows[0].n).toBe(2); // the first song plus exactly one advance
  });

  it("a request that waited on the lock never reports a time before startedAt", async () => {
    await seed();
    const first = await playAt(db, T0);
    const boundary = T0 + sec(first.current!.durationSec);
    let ticks = 0;
    const tickingClock = () => (ticks++ < 10 ? boundary + 20 - ticks : boundary + 1000 + ticks); // first 10 reads (before any lock) shrink, later reads grow
    const results = await Promise.all(Array.from({ length: 10 }, () => getNowPlaying(db, tickingClock)));
    for (const r of results) expect(r.serverNow).toBeGreaterThanOrEqual(r.startedAt!);
  });

  it("(c) plays a queued song before the shuffle continues", async () => {
    await seed();
    const first = await playAt(db, T0);
    const queued = SONGS.find((s) => s.videoId !== first.current!.videoId && s.videoId !== first.next!.videoId)!;
    await db.query("insert into queue (video_id) values ($1)", [queued.videoId]);
    const after = await playAt(db, T0 + sec(first.current!.durationSec));
    expect(after.current!.videoId).toBe(queued.videoId);
    const { rows } = await db.query("select count(*)::int as n from queue");
    expect(rows[0].n).toBe(0);
  });

  it("(d) a new round never starts with the song that just ended", async () => {
    await seed();
    const order = await playThrough(3 * 40);
    for (let round = 1; round < 40; round++) {
      expect(order[round * 3]).not.toBe(order[round * 3 - 1]);
    }
    for (let round = 0; round < 40; round++) {
      expect(new Set(order.slice(round * 3, round * 3 + 3)).size).toBe(3); // no repeats within a round
    }
  });

  it("with an empty library reports nothing playing, caches briefly, and writes nothing", async () => {
    const playing = await playAt(db, T0);
    expect(playing).toEqual({ current: null, startedAt: null, next: null, serverNow: T0 });
    expect(cacheSeconds(playing)).toBe(OFF_AIR_CACHE_SECONDS);
    await playAt(db, T0 + 1000);
    expect((await db.query("select count(*)::int as n from station_state")).rows[0].n).toBe(0); // no lock row written
    expect((await db.query("select count(*)::int as n from play_history")).rows[0].n).toBe(0);
  });

  it("the first song added to an empty station starts it on the next poll", async () => {
    await playAt(db, T0);
    await seed(SONGS.slice(0, 1));
    expect((await playAt(db, T0 + 1000)).current?.videoId).toBe("aaa");
  });

  it("a single-song library repeats that song", async () => {
    await seed(SONGS.slice(0, 1));
    expect(await playThrough(3)).toEqual(["aaa", "aaa", "aaa"]);
  });
});

describe("cacheSeconds", () => {
  it("never exceeds the remaining seconds of the song", async () => {
    await seed();
    const first = await playAt(db, T0);
    const duration = first.current!.durationSec;
    for (const elapsedMs of [0, 1, 999, 1000, sec(duration) - 1]) {
      const playing = await playAt(db, T0 + elapsedMs);
      const remainingSec = (sec(duration) - elapsedMs) / 1000;
      expect(cacheSeconds(playing)).toBeLessThanOrEqual(remainingSec);
      expect(cacheSeconds(playing)).toBe(Math.min(MAX_CACHE_SECONDS, Math.floor(remainingSec)));
    }
  });
});
