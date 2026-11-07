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

/** Delay before the next /api/now call: just after the song ends, else the 30s re-check. */
export function nextFetchDelayMs(p: NowPlaying, serverTime: number): number {
  const end = endsAt(p);
  if (end === null || hasEnded(p, serverTime)) return RECHECK_MS;
  return Math.min(RECHECK_MS, end - serverTime + END_GRACE_MS);
}
