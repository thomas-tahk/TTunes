import type { NowPlaying } from "../../lib/schedule.ts";

export const RECHECK_MS = 30_000; // never poll faster than this
export const STALE_RETRY_MS = 1_500;
export const END_GRACE_MS = 300;
export const MAX_DRIFT_SEC = 2;

/** offset = serverNow + RTT/2 - clientReceive, so serverTime = clientTime + offset. */
export function clockOffset(sample: { serverNow: number; sentAt: number; receivedAt: number }): number {
  const rtt = sample.receivedAt - sample.sentAt;
  return sample.serverNow + rtt / 2 - sample.receivedAt;
}

export const endsAt = (p: NowPlaying): number | null =>
  p.current && p.startedAt !== null ? p.startedAt + p.current.durationSec * 1000 : null;

export function hasEnded(p: NowPlaying, serverTime: number): boolean {
  const end = endsAt(p);
  return end === null || serverTime >= end;
}

/** The 30s re-check and song-end fetches run only while someone is actually listening: Play clicked and not paused. A forgotten tab must not keep the DB awake. */
export const shouldPoll = (s: { started: boolean; paused: boolean }): boolean => s.started && !s.paused;

export const FRESH_MS = 5_000; // a response this young needs no refetch on resume; the player flips pause/play while it loads each song

/** On Play or unpause: refetch to rejoin live, unless the last response is only seconds old (then just keep its schedule). */
export const refetchOnResume = (sinceLastFetchMs: number): boolean => sinceLastFetchMs >= FRESH_MS;

export const MAX_STALE_RETRIES = 3;

export interface FetchPlanIo {
  serverTime: () => number;
  remeasure: () => Promise<void>; // re-measures the clock offset
}

/** When to ask again. A response that looks ended may mean our clock is off: re-measure, retry up to 3 times, then settle to the 30s re-check. */
export async function planNextFetch(p: NowPlaying, io: FetchPlanIo, staleRetries: number): Promise<{ delayMs: number; staleRetries: number }> {
  const stale = () => p.current !== null && hasEnded(p, io.serverTime());
  const settled = () => ({ delayMs: nextFetchDelayMs(p, io.serverTime()), staleRetries: 0 });
  if (!stale()) return settled();
  await io.remeasure(); // also once per 30s re-check after the retries are used up, so a recovered /api/time un-sticks the page
  if (!stale()) return settled();
  if (staleRetries >= MAX_STALE_RETRIES) return { delayMs: RECHECK_MS, staleRetries };
  return { delayMs: STALE_RETRY_MS, staleRetries: staleRetries + 1 };
}

/** Delay before the next /api/now call: just after the song ends, else the 30s re-check. */
export function nextFetchDelayMs(p: NowPlaying, serverTime: number): number {
  const end = endsAt(p);
  if (end === null || hasEnded(p, serverTime)) return RECHECK_MS;
  return Math.min(RECHECK_MS, end - serverTime + END_GRACE_MS);
}
