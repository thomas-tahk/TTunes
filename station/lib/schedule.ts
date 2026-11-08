import type pg from "pg";
import { advance, type Random, type Station } from "../shared/station.ts";
import type { Db } from "./db.ts";

export interface Song {
  videoId: string;
  title: string;
  durationSec: number;
}

export interface NowPlaying {
  current: Song | null;
  startedAt: number | null; // epoch ms
  next: Song | null;
  serverNow: number; // epoch ms, when this response was built (not when it was cached)
}

export type Clock = () => number; // epoch ms; tests pass a fake

type Queryable = Pick<pg.ClientBase, "query">;

interface StateRow {
  current_video_id: string | null;
  started_at_ms: string | null;
  cycle: { unplayed: string[]; played: string[] };
}

// Seeded so the "next" shown while a song plays is exactly what the advance later picks.
function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const songOf = (row: { video_id: string; title: string; duration_sec: number }): Song => ({
  videoId: row.video_id,
  title: row.title,
  durationSec: row.duration_sec,
});

// Every song, trashed ones too (a trashed song that is playing now still finishes), plus the live library ids.
interface Catalog {
  songs: Map<string, Song>;
  library: string[];
}

async function loadSongs(q: Queryable): Promise<Catalog> {
  const { rows } = await q.query("select video_id, title, duration_sec, deleted_at is not null as trashed from songs order by added_at, video_id");
  return {
    songs: new Map(rows.map((row) => [row.video_id, songOf(row)])),
    library: rows.filter((row) => !row.trashed).map((row) => row.video_id),
  };
}

async function loadState(q: Queryable, lock: boolean): Promise<StateRow> {
  if (lock) await q.query("insert into station_state (id) values (1) on conflict do nothing");
  const { rows } = await q.query(`select current_video_id, started_at_ms, cycle from station_state where id = 1${lock ? " for update" : ""}`);
  return rows[0] ?? { current_video_id: null, started_at_ms: null, cycle: { unplayed: [], played: [] } };
}

async function loadStation(q: Queryable, state: StateRow, library: string[]): Promise<Station> {
  const { rows } = await q.query("select video_id from queue order by position, id");
  return {
    queue: rows.map((row) => row.video_id),
    unplayed: state.cycle.unplayed,
    played: state.cycle.played,
    current: state.current_video_id,
    library,
  };
}

const startedAtOf = (state: StateRow): number | null => (state.started_at_ms === null ? null : Number(state.started_at_ms));

function hasEnded(state: StateRow, catalog: Catalog, now: number): boolean {
  const song = state.current_video_id ? catalog.songs.get(state.current_video_id) : undefined;
  const startedAt = startedAtOf(state);
  if (!song || startedAt === null) return true;
  return now >= startedAt + song.durationSec * 1000;
}

async function describe(q: Queryable, state: StateRow, catalog: Catalog, now: number): Promise<NowPlaying> {
  const { songs } = catalog;
  const startedAt = startedAtOf(state);
  const current = state.current_video_id ? (songs.get(state.current_video_id) ?? null) : null;
  if (!current || startedAt === null) return { current: null, startedAt: null, next: null, serverNow: now };
  const station = await loadStation(q, state, catalog.library);
  const nextId = advance(station, station.library, seededRandom(startedAt)).id;
  return { current, startedAt, next: nextId ? (songs.get(nextId) ?? null) : null, serverNow: now };
}

