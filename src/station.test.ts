import { describe, expect, it } from "vitest";
import { advance, emptyStation, enqueue, peekNext, playNow, type Station } from "./station.ts";

const noShuffle = () => 0.999; // Fisher-Yates with this keeps order unchanged

function take(start: Station, library: string[], count: number) {
  let station = start;
  const ids: (string | null)[] = [];
  for (let i = 0; i < count; i++) {
    const step = advance(station, library, noShuffle);
    ids.push(step.id);
    station = step.station;
  }
  return { ids, station };
}

describe("station", () => {
  it("plays the queued track first, then falls through to the shuffle", () => {
    const queued = enqueue(emptyStation(), "a", "last");
    const { ids } = take(queued, ["a", "b", "c"], 2);
    expect(ids[0]).toBe("a");
    expect(["b", "c"]).toContain(ids[1]);
  });

  it("plays a track added mid-cycle before any repeat", () => {
    const first = take(emptyStation(), ["a", "b"], 1);
    const { ids } = take(first.station, ["a", "b", "z"], 1);
    expect(ids[0]).toBe("z");
  });

  it("does not repeat within a cycle of 3", () => {
    const { ids } = take(emptyStation(), ["a", "b", "c"], 3);
    expect(new Set(ids).size).toBe(3);
  });

  it("starts a new cycle without repeating the current track back-to-back", () => {
    const { ids } = take(emptyStation(), ["a", "b", "c"], 4);
    expect(ids[3]).not.toBe(ids[2]);
  });

  it("never plays a deleted track", () => {
    const first = take(emptyStation(), ["a", "b", "c"], 1);
    const { ids } = take(first.station, ["a", "c"], 6);
    expect(ids).not.toContain("b");
  });

  it("drops a deleted queued track", () => {
    const queued = enqueue(emptyStation(), "gone", "last");
    expect(take(queued, ["a"], 1).ids).toEqual(["a"]);
  });

  it("returns null for an empty library", () => {
    expect(advance(emptyStation(), [], noShuffle).id).toBeNull();
  });

  it("never drops queued tracks (no cap)", () => {
    let station = emptyStation();
    for (const id of "abcdefghij") station = enqueue(station, id, "last");
    expect(station.queue).toHaveLength(10);
  });

  it("peekNext reports the queue head first", () => {
    const station = enqueue(playNow(emptyStation(), "a"), "b", "last");
    expect(peekNext(station, ["a", "b", "c"])).toBe("b");
  });
});
