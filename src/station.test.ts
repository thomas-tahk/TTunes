import { describe, expect, it } from "vitest";
import { advance, sync, emptyStation, enqueue, peekNext, playNow, type Station } from "./station.ts";

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
    const queued = enqueue(sync(emptyStation(), ["a", "gone"], noShuffle), "gone", "last");
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

  it("keeps a queued id that has not appeared in the library yet", () => {
    const loaded = sync(emptyStation(), ["a", "b"], noShuffle);
    const queued = enqueue(loaded, "new", "last");
    expect(sync(queued, ["a", "b"], noShuffle).queue).toEqual(["new"]);
  });

  it("drops a queued id once it was listed and then deleted", () => {
    const queued = enqueue(sync(emptyStation(), ["a", "b"], noShuffle), "b", "last");
    expect(sync(queued, ["a"], noShuffle).queue).toEqual([]);
  });

  it("clears the current track when the library empties", () => {
    const playing = playNow(sync(emptyStation(), ["a"], noShuffle), "a");
    expect(sync(playing, [], noShuffle).current).toBeNull();
  });

  it("every cycle is a full permutation with no back-to-back repeat across cycles (seeded)", () => {
    const library = ["a", "b", "c", "d", "e"];
    const { ids } = takeWith(emptyStation(), library, 20, seeded(42));
    for (let c = 0; c < 4; c++) expect(new Set(ids.slice(c * 5, c * 5 + 5)).size).toBe(5);
    ids.slice(1).forEach((id, i) => expect(id).not.toBe(ids[i]));
  });
});

function seeded(seed: number): () => number {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function takeWith(start: Station, library: string[], count: number, random: () => number) {
  let station = start;
  const ids: (string | null)[] = [];
  for (let i = 0; i < count; i++) {
    const step = advance(station, library, random);
    ids.push(step.id);
    station = step.station;
  }
  return { ids, station };
}
