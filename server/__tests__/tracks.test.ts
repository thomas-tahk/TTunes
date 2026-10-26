import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { fixture, makeTestApp, makeWav, noiseBytes, type TestApp } from "./helpers.ts";

describe("/api/tracks", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeTestApp();
  });
  afterEach(() => t.cleanup());

  /** Storage holds only the seeded track, the catalog only the seeded entry, no temp files left. */
  const expectNothingStored = async () => {
    expect(readdirSync(join(t.root, "storage"))).toEqual([t.track.storageKey]);
    expect((await t.repo.all()).map((x) => x.id)).toEqual([t.track.id]);
    expect(readdirSync(t.uploadDir)).toEqual([]);
  };

  it("lists the seeded track", async () => {
    const res = await request(t.app).get("/api/tracks");
    expect(res.status).toBe(200);
    expect(res.body.map((x: { id: string }) => x.id)).toEqual([t.track.id]);
  });

  it("uploads a file, stores it, removes the temp upload, and makes it streamable", async () => {
    const wav = makeWav(2);
    const res = await request(t.app).post("/api/tracks").attach("file", wav, "My Song.WAV");
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("My Song");
    expect(res.body.artist).toBe("Unknown Artist");
    expect(res.body.durationSec).toBe(2);
    expect(res.body.format).toBe("WAVE");
    expect(res.body.sizeBytes).toBe(wav.length);
    expect(res.body.storageKey).toMatch(/\.wav$/);
    expect(readdirSync(t.uploadDir)).toEqual([]);

    const audio = await request(t.app).get(`/audio/${res.body.id}`).set("Range", "bytes=0-99");
    expect(audio.status).toBe(206);
    expect(audio.headers["content-range"]).toBe(`bytes 0-99/${wav.length}`);
    expect(audio.headers["content-type"]).toBe("audio/wav");
  });

  it.each([
    ["tone.mp3", "MPEG", "audio/mpeg"],
    ["tone.flac", "FLAC", "audio/flac"],
    ["tone.m4a", "M4A/isom/iso2", "audio/mp4"],
    ["tone.ogg", "Ogg", "audio/ogg"],
    ["tone.opus", "Ogg", "audio/opus"],
  ])("accepts a real %s with its duration", async (name, format, contentType) => {
    const res = await request(t.app).post("/api/tracks").attach("file", fixture(name), name);
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("tone");
    expect(res.body.durationSec).toBe(1);
    expect(res.body.format).toBe(format);
    const audio = await request(t.app).head(`/audio/${res.body.id}`);
    expect(audio.headers["content-type"]).toBe(contentType);
  });

  it.each([
    ["a text file", Buffer.from("hello, this is not music\n"), "notes.txt"],
    ["a text file renamed .mp3", Buffer.from("hello, this is not music\n"), "notes.mp3"],
    ["random bytes named .mp3", noiseBytes(3000), "noise.mp3"],
    ["random bytes named .wav", noiseBytes(3000, 7), "noise.wav"],
    ["zeros named .flac", Buffer.alloc(300), "zeros.flac"],
    ["an empty file", Buffer.alloc(0), "empty.mp3"],
    ["a WAV header with no samples", makeWav(0), "silent.wav"],
    ["real audio with an unsupported extension", makeWav(1), "tone.aiff"],
    ["real audio with no extension", makeWav(1), "tone"],
  ])("rejects %s with 415 and stores nothing", async (_label, bytes, name) => {
    const res = await request(t.app).post("/api/tracks").attach("file", bytes, name);
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: "not a playable audio file" });
    await expectNothingStored();
  });

  it("re-reads UTF-8 RIFF INFO tags and never stores control characters", async () => {
    const res = await request(t.app).post("/api/tracks").attach("file", fixture("uni.wav"), "uni.wav");
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Ünïcødé — 日本語");
    expect(res.body.artist).toBe("Bjørk ✓");
    expect(JSON.stringify(res.body)).not.toMatch(/\\u00[01]/);
    expect((await t.repo.get(res.body.id))?.title).toBe("Ünïcødé — 日本語");
  });

  it("keeps a non-ASCII filename intact as the fallback title", async () => {
    const res = await request(t.app).post("/api/tracks").attach("file", makeWav(1), "Café — 東京.wav");
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Café — 東京");
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
    const res = await request(t.app).post("/api/tracks").attach("file", makeWav(1), "x.wav");
    expect(res.status).toBe(500);
    expect(readdirSync(join(t.root, "storage"))).toEqual(before);
  });
});
