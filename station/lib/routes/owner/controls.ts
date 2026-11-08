import { listLibrary, listQueue, listTrash, moveQueueItem, readLog, removeQueueItem, restoreSong, trashSong } from "../../owner.ts";
import type { Db } from "../../db.ts";
import { byMethod, fromOutcome, ownerEndpoint, type OwnerResult } from "../../ownerApi.ts";
import { getNowPlaying, skipCurrent } from "../../schedule.ts";

const asQueue = (queue: unknown) => ({ queue });

/** Every list-changing owner action returns the fresh NowPlaying so the owner's "Up next" is right without the CDN-cached /api/now. */
async function withPlaying(db: Db, result: OwnerResult): Promise<OwnerResult> {
  if (result.status !== 200) return result;
  const running = await db.query("select 1 from station_state where current_video_id is not null"); // never be what starts the station
  if (running.rowCount === 0) return result;
  return { ...result, body: { ...(result.body as object), playing: await getNowPlaying(db, Date.now) } };
}

// POST /api/owner/skip {expectedVideoId} -> NowPlaying. 409 {error, current} if that song is no longer current.
export const skip = ownerEndpoint("POST", async ({ db, body }) => {
  if (typeof body.expectedVideoId !== "string" || !body.expectedVideoId) return { status: 400, body: { error: "expectedVideoId required" } };
  const result = await skipCurrent(db, body.expectedVideoId, Date.now);
  if (!result.skipped) return { status: 409, body: { error: "that song is no longer playing", current: result.current, ...(result.current !== null && { playing: await getNowPlaying(db, Date.now) }) } }; // never started: a bogus skip must not be what starts the station
  return { status: 200, body: result.now };
});

// GET /api/owner/queue -> {queue:[{queueId,index,videoId,title,durationSec}]}
// DELETE /api/owner/queue {queueId} -> {queue}
export const queue = byMethod({
  GET: ownerEndpoint("GET", async ({ db }) => ({ status: 200, body: asQueue(await listQueue(db)) })),
  DELETE: ownerEndpoint("DELETE", async ({ db, body }) => withPlaying(db, fromOutcome(await removeQueueItem(db, body.queueId), asQueue))),
});

// POST /api/owner/queue/move {queueId, toIndex} -> {queue}
export const queueMove = ownerEndpoint("POST", async ({ db, body }) => withPlaying(db, fromOutcome(await moveQueueItem(db, body.queueId, body.toIndex), asQueue)));

// DELETE /api/owner/songs {videoId} -> {videoId,title,removedFromQueue}   (POST on the same path adds a song)
export const songTrash = ownerEndpoint("DELETE", async ({ db, body }) => withPlaying(db, fromOutcome(await trashSong(db, body.videoId))));

// POST /api/owner/songs/restore {videoId} -> {videoId,title,restoredToQueue}
export const songRestore = ownerEndpoint("POST", async ({ db, body }) => withPlaying(db, fromOutcome(await restoreSong(db, body.videoId))));

// GET /api/owner/trash -> {songs:[{videoId,title,durationSec,deletedAt}]}
export const trash = ownerEndpoint("GET", async ({ db }) => ({ status: 200, body: { songs: await listTrash(db) } }));

// GET /api/owner/library -> {songs:[{videoId,title,durationSec,addedAt}]}
export const library = ownerEndpoint("GET", async ({ db }) => ({ status: 200, body: { songs: await listLibrary(db) } }));

// GET /api/owner/log?limit=50 -> {entries:[{id,who,what,at,details}]}, newest first, limit clamped to 1..500
export const log = ownerEndpoint("GET", async ({ db, url }) => {
  const asked = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(asked) ? Math.min(500, Math.max(1, asked)) : 50;
  return { status: 200, body: { entries: await readLog(db, limit) } };
});
