import { beforeEach, describe, expect, it } from "vitest";
import type { TrackRepo } from "../repo.ts";
import type { Track } from "../types.ts";

/** Behaviour every TrackRepo must share. `make` returns a fresh, empty repo. */
export function trackRepoContract(name: string, make: () => Promise<TrackRepo>): void {
  describe(`TrackRepo contract: ${name}`, () => {
    let repo: TrackRepo;
    beforeEach(async () => {
      repo = await make();
    });

    const track = (id: string, overrides: Partial<Track> = {}): Track => ({
      id,
      title: `Title ${id}`,
      artist: "Artist",
      album: null,
      durationSec: null,
      bitrate: null,
      format: null,
      sizeBytes: 1000,
      storageKey: `${id}.mp3`,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    });

    it("starts empty", async () => {
      expect(await repo.all()).toEqual([]);
    });

    it("round-trips every field, null and non-null", async () => {
      const full = track("full", {
        album: "Album",
        durationSec: 245,
        bitrate: 320000,
        format: "MPEG 1 Layer 3",
        sizeBytes: 5_000_000_000, // > 2^32: must survive bigint
        createdAt: "2026-07-01T12:34:56.789Z",
      });
      const sparse = track("sparse");
      await repo.add(full);
      await repo.add(sparse);
      expect(await repo.get("full")).toEqual(full);
      expect(await repo.get("sparse")).toEqual(sparse);
    });

    it("returns undefined for an unknown id", async () => {
      expect(await repo.get("nope")).toBeUndefined();
    });

    it("lists in insertion order, even when createdAt disagrees or ties", async () => {
      await repo.add(track("b", { createdAt: "2026-03-01T00:00:00.000Z" }));
      await repo.add(track("a", { createdAt: "2026-01-01T00:00:00.000Z" }));
      await repo.add(track("c", { createdAt: "2026-01-01T00:00:00.000Z" }));
      expect((await repo.all()).map((t) => t.id)).toEqual(["b", "a", "c"]);
    });

    it("remove returns the track and drops it", async () => {
      await repo.add(track("x"));
      await repo.add(track("y"));
      expect(await repo.remove("x")).toEqual(track("x"));
      expect(await repo.get("x")).toBeUndefined();
      expect((await repo.all()).map((t) => t.id)).toEqual(["y"]);
    });

    it("remove of an unknown id returns undefined and changes nothing", async () => {
      await repo.add(track("x"));
      expect(await repo.remove("nope")).toBeUndefined();
      expect((await repo.all()).map((t) => t.id)).toEqual(["x"]);
    });

    it("all() returns a copy the caller can't use to mutate the repo", async () => {
      await repo.add(track("x"));
      (await repo.all()).pop();
      expect(await repo.all()).toHaveLength(1);
    });
  });
}
