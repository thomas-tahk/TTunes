import { describe, expect, it } from "vitest";
import { addMany, advance, sync, emptyStation, peekNext, playNow, queueLast, type Station } from "./station.ts";

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

// Queue at the tail behind some already-playing track, so addMany doesn't start playback.
const queueBehindPlaying = (station: Station, id: string) =>
  addMany(station.current ? station : playNow(station, "playing"), [id], "last");

describe("station", () => {
  it("plays the queued track first, then falls through to the shuffle", () => {
    const queued = queueBehindPlaying(emptyStation(), "a");
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
    const queued = queueBehindPlaying(sync(emptyStation(), ["a", "gone"], noShuffle), "gone");
    expect(take(queued, ["a"], 1).ids).toEqual(["a"]);
  });

  it("returns null for an empty library", () => {
    expect(advance(emptyStation(), [], noShuffle).id).toBeNull();
  });

  it("never drops queued tracks (no cap)", () => {
    let station = emptyStation();
    for (const id of "abcdefghij") station = queueBehindPlaying(station, id);
    expect(station.queue).toHaveLength(10);
  });

  it("peekNext reports the queue head first", () => {
    const station = addMany(playNow(emptyStation(), "a"), ["b"], "last");
    expect(peekNext(station, ["a", "b", "c"])).toBe("b");
  });

  it("keeps a queued id that has not appeared in the library yet", () => {
    const loaded = sync(emptyStation(), ["a", "b"], noShuffle);
    const queued = queueBehindPlaying(loaded, "new");
    expect(sync(queued, ["a", "b"], noShuffle).queue).toEqual(["new"]);
  });

  it("drops a queued id once it was listed and then deleted", () => {
    const queued = queueBehindPlaying(sync(emptyStation(), ["a", "b"], noShuffle), "b");
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

describe("addMany", () => {
  const idle = { ...emptyStation(), queue: ["x"] };
  const playing = { ...playNow(emptyStation(), "p"), queue: ["x"] };

  it.each(["now", "next", "last"] as const)("idle + %s: first plays, rest queue in order", (choice) => {
    const out = addMany(idle, ["a", "b", "c"], choice);
    expect(out.current).toBe("a");
    expect(out.queue).toEqual(["b", "c", "x"]);
  });

  it("playing + now: first plays, rest queue next in order", () => {
    const out = addMany(playing, ["a", "b", "c"], "now");
    expect(out.current).toBe("a");
    expect(out.queue).toEqual(["b", "c", "x"]);
  });

  it("playing + next: all at queue head in drop order", () => {
    const out = addMany(playing, ["a", "b", "c"], "next");
    expect(out.current).toBe("p");
    expect(out.queue).toEqual(["a", "b", "c", "x"]);
  });

  it("playing + last: all at tail in drop order", () => {
    expect(addMany(playing, ["a", "b", "c"], "last").queue).toEqual(["x", "a", "b", "c"]);
  });

  it("does not queue the id that is already current", () => {
    expect(addMany(playing, ["p", "a"], "next").queue).toEqual(["a", "x"]);
  });

  it("queueLast queues the current track again behind the queue", () => {
    const playing = addMany(playNow(emptyStation(), "a"), ["b"], "last");
    expect(queueLast(playing, "a").queue).toEqual(["b", "a"]);
  });

  it("queueLast moves an already-queued id to the tail instead of duplicating", () => {
    const queued = addMany(playNow(emptyStation(), "p"), ["a", "b"], "last");
    expect(queueLast(queued, "a").queue).toEqual(["b", "a"]);
  });

  it("addMany from a fresh add still never duplicates the current track", () => {
    expect(addMany(playNow(emptyStation(), "a"), ["a"], "last").queue).toEqual([]);
  });
});
