import type pg from "pg";
import type { Db } from "./db.ts";
import { lockStation } from "./lock.ts";
import { fetchVideos, QuotaExceededError, type VideoInfo } from "./youtube.ts";

type Queryable = Pick<pg.ClientBase, "query">;

export const LONG_SEC = 15 * 60;
export type Position = "next" | "queue";
export type PlayableVideo = VideoInfo & { durationSec: number };

export const thumbnailOf = (videoId: string): string => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

export type Lookup = { ok: true; info: PlayableVideo } | { ok: false; status: number; message: string };

const refuse = (status: number, message: string): Lookup => ({ ok: false, status, message });

/** Fresh metadata from YouTube, or a plain-language refusal. */
export async function lookupVideo(videoId: string): Promise<Lookup> {
  let info: VideoInfo | undefined;
  try {
    info = (await fetchVideos([videoId])).get(videoId);
  } catch (error) {
    console.error("YouTube lookup failed", error);
    if (error instanceof QuotaExceededError) {
      return refuse(503, error.reason === "quotaExceeded" ? "YouTube's daily limit is used up — try again tomorrow." : "YouTube is busy — try again shortly.");
    }
    return refuse(502, "Couldn't reach YouTube. Try again in a moment.");
  }
  if (!info) return refuse(404, "YouTube has no public video with that link.");
  if (!info.embeddable) return refuse(422, "That video can't be played outside YouTube (embedding is blocked).");
  if (info.durationSec === null) return refuse(422, "YouTube didn't give a usable length for that video.");
  if (info.durationSec === 0) return refuse(422, "That video has no fixed length (live or upcoming), so it can't join the station.");
  return { ok: true, info: { ...info, durationSec: info.durationSec } };
}

export type Inserted = { ok: true } | { ok: false; status: number; message: string };

/**
 * Adds to the library and queue in one transaction; the station_state row lock (as in schedule.ts) serialises concurrent adds.
 * Mirrors the Mac rules (shared/station.ts): the song playing now is refused; a song already queued moves instead of duplicating.
 */
export async function insertSong(db: Db, info: PlayableVideo, position: Position): Promise<Inserted> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const trashed = (await client.query("select 1 from songs where video_id = $1 and deleted_at is not null", [info.videoId])).rowCount === 1;
    const { rows } = await client.query("select current_video_id from station_state where id = 1");
    if (rows[0]?.current_video_id === info.videoId) {
      if (!trashed) {
        await client.query("rollback");
        return { ok: false, status: 422, message: "That's playing right now." };
      }
      // Trashed while playing: re-adding still restores it to the library; it just isn't queued behind itself.
      await client.query("update songs set deleted_at = null where video_id = $1", [info.videoId]);
      await client.query("delete from trash_queue where video_id = $1", [info.videoId]);
      await client.query("insert into activity_log (who, what, details) values ('owner', 'song_added', $1)", [
        { videoId: info.videoId, position, restoredFromTrash: true, playingNow: true },
      ]);
      await client.query("commit");
      return { ok: true };
    }
    if ((await client.query("select 1 from requests where video_id = $1 and status in ('queued', 'playing')", [info.videoId])).rowCount) {
      await client.query("rollback");
      return { ok: false, status: 422, message: "That song is already coming up as a request." };
    }
    await client.query(
      `insert into songs (video_id, title, duration_sec, metadata_refreshed_at) values ($1, $2, $3, now())
       on conflict (video_id) do update set title = excluded.title, duration_sec = excluded.duration_sec, metadata_refreshed_at = now(), deleted_at = null`,
      [info.videoId, info.title, info.durationSec],
    );
    await client.query("delete from trash_queue where video_id = $1", [info.videoId]); // re-adding a trashed song is its restore
    await client.query("delete from queue where video_id = $1", [info.videoId]);
    const place = position === "next" ? "coalesce(min(position) - 1, 0)" : "coalesce(max(position) + 1, 0)";
    await client.query(`insert into queue (video_id, position) select $1::text, ${place} from queue`, [info.videoId]);
    await client.query("insert into activity_log (who, what, details) values ('owner', 'song_added', $1)", [
      { videoId: info.videoId, position, ...(trashed ? { restoredFromTrash: true } : {}) },
    ]);
    await client.query("commit");
    return { ok: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Library-only add (Keep), on the caller's client: no commit, no queue change, no YouTube call. The caller holds the station lock.
 * Idempotent: a live library song is left alone (false); a trashed one is restored. Returns whether the library changed. */
export async function addToLibrary(client: Queryable, info: PlayableVideo): Promise<boolean> {
  const { rows: existing } = await client.query("select deleted_at from songs where video_id = $1", [info.videoId]);
  if (existing[0] && existing[0].deleted_at === null) return false;
  const trashed = existing.length === 1;
  await client.query(
    `insert into songs (video_id, title, duration_sec, metadata_refreshed_at) values ($1, $2, $3, now())
     on conflict (video_id) do update set title = excluded.title, duration_sec = excluded.duration_sec, metadata_refreshed_at = now(), deleted_at = null`,
    [info.videoId, info.title, info.durationSec],
  );
  await client.query("delete from trash_queue where video_id = $1", [info.videoId]);
  await client.query("insert into activity_log (who, what, details) values ('owner', 'song_added', $1)", [{ videoId: info.videoId, position: "library", ...(trashed ? { restoredFromTrash: true } : {}) }]);
  return true;
}
