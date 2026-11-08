import { describe, expect, it } from "vitest";
import { planSync } from "../src/listener/syncPlan.ts";

const prev = { loadedVideoId: "a", syncedStartedAt: 1000, wasLocalStart: false };
const same = { videoId: "a", startedAt: 1000, isLocalStart: false };

describe("planSync", () => {
  it("only checks drift when nothing changed", () => expect(planSync(prev, same, false)).toBe("drift"));
  it("a paused listener's pause stands when nothing changed", () => expect(planSync(prev, same, true)).toBe("drift"));
  it("loads a new video at live", () => expect(planSync(prev, { ...same, videoId: "b" }, false)).toBe("load"));
  it("same video with a new start (repeat) loads at live", () => expect(planSync(prev, { ...same, startedAt: 2000 }, false)).toBe("load"));
  it("cues instead of playing when the listener paused", () => {
    expect(planSync(prev, { ...same, videoId: "b" }, true)).toBe("cue");
    expect(planSync(prev, { ...same, startedAt: 2000 }, true)).toBe("cue");
  });
  it("server catching up with a locally started song does not rewind the listener", () => {
    const local = { ...prev, wasLocalStart: true };
    expect(planSync(local, { ...same, startedAt: 2000 }, false)).toBe("none");
  });
  it("a local skip to a different video still loads", () => {
    expect(planSync(prev, { videoId: "b", startedAt: 5, isLocalStart: true }, false)).toBe("load");
  });
});
