import type { Db } from "./db.ts";
import { fetchVideos, type VideoInfo } from "./youtube.ts";

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
    if (isQuotaError(error)) return refuse(503, "YouTube's daily limit is used up — try again tomorrow.");
    return refuse(502, "Couldn't reach YouTube. Try again in a moment.");
  }
  if (!info) return refuse(404, "YouTube has no public video with that link.");
  if (!info.embeddable) return refuse(422, "That video can't be played outside YouTube (embedding is blocked).");
  if (info.durationSec === null) return refuse(422, "YouTube didn't give a usable length for that video.");
  if (info.durationSec === 0) return refuse(422, "That video has no fixed length (live or upcoming), so it can't join the station.");
  return { ok: true, info: { ...info, durationSec: info.durationSec } };
}

export type Inserted = { ok: true } | { ok: false; status: number; message: string };

// Quota errors: match by name or HTTP 403 text so this merges cleanly with the QuotaExceededError class from the search branch.
const isQuotaError = (error: unknown): boolean => error instanceof Error && (error.name === "QuotaExceededError" || /HTTP 403/.test(error.message));

/**
 * Adds to the library and queue in one transaction; the station_state row lock (as in schedule.ts) serialises concurrent adds.
 * Mirrors the Mac rules (shared/station.ts): the song playing now is refused; a song already queued moves instead of duplicating.
 */
export async function insertSong(db: Db, info: PlayableVideo, position: Position): Promise<Inserted> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("insert into station_state (id) values (1) on conflict do nothing");
    const { rows } = await client.query("select current_video_id from station_state where id = 1 for update");
    if (rows[0]?.current_video_id === info.videoId) {
      await client.query("rollback");
      return { ok: false, status: 422, message: "That's playing right now." };
    }
    // TODO(controls branch): when songs gets deleted_at, also set deleted_at = null here so re-adding a trashed song restores it.
    await client.query(
      `insert into songs (video_id, title, duration_sec, metadata_refreshed_at) values ($1, $2, $3, now())
       on conflict (video_id) do update set title = excluded.title, duration_sec = excluded.duration_sec, metadata_refreshed_at = now()`,
      [info.videoId, info.title, info.durationSec],
    );
    await client.query("delete from queue where video_id = $1", [info.videoId]);
    const place = position === "next" ? "coalesce(min(position) - 1, 0)" : "coalesce(max(position) + 1, 0)";
    await client.query(`insert into queue (video_id, position) select $1::text, ${place} from queue`, [info.videoId]);
    await client.query("insert into activity_log (who, what, details) values ('owner', 'song_added', $1)", [
      { videoId: info.videoId, title: info.title, position },
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
