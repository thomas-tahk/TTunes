import type { Db } from "./db.ts";
import { lockStation } from "./lock.ts";
import { fetchVideos } from "./youtube.ts";

export const SYSTEM_ACTOR = "system:age-gate";
const MAX_DENIALS_PER_ADVANCE = 10; // a pile of restricted requests cannot stall one poll forever

async function headRequest(db: Db): Promise<{ id: number; videoId: string } | null> {
  const { rows } = await db.query("select id, video_id from requests where status = 'queued' order by queued_at, id limit 1");
  return rows[0] ? { id: Number(rows[0].id), videoId: rows[0].video_id } : null;
}

async function denyRequest(db: Db, id: number, videoId: string, now: number): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await lockStation(client);
    const { rowCount } = await client.query("update requests set status = 'denied', decided_at = $2 where id = $1 and status = 'queued'", [id, new Date(now)]);
    if (rowCount) await client.query("insert into activity_log (who, what, details) values ($1, 'request_age_restricted', $2)", [SYSTEM_ACTOR, { id, videoId }]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Before the station moves on: a queued request that YouTube now marks age-restricted (e.g. queued before the filter, or the video
 * was rated later) is denied instead of played. One videos.list per check. If YouTube cannot be reached the request plays anyway
 * (an outage must not silence the station); the error is logged.
 */
export async function denyAgeRestrictedHeads(db: Db, clock: () => number): Promise<void> {
  for (let i = 0; i < MAX_DENIALS_PER_ADVANCE; i++) {
    const head = await headRequest(db);
    if (!head) return;
    try {
      if (!(await fetchVideos([head.videoId])).get(head.videoId)?.ageRestricted) return;
    } catch (error) {
      console.error("age check before play failed; playing anyway", error instanceof Error ? error.message : error);
      return;
    }
    await denyRequest(db, head.id, head.videoId, clock());
  }
}
