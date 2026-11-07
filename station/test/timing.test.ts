import { describe, expect, it } from "vitest";
import type { NowPlaying } from "../lib/schedule.ts";
import { clockOffset, hasEnded, nextFetchDelayMs, RECHECK_MS } from "../src/listener/timing.ts";

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
  it("fetches just after the song ends, never later than 30s", () => {
    expect(nextFetchDelayMs(playing(0), 5_000)).toBe(15_000 + 300);
    expect(nextFetchDelayMs({ ...playing(0), current: { ...song, durationSec: 300 } }, 5_000)).toBe(RECHECK_MS);
  });
});
