import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { makeTestApp, type TestApp } from "./helpers.ts";

describe("/api/tracks", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeTestApp();
  });
  afterEach(() => t.cleanup());

  it("lists the seeded track", async () => {
    const res = await request(t.app).get("/api/tracks");
    expect(res.status).toBe(200);
    expect(res.body.map((x: { id: string }) => x.id)).toEqual([t.track.id]);
  });

  it("uploads a file, stores it, removes the temp upload, and makes it streamable", async () => {
    const res = await request(t.app)
      .post("/api/tracks")
      .attach("file", Buffer.alloc(300, 7), "My Song.MP3");
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("My Song");
    expect(res.body.sizeBytes).toBe(300);
    expect(res.body.storageKey).toMatch(/\.mp3$/);
    expect(readdirSync(t.uploadDir)).toEqual([]);

    const audio = await request(t.app).get(`/audio/${res.body.id}`).set("Range", "bytes=0-99");
    expect(audio.status).toBe(206);
    expect(audio.headers["content-range"]).toBe("bytes 0-99/300");
  });

  it("rejects an upload with no file", async () => {
    const res = await request(t.app).post("/api/tracks");
    expect(res.status).toBe(400);
  });

  it("deletes a track from the library and from storage", async () => {
    const res = await request(t.app).delete(`/api/tracks/${t.track.id}`);
    expect(res.status).toBe(204);
    expect(await t.repo.get(t.track.id)).toBeUndefined();
    expect(existsSync(join(t.root, "storage", t.track.storageKey))).toBe(false);
    const again = await request(t.app).delete(`/api/tracks/${t.track.id}`);
    expect(again.status).toBe(404);
  });
  it("removes the stored object when the catalog write fails", async () => {
    t.repo.add = async () => {
      throw new Error("db down");
    };
    const before = readdirSync(join(t.root, "storage"));
    const res = await request(t.app).post("/api/tracks").attach("file", Buffer.alloc(50, 1), "x.mp3");
    expect(res.status).toBe(500);
    expect(readdirSync(join(t.root, "storage"))).toEqual(before);
  });
});
