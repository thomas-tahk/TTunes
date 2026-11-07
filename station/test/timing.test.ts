import { describe, expect, it } from "vitest";
import type { NowPlaying } from "../lib/schedule.ts";
import { clockOffset, FRESH_MS, refetchOnResume, hasEnded, MAX_STALE_RETRIES, nextFetchDelayMs, planNextFetch, RECHECK_MS, shouldPoll } from "../src/listener/timing.ts";

const song = { videoId: "a", title: "A", durationSec: 20 };
const playing = (startedAt: number): NowPlaying => ({ current: song, startedAt, next: null, serverNow: startedAt });

describe("listener timing", () => {
  it("offset = serverNow + RTT/2 - clientReceive", () => {
    expect(clockOffset({ serverNow: 10_000, sentAt: 1_000, receivedAt: 1_200 })).toBe(10_000 + 100 - 1_200);
  });
  it("detects a song that already ended", () => {
    expect(hasEnded(playing(0), 19_999)).toBe(false);
    expect(hasEnded(playing(0), 20_000)).toBe(true);
  });
  it("still re-measures the clock on the capped path, so a device whose /api/time recovered is not stuck", async () => {
    let offset = 100_000; // clock far ahead: every song looks ended
    let measures = 0;
    const io = { serverTime: () => 5_000 + offset, remeasure: async () => { measures++; offset = measures >= 2 ? 0 : offset; } }; // /api/time works from the 2nd call
    const first = await planNextFetch(playing(0), io, MAX_STALE_RETRIES);
    expect(first).toEqual({ delayMs: RECHECK_MS, staleRetries: MAX_STALE_RETRIES });
    expect(measures).toBe(1);
    const second = await planNextFetch(playing(0), io, first.staleRetries);
    expect(measures).toBe(2);
    expect(second).toEqual({ delayMs: 15_000 + 300, staleRetries: 0 }); // recovered on this very check, not one cycle later
  });
  it("fetches just after the song ends, never later than 30s", () => {
    expect(nextFetchDelayMs(playing(0), 5_000)).toBe(15_000 + 300);
    expect(nextFetchDelayMs({ ...playing(0), current: { ...song, durationSec: 300 } }, 5_000)).toBe(RECHECK_MS);
  });
});

describe("polling decision", () => {
  it("refetches on resume unless the last response is only seconds old", () => {
    expect(refetchOnResume(FRESH_MS - 1)).toBe(false);
    expect(refetchOnResume(FRESH_MS)).toBe(true);
    expect(refetchOnResume(10 * 60_000)).toBe(true);
  });
  it("never polls before Play is clicked", () => {
    expect(shouldPoll({ started: false, paused: false })).toBe(false);
  });
  it("polls while playing", () => {
    expect(shouldPoll({ started: true, paused: false })).toBe(true);
  });
  it("keeps polling on an owner tab that never pressed Play or is paused", () => {
    expect(shouldPoll({ started: false, paused: false, owner: true })).toBe(true);
    expect(shouldPoll({ started: true, paused: true, owner: true })).toBe(true);
  });
  it("stops while paused, including a hidden paused tab", () => {
    expect(shouldPoll({ started: true, paused: true })).toBe(false);
  });
});
