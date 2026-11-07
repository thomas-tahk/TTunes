import { describe, expect, it } from "vitest";
import { createStaleGuard, withAllWaiting } from "../src/listener/ownerRequestsLogic.ts";
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
