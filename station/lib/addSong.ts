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
    return refuse(502, "Couldn't reach YouTube. Try again in a moment.");
  }
  if (!info) return refuse(404, "YouTube has no public video with that link.");
  if (!info.embeddable) return refuse(422, "That video can't be played outside YouTube (embedding is blocked).");
  if (!info.durationSec) return refuse(422, "That video has no fixed length (live or upcoming), so it can't join the station.");
  return { ok: true, info: { ...info, durationSec: info.durationSec } };
}

/** Adds to the library and queue in one transaction; the station_state row lock (as in schedule.ts) serialises concurrent adds. */
export async function insertSong(db: Db, info: PlayableVideo, position: Position): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("insert into station_state (id) values (1) on conflict do nothing");
    await client.query("select 1 from station_state where id = 1 for update");
    await client.query(
      `insert into songs (video_id, title, duration_sec, metadata_refreshed_at) values ($1, $2, $3, now())
       on conflict (video_id) do update set title = excluded.title, duration_sec = excluded.duration_sec, metadata_refreshed_at = now()`,
      [info.videoId, info.title, info.durationSec],
    );
    // "next": an id below the current head sorts first (the queue is read in id order).
    const id = position === "next" ? "coalesce((select min(id) - 1 from queue), nextval('queue_id_seq'))" : "nextval('queue_id_seq')";
    await client.query(`insert into queue (id, video_id) values (${id}, $1)`, [info.videoId]);
    await client.query("insert into activity_log (who, what, details) values ('owner', 'song_added', $1)", [
      { videoId: info.videoId, title: info.title, position },
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
