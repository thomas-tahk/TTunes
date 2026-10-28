import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app.ts";
import type { TrackRepo } from "../repo.ts";
import { defaultStation, type StationRepo, type StationState } from "../station-repo.ts";
import type { StationOptions } from "../station.ts";
import { LocalDiskStorage } from "../storage.ts";
import type { Track } from "../types.ts";

export interface StationBackend {
  tracks: TrackRepo;
  station: StationRepo;
}

export interface StationFixture extends StationBackend {
  /** Fresh repo instances on the same store, as after a server restart. */
  reopen(): Promise<StationBackend>;
}

/**
 * Behaviour every StationRepo must share, at the repo level and through the HTTP API.
 * `make` returns an empty catalog and a default station.
 */
export function stationContract(name: string, make: () => Promise<StationFixture>): void {
  // One describe around everything, so these hooks never reach the caller's other tests.
  describe(`station: ${name}`, () => {
    const track = (id: string, overrides: Partial<Track> = {}): Track => ({
      id,
      title: `Title ${id}`,
      artist: "Artist",
      album: null,
      durationSec: 200,
      bitrate: null,
      format: null,
      sizeBytes: 1000,
      storageKey: `${id}.mp3`,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    });

    let fx: StationFixture;
    const roots: string[] = [];
    beforeEach(async () => {
      fx = await make();
    });
    afterEach(() => {
      for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    });

    /** An app over the given backend; `clock.t` is the station's "now" in ms. */
    const appFor = (b: StationBackend, opts: StationOptions = {}): Express => {
      const root = mkdtempSync(join(tmpdir(), "ttunes-station-"));
      roots.push(root);
      return createApp({
        repo: b.tracks,
        station: b.station,
        storage: new LocalDiskStorage(join(root, "storage")),
        uploadDir: join(root, "incoming"),
        stationOptions: opts,
      });
    };
    const T0 = Date.parse("2026-10-01T12:00:00.000Z");
    const fakeClock = () => {
      const clock = { t: T0 };
      return { clock, opts: { now: () => clock.t } };
    };
    const ids = (ts: { id: string }[]) => ts.map((t) => t.id);

    describe(`StationRepo contract: ${name}`, () => {
      it("starts with the default station", async () => {
        expect(await fx.station.get()).toEqual(defaultStation());
      });

      it("update persists the returned state; null changes nothing", async () => {
        await fx.tracks.add(track("a"));
        await fx.tracks.add(track("b"));
        const s: StationState = {
          activePool: { kind: "library" },
          nowPlaying: { trackId: "a", offsetSec: 12.25, reportedAt: "2026-10-01T12:00:00.000Z", playing: true },
          queue: ["b", "a", "b"],
          upNext: "b",
        };
        expect(await fx.station.update(() => s)).toEqual(s);
        expect(await fx.station.get()).toEqual(s);
        expect(await fx.station.update(() => null)).toEqual(s);
        expect(await fx.station.get()).toEqual(s);
      });

      it("a throwing update writes nothing", async () => {
        await fx.tracks.add(track("a"));
        await expect(
          fx.station.update((cur) => {
            cur.queue.push("a");
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await fx.station.get()).toEqual(defaultStation());
      });

      it("serialises concurrent updates (no lost writes)", async () => {
        await fx.tracks.add(track("a"));
        const appendIfRoom = () =>
          fx.station.update((cur) => (cur.queue.length < 6 ? { ...cur, queue: [...cur.queue, "a"] } : null));
        await Promise.all(Array.from({ length: 10 }, appendIfRoom));
        expect((await fx.station.get()).queue).toHaveLength(6);
      });

      it("state survives reopening the store", async () => {
        await fx.tracks.add(track("a"));
        await fx.station.update((cur) => ({ ...cur, queue: ["a", "a"] }));
        const again = await fx.reopen();
        expect((await again.station.get()).queue).toEqual(["a", "a"]);
      });

      it("upNext round-trips and survives reopening", async () => {
        await fx.tracks.add(track("a"));
        await fx.station.update((cur) => ({ ...cur, upNext: "a" }));
        expect((await fx.station.get()).upNext).toBe("a");
        expect((await (await fx.reopen()).station.get()).upNext).toBe("a");
        await fx.station.update((cur) => ({ ...cur, upNext: null }));
        expect((await fx.station.get()).upNext).toBeNull();
      });
    });

    describe(`/api/station over ${name}`, () => {
      it("(a) device B gets the track device A reported, at offset + elapsed", async () => {
        await fx.tracks.add(track("x"));
        await fx.tracks.add(track("y"));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        const put = await request(app).put("/api/station/now-playing").send({ trackId: "x", offsetSec: 72, playing: true });
        expect(put.status).toBe(200);
        clock.t += 5_500;
        const res = await request(app).get("/api/station"); // device B
        expect(res.status).toBe(200);
        expect(res.body.nowPlaying.track.id).toBe("x");
        expect(res.body.nowPlaying.offsetSec).toBe(77.5);
        expect(res.body.nowPlaying.playing).toBe(true);
        expect(res.body.nowPlaying.reportedAt).toBe(new Date(T0).toISOString());
        expect(res.body.queueCap).toBe(6);
        expect(res.body.activePool).toEqual({ kind: "library" });
      });

      it("(a) with the real clock, offset keeps moving after the report", async () => {
        await fx.tracks.add(track("x"));
        const app = appFor(fx);
        await request(app).put("/api/station/now-playing").send({ trackId: "x", offsetSec: 72, playing: true });
        await new Promise((r) => setTimeout(r, 30));
        const res = await request(app).get("/api/station");
        expect(res.body.nowPlaying.track.id).toBe("x");
        expect(res.body.nowPlaying.offsetSec).toBeGreaterThanOrEqual(72.03);
        expect(res.body.nowPlaying.offsetSec).toBeLessThan(80);
      });

      it("paused: offset stays put", async () => {
        await fx.tracks.add(track("x"));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        await request(app).put("/api/station/now-playing").send({ trackId: "x", offsetSec: 72, playing: false });
        clock.t += 10_000_000;
        const res = await request(app).get("/api/station");
        expect(res.body.nowPlaying).toMatchObject({ track: { id: "x" }, offsetSec: 72, playing: false });
      });

      it("(b) queue caps at 6 and survives a restart", async () => {
        for (const id of ["a", "b", "c", "d", "e", "f", "g"]) await fx.tracks.add(track(id));
        const app = appFor(fx);
        for (const id of ["a", "b", "c", "d", "e", "a"]) {
          expect((await request(app).post("/api/station/queue").send({ trackId: id })).status).toBe(200);
        }
        const full = await request(app).post("/api/station/queue").send({ trackId: "g" });
        expect(full.status).toBe(409);
        expect(full.body).toEqual({ error: "queue full" });

        const restarted = appFor(await fx.reopen());
        const res = await request(restarted).get("/api/station");
        expect(ids(res.body.queue)).toEqual(["a", "b", "c", "d", "e", "a"]);
      });

      it("now-playing survives a restart too", async () => {
        await fx.tracks.add(track("x"));
        await fx.tracks.add(track("y"));
        const { opts } = fakeClock();
        await request(appFor(fx, opts)).put("/api/station/now-playing").send({ trackId: "y", offsetSec: 30, playing: false });
        const res = await request(appFor(await fx.reopen(), opts)).get("/api/station");
        expect(res.body.nowPlaying).toMatchObject({ track: { id: "y" }, offsetSec: 30, playing: false });
      });

      it("empty library: nothing playing", async () => {
        const res = await request(appFor(fx)).get("/api/station");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          nowPlaying: null,
          upNext: null,
          queue: [],
          activePool: { kind: "library" },
          queueCap: 6,
        });
      });

      it("nothing set yet: cues a random track at 0, paused, and keeps it", async () => {
        for (const id of ["a", "b", "c"]) await fx.tracks.add(track(id));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        const first = await request(app).get("/api/station");
        expect(["a", "b", "c"]).toContain(first.body.nowPlaying.track.id);
        expect(first.body.nowPlaying).toMatchObject({ offsetSec: 0, playing: false });
        clock.t += 60_000;
        const second = await request(app).get("/api/station");
        expect(second.body.nowPlaying).toEqual(first.body.nowPlaying);
      });

      it("lazily advances past the end of the track to the queue head, at 0, still playing", async () => {
        await fx.tracks.add(track("x", { durationSec: 100 }));
        await fx.tracks.add(track("q1"));
        await fx.tracks.add(track("q2"));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        await request(app).put("/api/station/now-playing").send({ trackId: "x", offsetSec: 90, playing: true });
        await request(app).post("/api/station/queue").send({ trackId: "q1" });
        await request(app).post("/api/station/queue").send({ trackId: "q2" });
        clock.t += 9_000;
        expect((await request(app).get("/api/station")).body.nowPlaying.track.id).toBe("x");
        clock.t += 2_000; // 101s: past durationSec but inside the grace (durationSec is rounded)
        const inGrace = await request(app).get("/api/station");
        expect(inGrace.body.nowPlaying).toMatchObject({ track: { id: "x" }, offsetSec: 100 }); // clamped to the end
        clock.t += 1_000; // 102s = duration + grace
        const res = await request(app).get("/api/station");
        expect(res.body.nowPlaying).toEqual({
          track: expect.objectContaining({ id: "q1" }),
          offsetSec: 0,
          playing: true,
          reportedAt: new Date(clock.t).toISOString(),
        });
        expect(ids(res.body.queue)).toEqual(["q2"]);
        // persisted: another restart sees the advanced station
        const after = await request(appFor(await fx.reopen(), opts)).get("/api/station");
        expect(after.body.nowPlaying.track.id).toBe("q1");
        expect(ids(after.body.queue)).toEqual(["q2"]);
      });

      it("with an empty queue, advancing shuffles to a track other than the one that just played", async () => {
        await fx.tracks.add(track("x", { durationSec: 10 }));
        await fx.tracks.add(track("y"));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        for (let i = 0; i < 5; i++) {
          await request(app).post("/api/station/play-now").send({ trackId: "x" });
          clock.t += 13_000;
          expect((await request(app).get("/api/station")).body.nowPlaying.track.id).toBe("y");
        }
      });

      it("race: GET advanced past the end, then the device's ended → POST /next {fromTrackId} is stale", async () => {
        await fx.tracks.add(track("c", { durationSec: 100 }));
        for (const id of ["q1", "q2"]) await fx.tracks.add(track(id));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        await request(app).post("/api/station/play-now").send({ trackId: "c" });
        await request(app).post("/api/station/queue").send({ trackId: "q1" });
        await request(app).post("/api/station/queue").send({ trackId: "q2" });
        clock.t += 103_000;
        expect((await request(app).get("/api/station")).body.nowPlaying.track.id).toBe("q1"); // device B
        const ended = await request(app).post("/api/station/next").send({ fromTrackId: "c" }); // device A
        expect(ended.status).toBe(200);
        expect(ended.body.stale).toBe(true);
        expect(ended.body.nowPlaying.track.id).toBe("q1"); // the queue head was not skipped
        expect(ids(ended.body.queue)).toEqual(["q2"]);
      });

      it("race: ended → POST /next {fromTrackId} inside the grace advances exactly once", async () => {
        await fx.tracks.add(track("c", { durationSec: 100 }));
        for (const id of ["q1", "q2"]) await fx.tracks.add(track(id));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        await request(app).post("/api/station/play-now").send({ trackId: "c" });
        await request(app).post("/api/station/queue").send({ trackId: "q1" });
        await request(app).post("/api/station/queue").send({ trackId: "q2" });
        clock.t += 100_400;
        // two devices both saw `ended` for c
        const [a, b] = await Promise.all([
          request(app).post("/api/station/next").send({ fromTrackId: "c" }),
          request(app).post("/api/station/next").send({ fromTrackId: "c" }),
        ]);
        expect([a.body.stale, b.body.stale].sort()).toEqual([true, undefined]);
        for (const r of [a, b]) expect(r.body.nowPlaying.track.id).toBe("q1");
        expect(ids((await request(app).get("/api/station")).body.queue)).toEqual(["q2"]);
      });

      it("POST /next without fromTrackId always skips (explicit user skip)", async () => {
        for (const id of ["a", "q1"]) await fx.tracks.add(track(id));
        const app = appFor(fx);
        await request(app).post("/api/station/play-now").send({ trackId: "a" });
        await request(app).post("/api/station/queue").send({ trackId: "q1" });
        const res = await request(app).post("/api/station/next").send();
        expect(res.body.stale).toBeUndefined();
        expect(res.body.nowPlaying.track.id).toBe("q1");
      });

      it("race: a stale position report after an advance doesn't revert the station", async () => {
        await fx.tracks.add(track("c", { durationSec: 100 }));
        await fx.tracks.add(track("q1"));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        await request(app).post("/api/station/play-now").send({ trackId: "c" });
        await request(app).post("/api/station/queue").send({ trackId: "q1" });
        clock.t += 103_000;
        expect((await request(app).get("/api/station")).body.nowPlaying.track.id).toBe("q1");
        const late = await request(app)
          .put("/api/station/now-playing")
          .send({ trackId: "c", offsetSec: 99, playing: true });
        expect(late.status).toBe(200);
        expect(late.body.stale).toBe(true);
        expect(late.body.nowPlaying).toMatchObject({ track: { id: "q1" }, offsetSec: 0, playing: true });
        // also stale when fromTrackId names a track the station already left
        const late2 = await request(app)
          .put("/api/station/now-playing")
          .send({ trackId: "q1", offsetSec: 5, playing: true, fromTrackId: "c" });
        expect(late2.body.stale).toBe(true);
        expect((await request(app).get("/api/station")).body.nowPlaying).toMatchObject({ track: { id: "q1" }, offsetSec: 0 });
      });

      it("PUT may switch tracks when it names the current track as fromTrackId, or the station is paused", async () => {
        for (const id of ["a", "b", "c"]) await fx.tracks.add(track(id));
        const app = appFor(fx);
        await request(app).post("/api/station/play-now").send({ trackId: "a" });
        const sw = await request(app)
          .put("/api/station/now-playing")
          .send({ trackId: "b", offsetSec: 3, playing: true, fromTrackId: "a" });
        expect(sw.body.stale).toBeUndefined();
        expect(sw.body.nowPlaying.track.id).toBe("b");
        await request(app).put("/api/station/now-playing").send({ trackId: "b", offsetSec: 4, playing: false });
        const fromPaused = await request(app)
          .put("/api/station/now-playing")
          .send({ trackId: "c", offsetSec: 0, playing: true });
        expect(fromPaused.body.stale).toBeUndefined();
        expect(fromPaused.body.nowPlaying.track.id).toBe("c");
      });

      it("a report past the end is clamped, and the station moves on once the grace is up", async () => {
        await fx.tracks.add(track("c", { durationSec: 100 }));
        await fx.tracks.add(track("q1"));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        await request(app).post("/api/station/play-now").send({ trackId: "c" });
        await request(app).post("/api/station/queue").send({ trackId: "q1" });
        const past = await request(app)
          .put("/api/station/now-playing")
          .send({ trackId: "c", offsetSec: 150, playing: true });
        expect(past.body.nowPlaying).toMatchObject({ track: { id: "c" }, offsetSec: 100 });
        clock.t += 2_000;
        expect((await request(app).get("/api/station")).body.nowPlaying.track.id).toBe("q1");
      });

      it("upNext: the queue head, else a pre-drawn pick that the station then actually plays", async () => {
        for (const id of ["a", "b", "c", "d"]) await fx.tracks.add(track(id, { durationSec: 10 }));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        const first = await request(app).post("/api/station/play-now").send({ trackId: "a" });
        const drawn = first.body.upNext.id;
        expect(["b", "c", "d"]).toContain(drawn);
        // stable across reads and restarts
        expect((await request(app).get("/api/station")).body.upNext.id).toBe(drawn);
        expect((await request(appFor(await fx.reopen(), opts)).get("/api/station")).body.upNext.id).toBe(drawn);
        // queue head takes precedence while there is one
        const other = ["b", "c", "d"].find((id) => id !== drawn)!;
        const queued = await request(app).post("/api/station/queue").send({ trackId: other });
        expect(queued.body.upNext.id).toBe(other);
        const afterQueue = await request(app).post("/api/station/next").send({ fromTrackId: "a" });
        expect(afterQueue.body.nowPlaying.track.id).toBe(other);
        expect(afterQueue.body.upNext.id).toBe(drawn);
        // queue empty: the lazy advance plays the pick, and a new one is drawn
        clock.t += 13_000;
        const res = await request(app).get("/api/station");
        expect(res.body.nowPlaying.track.id).toBe(drawn);
        expect(res.body.upNext).not.toBeNull();
        expect(res.body.upNext.id).not.toBe(drawn);
      });

      it("upNext is redrawn when its track is deleted", async () => {
        for (const id of ["a", "b", "c"]) await fx.tracks.add(track(id));
        const app = appFor(fx);
        const first = await request(app).post("/api/station/play-now").send({ trackId: "a" });
        const drawn = first.body.upNext.id;
        expect((await request(app).delete(`/api/tracks/${drawn}`)).status).toBe(204);
        const res = await request(app).get("/api/station");
        const remaining = ["b", "c"].find((id) => id !== drawn);
        expect(res.body.upNext.id).toBe(remaining);
        expect((await fx.station.get()).upNext).toBe(remaining);
      });

      it("upNext is never the current track when there's a choice (play-now of the pick)", async () => {
        for (const id of ["a", "b"]) await fx.tracks.add(track(id));
        const app = appFor(fx);
        await request(app).post("/api/station/play-now").send({ trackId: "a" });
        const res = await request(app).post("/api/station/play-now").send({ trackId: "b" });
        expect(res.body.upNext.id).toBe("a");
      });

      it("a one-track library replays that track", async () => {
        await fx.tracks.add(track("solo"));
        const app = appFor(fx);
        await request(app).put("/api/station/now-playing").send({ trackId: "solo", offsetSec: 50, playing: true });
        const res = await request(app).post("/api/station/next");
        expect(res.body.nowPlaying).toMatchObject({ track: { id: "solo" }, offsetSec: 0, playing: true });
      });

      it("unknown duration never auto-advances", async () => {
        await fx.tracks.add(track("x", { durationSec: null }));
        await fx.tracks.add(track("y"));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        await request(app).put("/api/station/now-playing").send({ trackId: "x", offsetSec: 0, playing: true });
        clock.t += 3_600_000;
        const res = await request(app).get("/api/station");
        expect(res.body.nowPlaying).toMatchObject({ track: { id: "x" }, offsetSec: 3600 });
      });

      it("a device's playback error → POST /next {fromTrackId, reason:'error'} advances like a normal next", async () => {
        // the client's way out of a track that can't play (e.g. unknown duration, decode error)
        await fx.tracks.add(track("x", { durationSec: null }));
        for (const id of ["q1", "q2"]) await fx.tracks.add(track(id));
        const { clock, opts } = fakeClock();
        const app = appFor(fx, opts);
        await request(app).post("/api/station/play-now").send({ trackId: "x" });
        await request(app).post("/api/station/queue").send({ trackId: "q1" });
        await request(app).post("/api/station/queue").send({ trackId: "q2" });
        clock.t += 2_000;
        const res = await request(app).post("/api/station/next").send({ fromTrackId: "x", reason: "error" });
        expect(res.status).toBe(200);
        expect(res.body.stale).toBeUndefined();
        expect(res.body.nowPlaying).toMatchObject({ track: { id: "q1" }, offsetSec: 0, playing: true });
        expect(ids(res.body.queue)).toEqual(["q2"]);
        // a second device reporting the same error is stale and doesn't skip q1
        const again = await request(app).post("/api/station/next").send({ fromTrackId: "x", reason: "error" });
        expect(again.body.stale).toBe(true);
        expect(again.body.nowPlaying.track.id).toBe("q1");
      });

      it("POST /next takes the queue head, then shuffles, and starts playing", async () => {
        for (const id of ["a", "b", "q"]) await fx.tracks.add(track(id));
        const app = appFor(fx);
        await request(app).put("/api/station/now-playing").send({ trackId: "a", offsetSec: 5, playing: false });
        await request(app).post("/api/station/queue").send({ trackId: "q" });
        const one = await request(app).post("/api/station/next");
        expect(one.status).toBe(200);
        expect(one.body.nowPlaying).toMatchObject({ track: { id: "q" }, offsetSec: 0, playing: true });
        expect(one.body.queue).toEqual([]);
        const two = await request(app).post("/api/station/next");
        expect(["a", "b"]).toContain(two.body.nowPlaying.track.id);
      });

      it("POST /next on an empty library: nothing playing", async () => {
        const res = await request(appFor(fx)).post("/api/station/next");
        expect(res.status).toBe(200);
        expect(res.body.nowPlaying).toBeNull();
      });

      it("play-now interrupts and leaves the queue alone", async () => {
        for (const id of ["a", "b", "q"]) await fx.tracks.add(track(id));
        const app = appFor(fx);
        await request(app).put("/api/station/now-playing").send({ trackId: "a", offsetSec: 40, playing: true });
        await request(app).post("/api/station/queue").send({ trackId: "q" });
        const res = await request(app).post("/api/station/play-now").send({ trackId: "b" });
        expect(res.status).toBe(200);
        expect(res.body.nowPlaying).toMatchObject({ track: { id: "b" }, playing: true });
        expect(res.body.nowPlaying.offsetSec).toBeLessThan(1);
        expect(ids(res.body.queue)).toEqual(["q"]);
      });

      it("DELETE /queue/:index removes one entry and closes the gap", async () => {
        for (const id of ["a", "b", "c"]) await fx.tracks.add(track(id));
        const app = appFor(fx);
        for (const id of ["a", "b", "a", "c"]) await request(app).post("/api/station/queue").send({ trackId: id });
        const res = await request(app).delete("/api/station/queue/2");
        expect(res.status).toBe(200);
        expect(ids(res.body.queue)).toEqual(["a", "b", "c"]);
        expect((await request(app).delete("/api/station/queue/3")).status).toBe(404);
        expect((await request(app).delete("/api/station/queue/-1")).status).toBe(400);
        expect((await request(app).delete("/api/station/queue/x")).status).toBe(400);
        // optional guard: only delete if the entry is still the expected track
        const mismatch = await request(app).delete("/api/station/queue/0?trackId=b");
        expect(mismatch.status).toBe(409);
        expect(mismatch.body).toEqual({ error: "queue changed" });
        expect((await request(app).delete("/api/station/queue/7?trackId=b")).status).toBe(409);
        expect(ids((await request(app).delete("/api/station/queue/1?trackId=b")).body.queue)).toEqual(["a", "c"]);
        expect(ids((await request(app).get("/api/station")).body.queue)).toEqual(["a", "c"]);
      });

      it("deleting tracks drops them from the queue and replaces a deleted now-playing", async () => {
        for (const id of ["a", "b", "c"]) await fx.tracks.add(track(id));
        const app = appFor(fx);
        await request(app).put("/api/station/now-playing").send({ trackId: "a", offsetSec: 10, playing: true });
        for (const id of ["b", "a", "c", "a"]) await request(app).post("/api/station/queue").send({ trackId: id });
        expect((await request(app).delete("/api/tracks/a")).status).toBe(204);
        const res = await request(app).get("/api/station");
        // the queue head replaces the deleted track, cued paused
        expect(res.body.nowPlaying).toMatchObject({ track: { id: "b" }, offsetSec: 0, playing: false });
        expect(ids(res.body.queue)).toEqual(["c"]);
        // indexes address the compacted queue
        await request(app).post("/api/station/queue").send({ trackId: "b" });
        const del = await request(app).delete("/api/station/queue/0");
        expect(ids(del.body.queue)).toEqual(["b"]);
      });

      it("rejects bad reports", async () => {
        await fx.tracks.add(track("x"));
        const app = appFor(fx);
        const put = (body: unknown) => request(app).put("/api/station/now-playing").send(body as object);
        expect((await put({ trackId: "nope", offsetSec: 1, playing: true })).status).toBe(404);
        expect((await put({ trackId: "x", offsetSec: -1, playing: true })).status).toBe(400);
        expect((await put({ trackId: "x", offsetSec: "1", playing: true })).status).toBe(400);
        expect((await put({ trackId: "x", offsetSec: 1 })).status).toBe(400);
        expect((await put({ offsetSec: 1, playing: true })).status).toBe(400);
        const malformed = await request(app)
          .put("/api/station/now-playing")
          .set("Content-Type", "application/json")
          .send("{not json");
        expect(malformed.status).toBe(400);
        expect((await request(app).post("/api/station/queue").send({ trackId: "nope" })).status).toBe(404);
        expect((await request(app).post("/api/station/queue").send({})).status).toBe(400);
        expect((await request(app).post("/api/station/play-now").send({ trackId: "nope" })).status).toBe(404);
        // none of that touched the station
        expect((await fx.station.get()).queue).toEqual([]);
      });

      it("concurrent requests from many devices never overfill or corrupt the queue", async () => {
        for (const id of ["a", "b"]) await fx.tracks.add(track(id));
        const app = appFor(fx);
        const results = await Promise.all([
          ...Array.from({ length: 10 }, () => request(app).post("/api/station/queue").send({ trackId: "a" })),
          ...Array.from({ length: 5 }, (_, i) =>
            request(app).put("/api/station/now-playing").send({ trackId: "b", offsetSec: i, playing: true }),
          ),
        ]);
        const queued = results.slice(0, 10).map((r) => r.status);
        expect(queued.filter((s) => s === 200)).toHaveLength(6);
        expect(queued.filter((s) => s === 409)).toHaveLength(4);
        expect(results.slice(10).every((r) => r.status === 200)).toBe(true);
        const res = await request(app).get("/api/station");
        expect(ids(res.body.queue)).toEqual(["a", "a", "a", "a", "a", "a"]);
        expect(res.body.nowPlaying.track.id).toBe("b");
      });
    });
  });
}