// Moves the station on inside one transaction. The row lock makes concurrent callers queue up;
// whoever gets the lock second sees a fresh song and changes nothing.
async function advanceOnce(db: Db, clock: Clock): Promise<NowPlaying> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const state = await loadState(client, true);
    const now = clock(); // read after the lock: a waiter must not report a time before the winner's startedAt
    const catalog = await loadSongs(client);
    if (!hasEnded(state, catalog, now)) {
      await client.query("commit");
      return await describe(client, state, catalog, now);
    }
    const next = await writeAdvance(client, state, catalog, now);
    await client.query("commit");
    return next;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function writeAdvance(client: Queryable, state: StateRow, catalog: Catalog, now: number): Promise<NowPlaying> {
  const station = await loadStation(client, state, catalog.library);
  const seed = startedAtOf(state) ?? now;
  const step = advance(station, station.library, seededRandom(seed));
  if (step.id !== null) await consumeQueueHead(client, station, step.id);
  const cycle = { unplayed: step.station.unplayed, played: step.station.played };
  const startedAt = step.id === null ? null : now;
  await client.query("update station_state set current_video_id = $1, started_at_ms = $2, cycle = $3 where id = 1", [step.id, startedAt, cycle]);
  if (step.id !== null) await client.query("insert into play_history (video_id, started_at_ms) values ($1, $2)", [step.id, now]);
  const fresh: StateRow = { current_video_id: step.id, started_at_ms: startedAt === null ? null : String(startedAt), cycle };
  return describe(client, fresh, catalog, now);
}

async function consumeQueueHead(client: Queryable, before: Station, playedId: string): Promise<void> {
  if (before.queue[0] !== playedId) return;
  await client.query("delete from queue where id = (select id from queue where video_id = $1 order by position, id limit 1)", [playedId]);
}

// Already off air and nothing to play: an advance would change nothing, so skip the write transaction.
// A song or queue entry added since this read is picked up by the next poll.
async function staysOffAir(q: Queryable, state: StateRow, catalog: Catalog): Promise<boolean> {
  if (state.current_video_id !== null) return false;
  const station = await loadStation(q, state, catalog.library);
  return station.queue.length === 0 && station.library.length === 0;
}

export async function getNowPlaying(db: Db, clock: Clock): Promise<NowPlaying> {
  const now = clock();
  const state = await loadState(db, false);
  const catalog = await loadSongs(db);
  if (!hasEnded(state, catalog, now)) return describe(db, state, catalog, now);
  if (await staysOffAir(db, state, catalog)) return describe(db, state, catalog, now);
  return advanceOnce(db, clock);
}

export type SkipResult = { skipped: true; now: NowPlaying; from: Song | null } | { skipped: false; current: string | null };

/** Owner skip. Takes the same row lock as the lazy advance, so a skip and a natural advance move the
 * station once between them: whoever is second sees a different current song and changes nothing. */
export async function skipCurrent(db: Db, expectedVideoId: string, clock: Clock): Promise<SkipResult> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const state = await loadState(client, true);
    if (state.current_video_id !== expectedVideoId) {
      await client.query("rollback");
      return { skipped: false, current: state.current_video_id };
    }
    const now = clock();
    const catalog = await loadSongs(client);
    const from = catalog.songs.get(expectedVideoId) ?? null; // null: the playing song was hard-deleted (upkeep)
    const next = await writeAdvance(client, state, catalog, now);
    await client.query("insert into activity_log (who, what, details) values ('owner', 'skip', $1)", [
      { skipped: { videoId: expectedVideoId }, next: next.current && { videoId: next.current.videoId } },
    ]);
    await client.query("commit");
    return { skipped: true, now: next, from };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const OFF_AIR_CACHE_SECONDS = 5; // off air: a first add reaches listeners after their next poll (up to ~30s) plus this cache
export const MAX_CACHE_SECONDS = 15; // listeners re-check about every 30s, so owner skips show up quickly

/** Seconds a CDN may keep the response: never past the end of the current song, capped at 15; off air, 5. */
export function cacheSeconds(playing: NowPlaying): number {
  if (!playing.current || playing.startedAt === null) return OFF_AIR_CACHE_SECONDS;
  const remainingMs = playing.startedAt + playing.current.durationSec * 1000 - playing.serverNow;
  return Math.min(MAX_CACHE_SECONDS, Math.max(0, Math.floor(remainingMs / 1000)));
}
