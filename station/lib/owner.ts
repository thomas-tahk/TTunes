import type pg from "pg";
import type { Db } from "./db.ts";
import { lockStation } from "./lock.ts";

export interface QueueItem {
  queueId: string; // queue.id: stable for the life of the entry
  index: number; // 0-based play order
  videoId: string;
  title: string;
  durationSec: number;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404; error: string };

const fail = (status: 400 | 404, error: string): Outcome<never> => ({ ok: false, status, error });

async function log(client: pg.ClientBase, what: string, details: unknown): Promise<void> {
  await client.query("insert into activity_log (who, what, details) values ('owner', $1, $2)", [what, details]);
}

// station_state lock first (the one global lock order, see lock.ts): serialises with advance, skip, adds and upkeep.
async function inStationTx<T>(db: Db, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const QUEUE_SQL =
  "select q.id::text as id, q.video_id, s.title, s.duration_sec from queue q join songs s using (video_id) order by q.position, q.id";

export async function listQueue(q: Pick<pg.ClientBase, "query">): Promise<QueueItem[]> {
  const { rows } = await q.query(QUEUE_SQL);
  return rows.map((r, index) => ({ queueId: r.id, index, videoId: r.video_id, title: r.title, durationSec: r.duration_sec }));
}

// Play order is `position`; renumbering 0..n-1 in the wanted order is the whole reorder.
async function renumber(client: pg.ClientBase, idsInOrder: string[]): Promise<void> {
  await client.query(
    "update queue q set position = v.pos from unnest($1::bigint[], $2::bigint[]) as v(id, pos) where q.id = v.id",
    [idsInOrder, idsInOrder.map((_, i) => i)],
  );
}

const isId = (value: unknown): value is string | number =>
  (typeof value === "number" && Number.isSafeInteger(value) && value > 0) || (typeof value === "string" && /^\d{1,18}$/.test(value));

/** Moves one queue item to a 0-based index. */
export async function moveQueueItem(db: Db, queueId: unknown, toIndex: unknown): Promise<Outcome<QueueItem[]>> {
  if (!isId(queueId)) return fail(400, "queueId must be a positive integer");
  return inStationTx(db, async (client) => {
    const items = await listQueue(client);
    const from = items.findIndex((item) => item.queueId === String(queueId));
    if (from < 0) return fail(404, "not in the queue");
    if (typeof toIndex !== "number" || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= items.length) {
      return fail(400, `toIndex must be an integer from 0 to ${items.length - 1}`);
    }
    const [moved] = items.splice(from, 1);
    items.splice(toIndex, 0, moved!);
    await renumber(client, items.map((item) => item.queueId));
    await log(client, "queue_move", { videoId: moved!.videoId, from, to: toIndex });
    return { ok: true, value: await listQueue(client) };
  });
}

export async function removeQueueItem(db: Db, queueId: unknown): Promise<Outcome<QueueItem[]>> {
  if (!isId(queueId)) return fail(400, "queueId must be a positive integer");
  return inStationTx(db, async (client) => {
    const item = (await listQueue(client)).find((i) => i.queueId === String(queueId));
    if (!item) return fail(404, "not in the queue");
    await client.query("delete from queue where id = $1", [item.queueId]);
    await log(client, "queue_remove", { videoId: item.videoId, index: item.index });
    return { ok: true, value: await listQueue(client) };
  });
}

export interface TrashedSong {
  videoId: string;
  title: string;
  durationSec: number;
  deletedAt: string;
}

// The nearest entry of another song on each side (null = start/end of the queue).
function neighbours(items: QueueItem[], at: number): { prev: string | null; next: string | null } {
  const other = (i: number) => items[i]!.videoId !== items[at]!.videoId;
  let prev = at - 1;
  while (prev >= 0 && !other(prev)) prev--;
  let next = at + 1;
  while (next < items.length && !other(next)) next++;
  return { prev: prev >= 0 ? items[prev]!.queueId : null, next: next < items.length ? items[next]!.queueId : null };
}

/** Moves a library song to the trash: out of library, shuffle and queue; where it sat in the queue is remembered for undo. */
export async function trashSong(db: Db, videoId: unknown): Promise<Outcome<{ videoId: string; title: string; removedFromQueue: number }>> {
  if (typeof videoId !== "string" || !videoId) return fail(400, "videoId required");
  return inStationTx(db, async (client) => {
    const song = (await client.query("select title from songs where video_id = $1 and deleted_at is null for update", [videoId])).rows[0];
    if (!song) return fail(404, "not in the library");
    const items = await listQueue(client);
    let spots = 0;
    for (const [at, item] of items.entries()) {
      if (item.videoId !== videoId) continue;
      const { prev, next } = neighbours(items, at);
      await client.query(
        "insert into trash_queue (video_id, prev_id, next_id, queued_at, queue_index) select video_id, $2, $3, queued_at, $4 from queue where id = $1",
        [item.queueId, prev, next, at],
      );
      spots++;
    }
    await client.query("delete from queue where video_id = $1", [videoId]);
    await client.query("update songs set deleted_at = now() where video_id = $1", [videoId]);
    await log(client, "song_trashed", { videoId, removedFromQueue: spots });
    return { ok: true, value: { videoId, title: song.title, removedFromQueue: spots } };
  });
}

// Index to reinsert at: right after a surviving "before" neighbour, else right before a surviving "after" neighbour,
// else the end if it used to be last, else its old index clamped to the queue (front if unknown).
function restoreIndex(order: string[], prev: string | null, next: string | null, oldIndex: number | null): number {
  const after = prev === null ? -1 : order.indexOf(prev);
  if (after >= 0) return after + 1;
  const before = next === null ? -1 : order.indexOf(next);
  if (before >= 0) return before;
  return next === null ? order.length : Math.min(oldIndex ?? 0, order.length);
}

/** Undo of trashSong: back in library and shuffle, and back in the queue beside the entries it sat between. */
export async function restoreSong(db: Db, videoId: unknown): Promise<Outcome<{ videoId: string; title: string; restoredToQueue: number }>> {
  if (typeof videoId !== "string" || !videoId) return fail(400, "videoId required");
  return inStationTx(db, async (client) => {
    const song = (await client.query("select title from songs where video_id = $1 and deleted_at is not null for update", [videoId])).rows[0];
    if (!song) return fail(404, "not in the trash");
    const spots = (await client.query("select prev_id::text as prev, next_id::text as next, queue_index, queued_at from trash_queue where video_id = $1 order by id", [videoId])).rows;
    const order = (await listQueue(client)).map((item) => item.queueId);
    for (const spot of spots) {
      const { rows } = await client.query("insert into queue (video_id, queued_at) values ($1, $2) returning id::text as id", [videoId, spot.queued_at]);
      order.splice(restoreIndex(order, spot.prev, spot.next, spot.queue_index), 0, rows[0].id);
    }
    await renumber(client, order);
    await client.query("delete from trash_queue where video_id = $1", [videoId]);
    await client.query("update songs set deleted_at = null where video_id = $1", [videoId]);
    await log(client, "song_restored", { videoId, restoredToQueue: spots.length });
    return { ok: true, value: { videoId, title: song.title, restoredToQueue: spots.length } };
  });
}

export async function listTrash(db: Db): Promise<TrashedSong[]> {
  const { rows } = await db.query("select video_id, title, duration_sec, deleted_at from songs where deleted_at is not null order by deleted_at desc, video_id");
  return rows.map((r) => ({ videoId: r.video_id, title: r.title, durationSec: r.duration_sec, deletedAt: r.deleted_at.toISOString() }));
}

export async function listLibrary(db: Db) {
  const { rows } = await db.query("select video_id, title, duration_sec, added_at from songs where deleted_at is null order by added_at, video_id");
  return rows.map((r) => ({ videoId: r.video_id, title: r.title, durationSec: r.duration_sec, addedAt: r.added_at.toISOString() }));
}

export async function readLog(db: Db, limit: number) {
  const { rows } = await db.query("select id::text as id, who, what, at, details from activity_log order by activity_log.id desc limit $1", [limit]);
  const titles = await currentTitles(db, rows.map((r) => r.details));
  return rows.map((r) => ({ id: r.id, who: r.who, what: r.what, at: r.at.toISOString(), details: withCurrentTitles(r.details, titles) }));
}

// The log stores only videoIds (titles are YouTube data under the 30-day cache rule); titles are joined from songs on read.
const SONG_REFS = ["skipped", "next"] as const;
type Details = Record<string, any>;
const refsOf = (d: Details): Details[] => [d, ...SONG_REFS.map((k) => d[k]).filter((v) => v && typeof v === "object")];

async function currentTitles(db: Db, all: Details[]): Promise<Map<string, string>> {
  const ids = [...new Set(all.flatMap((d) => refsOf(d ?? {}).map((r) => r.videoId).filter((v) => typeof v === "string")))];
  if (!ids.length) return new Map();
  const { rows } = await db.query("select video_id, title from songs where video_id = any($1)", [ids]);
  return new Map(rows.map((r) => [r.video_id, r.title]));
}

function withCurrentTitles(details: Details | null, titles: Map<string, string>): Details | null {
  if (!details) return details;
  const out: Details = { ...details };
  delete out.title; // legacy rows may still carry a stored title until the daily strip
  for (const key of SONG_REFS) {
    if (out[key] && typeof out[key] === "object") out[key] = withCurrentTitles(out[key], titles);
  }
  const title = typeof out.videoId === "string" ? titles.get(out.videoId) : undefined;
  return title === undefined ? out : { ...out, title };
}
