import type pg from "pg";
import { fetchVideos } from "./youtube.ts";

type Queryable = Pick<pg.ClientBase, "query">;

export const SYSTEM_ACTOR = "system:age-gate";
export const AGE_CHECK_TIMEOUT_MS = 2000; // a hung YouTube call must not hold the station lock or cause dead air
export const MAX_DENIALS_PER_ADVANCE = 10; // a pile of restricted requests cannot hold the lock forever

/**
 * Runs inside the advance transaction, under the station lock: only the winning poller calls YouTube, and the head request that is
 * checked is the exact one that then plays. A queued request YouTube marks age-restricted is denied (logged) instead of played; one
 * videos.list per check. If YouTube fails or takes over 2s, the error is logged and the request plays (an outage must not silence
 * the station). Returns "capped" when the denial limit was hit: the caller must then skip requests and fall through to the owner queue.
 */
export async function denyAgeRestrictedHeads(q: Queryable, now: number): Promise<"clear" | "capped"> {
  for (let i = 0; i < MAX_DENIALS_PER_ADVANCE; i++) {
    const { rows } = await q.query("select id, video_id from requests where status = 'queued' order by queued_at, id limit 1");
    if (!rows[0]) return "clear";
    const videoId: string = rows[0].video_id;
    try {
      const infos = await fetchVideos([videoId], { signal: AbortSignal.timeout(AGE_CHECK_TIMEOUT_MS) });
      if (!infos.get(videoId)?.ageRestricted) return "clear";
    } catch (error) {
      console.error("age check before play failed; playing anyway", error instanceof Error ? error.message : error);
      return "clear";
    }
    await q.query("update requests set status = 'denied', decided_at = $2 where id = $1", [rows[0].id, new Date(now)]);
    await q.query("insert into activity_log (who, what, details) values ($1, 'request_age_restricted', $2)", [SYSTEM_ACTOR, { id: Number(rows[0].id), videoId }]);
  }
  return "capped";
}
