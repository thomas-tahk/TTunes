import type { Db } from "./db.ts";
import { fetchVideos, type VideoInfo } from "./youtube.ts";

export const STALE_AFTER_DAYS = 25; // YouTube's cap is 30 days
export const KEEP_EXPORTS = 14;
export const SYSTEM_ACTOR = "system:upkeep";

export interface RefreshResult {
  checked: number;
  refreshed: number;
  removed: { videoId: string; title: string; reason: string }[];
}

type Stale = { video_id: string; title: string };

function removalReason(info: VideoInfo | undefined): string | null {
  if (!info) return "no longer exists on YouTube";
  if (!info.embeddable) return "no longer embeddable";
  if (info.durationSec <= 0) return "no playable duration (live or upcoming)";
  return null;
}

async function removeSong(db: Db, song: Stale, reason: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("delete from songs where video_id = $1", [song.video_id]); // queue rows cascade
    await client.query("insert into activity_log (who, what, details) values ($1, 'song_removed', $2)", [
      SYSTEM_ACTOR,
      { videoId: song.video_id, title: song.title, reason },
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Refreshes metadata older than 25 days; removes songs YouTube no longer returns or allows embedding. */
export async function refreshStale(db: Db): Promise<RefreshResult> {
  const { rows } = await db.query<Stale>(
    "select video_id, title from songs where metadata_refreshed_at < now() - make_interval(days => $1) order by video_id",
    [STALE_AFTER_DAYS],
  );
  const result: RefreshResult = { checked: rows.length, refreshed: 0, removed: [] };
  const infos = await fetchVideos(rows.map((r) => r.video_id)); // throws before any change if YouTube is down
  for (const song of rows) {
    const info = infos.get(song.video_id);
    const reason = removalReason(info);
    if (reason) {
      await removeSong(db, song, reason);
      result.removed.push({ videoId: song.video_id, title: song.title, reason });
      continue;
    }
    await db.query("update songs set title = $2, duration_sec = $3, metadata_refreshed_at = now() where video_id = $1", [
      song.video_id,
      info!.title,
      info!.durationSec,
    ]);
    result.refreshed++;
  }
  return result;
}

export interface LibrarySong {
  videoId: string;
  title: string;
  durationSec: number;
  addedAt: string;
  metadataRefreshedAt: string;
}

export interface LibraryExport {
  exportedAt: string;
  songs: LibrarySong[];
}

export async function exportLibrary(db: Db): Promise<LibraryExport> {
  const { rows } = await db.query("select video_id, title, duration_sec, added_at, metadata_refreshed_at from songs order by added_at, video_id");
  return {
    exportedAt: new Date().toISOString(),
    songs: rows.map((r) => ({
      videoId: r.video_id,
      title: r.title,
      durationSec: r.duration_sec,
      addedAt: r.added_at.toISOString(),
      metadataRefreshedAt: r.metadata_refreshed_at.toISOString(),
    })),
  };
}

/** Stores today's export, keeps only the newest 14, returns how many songs it holds. */
export async function storeExport(db: Db): Promise<number> {
  const data = await exportLibrary(db);
  await db.query("insert into library_exports (data) values ($1)", [data]);
  await db.query("delete from library_exports where id not in (select id from library_exports order by id desc limit $1)", [KEEP_EXPORTS]);
  return data.songs.length;
}
