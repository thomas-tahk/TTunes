import { describe, expect, it } from "vitest";
import type { NowPlaying, Song } from "../lib/schedule.ts";
import { activeSkip, resolveTarget, skipUnplayable } from "../src/listener/skip.ts";
import { MAX_STALE_RETRIES, planNextFetch, RECHECK_MS, STALE_RETRY_MS } from "../src/listener/timing.ts";

const bad: Song = { videoId: "bad", title: "Bad", durationSec: 100 };
const good: Song = { videoId: "good", title: "Good", durationSec: 100 };
const round = (current: Song, next: Song, startedAt: number): NowPlaying => ({ current, next, startedAt, serverNow: startedAt });

describe("local skip after an embed error", () => {
  it("moves to the next song from its start and shows the notice", () => {
    const p = round(bad, good, 0);
    const skip = skipUnplayable(p, null, 5_000);
    expect(resolveTarget(p, skip)).toEqual({ song: good, startedAt: 5_000 });
    expect(activeSkip(p, skip)?.skippedTitle).toBe("Bad");
  });

  it("does not chain when the error comes from the song already skipped to", () => {
    const p = round(bad, good, 0);
    const skip = skipUnplayable(p, null, 5_000);
    expect(skipUnplayable(p, skip, 9_000)).toBe(skip);
  });

  it("is forgotten when the same bad song comes round again", () => {
    const skip = skipUnplayable(round(bad, good, 0), null, 5_000);
    const secondRound = round(bad, good, 400_000); // same video id, new start
    expect(resolveTarget(secondRound, skip)).toEqual({ song: bad, startedAt: 400_000 });
    expect(activeSkip(secondRound, skip)).toBeNull(); // notice clears
  });

  it("is forgotten once the server moves on", () => {
    const skip = skipUnplayable(round(bad, good, 0), null, 5_000);
    const later = round(good, bad, 100_000);
    expect(activeSkip(later, skip)).toBeNull();
    expect(resolveTarget(later, skip).song).toBe(good);
  });
});

describe("stale responses", () => {
  const ended = round(good, bad, 0); // ended at 100_000
  const io = (now: number, onRemeasure = () => {}) => ({ serverTime: () => now, remeasure: async () => onRemeasure() });

  it("retries at most 3 times, then falls back to the 30s re-check", async () => {
    let retries = 0;
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const plan = await planNextFetch(ended, io(500_000), retries);
      retries = plan.staleRetries;
      delays.push(plan.delayMs);
    }
    expect(delays).toEqual([...Array(MAX_STALE_RETRIES).fill(STALE_RETRY_MS), RECHECK_MS, RECHECK_MS, RECHECK_MS]);
  });

  it("re-measures the clock instead of polling when the offset was the problem", async () => {
    let now = 120_000; // skewed clock says the song ended
    const plan = await planNextFetch(ended, { serverTime: () => now, remeasure: async () => void (now = 40_000) }, 0);
    expect(plan.staleRetries).toBe(0);
    expect(plan.delayMs).toBe(RECHECK_MS);
  });

  it("settles to normal timing once a response is fresh", async () => {
    const plan = await planNextFetch(ended, io(50_000), 2);
    expect(plan).toEqual({ delayMs: RECHECK_MS, staleRetries: 0 });
  });
});
