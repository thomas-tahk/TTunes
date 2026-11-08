import { describe, expect, it } from "vitest";
import { restoreNote } from "../src/listener/ownerFetch.ts";
import { createStaleGuard, doneNote, withAllWaiting } from "../src/listener/ownerRequestsLogic.ts";
import type { FeedItem } from "../src/listener/useRequests.ts";

const item = (id: number): FeedItem => ({ id, name: `n${id}`, dedication: null, videoId: "v", title: "t", durationSec: 1, thumbnail: "", status: "waiting", createdAt: "" });

describe("withAllWaiting", () => {
  it("pins waiting requests missing from the newest-30 list above it, without duplicates", () => {
    const requests = [item(40), item(39), item(5)];
    const merged = withAllWaiting(requests, [item(5), item(2)]);
    expect(merged.map((r) => r.id)).toEqual([2, 40, 39, 5]);
  });
});

describe("createStaleGuard", () => {
  it("a load started before an action is stale; one started after is fresh", () => {
    const guard = createStaleGuard();
    const early = guard.startLoad();
    guard.actionStarted();
    const late = guard.startLoad();
    expect(early()).toBe(false);
    expect(late()).toBe(true);
  });
});

describe("doneNote", () => {
  it("remove says it will not play only when the request had not played yet", () => {
    expect(doneNote("remove", "queued")).toBe("Removed. It will not play.");
    expect(doneNote("remove", "waiting")).toBe("Removed. It will not play.");
    expect(doneNote("remove", "played")).toBe("Removed from the feed.");
    expect(doneNote("remove", "playing")).toBe("Removed from the feed.");
    expect(doneNote("remove", undefined)).toBe("Removed from the feed.");
    expect(doneNote("keep", "played")).toBe("Added to the library.");
  });
});

describe("restoreNote", () => {
  it("shows the server's message when the song was not re-queued, else the plain confirmation", () => {
    const message = "Restored to the library, but not re-queued: it is already coming up as a request.";
    expect(restoreNote("Song", { restoredToQueue: 0, message })).toBe(message);
    expect(restoreNote("Song", { restoredToQueue: 2 })).toBe('Restored "Song".');
    expect(restoreNote("Song", { restoredToQueue: 0 })).toBe('Restored "Song".');
  });
});
