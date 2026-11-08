import { describe, expect, it } from "vitest";
import { nextPauseState, planSync, type PauseEvent } from "../src/listener/syncPlan.ts";

const prev = { loadedVideoId: "a", syncedStartedAt: 1000, wasLocalStart: false };
const live = { listenerPaused: false, ended: false };
const paused = { listenerPaused: true, ended: false };
const same = { videoId: "a", startedAt: 1000, isLocalStart: false };

describe("planSync", () => {
  it("only checks drift when nothing changed", () => expect(planSync(prev, same, live)).toBe("drift"));
  it("a paused listener's pause stands when nothing changed", () => expect(planSync(prev, same, paused)).toBe("drift"));
  it("loads a new video at live", () => expect(planSync(prev, { ...same, videoId: "b" }, live)).toBe("load"));
  it("same video with a new start (repeat) loads at live", () => expect(planSync(prev, { ...same, startedAt: 2000 }, live)).toBe("load"));
  it("cues instead of playing when the listener paused", () => {
    expect(planSync(prev, { ...same, videoId: "b" }, paused)).toBe("cue");
    expect(planSync(prev, { ...same, startedAt: 2000 }, paused)).toBe("cue");
  });
  it("server catching up with a locally started song does not rewind the listener", () => {
    const local = { ...prev, wasLocalStart: true };
    expect(planSync(local, { ...same, startedAt: 2000 }, live)).toBe("none");
  });
  it("a local skip to a different video still loads", () => {
    expect(planSync(prev, { videoId: "b", startedAt: 5, isLocalStart: true }, live)).toBe("load");
  });
  it("a locally started song that already ended loads the live song", () => {
    const local = { ...prev, wasLocalStart: true };
    expect(planSync(local, { ...same, startedAt: 2000 }, { listenerPaused: false, ended: true })).toBe("load");
  });
  it("still cues on the next change after a cue (the pause is tracked, not read off the cued player)", () => {
    const afterCue = { loadedVideoId: "b", syncedStartedAt: 2000, wasLocalStart: false };
    expect(planSync(afterCue, { videoId: "c", startedAt: 3000, isLocalStart: false }, paused)).toBe("cue");
  });
});

const run = (events: PauseEvent[]) => events.reduce(nextPauseState, { listenerPaused: false, loading: false });

describe("nextPauseState", () => {
  it("a listener pause after PLAYING counts", () => expect(run(["playing", "paused"]).listenerPaused).toBe(true));
  it("YouTube's own PAUSED while swapping a video does not count", () => {
    expect(run(["playing", "load", "paused", "playing"]).listenerPaused).toBe(false);
  });
  it("an embed error right after YouTube's PAUSED leaves the listener unpaused", () => {
    expect(run(["playing", "load", "paused", "error"])).toEqual({ listenerPaused: false, loading: false });
  });
  it("a cue keeps the listener's pause through YouTube's PAUSED and CUED", () => {
    expect(run(["playing", "paused", "cue", "paused", "cued"])).toEqual({ listenerPaused: true, loading: false });
  });
  it("after a cue, the next song change still sees the pause", () => {
    expect(run(["playing", "paused", "cue", "cued"]).listenerPaused).toBe(true);
  });
});
