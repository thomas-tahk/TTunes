import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, makeTempDir, makeTestApp } from "./helpers.ts";

function streamTypes(path: string): string[] {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path]);
  return out.toString().split("\n").filter(Boolean);
}

describe("upload: audio and video files", () => {
  it("keeps only the sound of a video file", async () => {
    const { app, repo, root } = makeTestApp();

    const added = await request(app).post("/api/tracks").attach("file", join(FIXTURES, "tone.mp4"));
    const audio = await request(app).get(`/audio/${added.body.id}`);

    expect(added.status).toBe(201);
    expect(audio.headers["content-type"]).toMatch(/^audio\//);
    const stored = join(root, "uploads", repo.get(added.body.id)!.storageKey);
    expect(streamTypes(stored)).toEqual(["audio"]);
  });

  it("rejects a non-media file with a plain message", async () => {
    const { app, repo } = makeTestApp();

    const res = await request(app).post("/api/tracks").attach("file", join(FIXTURES, "notes.txt"));

    expect(res.status).toBe(415);
    expect(res.body.error).toBe("That file isn't audio or video.");
    expect(repo.all()).toEqual([]);
  });

  it("still accepts an MP3", async () => {
    const { app } = makeTestApp();

    const res = await request(app).post("/api/tracks").attach("file", join(FIXTURES, "tone.mp3"));

    expect(res.status).toBe(201);
  });

  it("converts audio-only containers so /audio serves audio/*", async () => {
    const { app } = makeTestApp();

    const added = await request(app).post("/api/tracks").attach("file", join(FIXTURES, "tone-audio-only.mp4"));
    const audio = await request(app).get(`/audio/${added.body.id}`);

    expect(added.status).toBe(201);
    expect(audio.headers["content-type"]).toBe("audio/mp4");
  });

  it("rejects a silent video with a plain message", async () => {
    const { app, repo } = makeTestApp();

    const res = await request(app).post("/api/tracks").attach("file", join(FIXTURES, "silent.mp4"));

    expect(res.status).toBe(415);
    expect(res.body.error).toBe("That video has no sound.");
    expect(repo.all()).toEqual([]);
  });
});

describe("upload: ffmpeg problems", () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  /** A PATH holding the real ffprobe plus the given ffmpeg stand-in script (if any). */
  function pathWith(ffmpegScript?: string): string {
    const bin = makeTempDir("ttunes-bin-");
    symlinkSync(execFileSync("which", ["ffprobe"]).toString().trim(), join(bin, "ffprobe"));
    if (ffmpegScript) {
      writeFileSync(join(bin, "ffmpeg"), ffmpegScript);
      chmodSync(join(bin, "ffmpeg"), 0o755);
    }
    return bin;
  }

  it("says how to install ffmpeg when it is missing", async () => {
    const { app } = makeTestApp();
    process.env.PATH = pathWith();

    const res = await request(app).post("/api/tracks").attach("file", join(FIXTURES, "tone.mp4"));

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("ffmpeg isn't installed — run: brew install ffmpeg");
  });

  it("returns JSON and leaves no files behind when ffmpeg fails", async () => {
    const { app, repo, root } = makeTestApp();
    process.env.PATH = pathWith('#!/bin/sh\nfor last; do :; done\necho partial > "$last"\nexit 1\n');

    const res = await request(app).post("/api/tracks").attach("file", join(FIXTURES, "tone.mp4"));

    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.error).toBe("Couldn't extract the audio from that file.");
    expect(readdirSync(join(root, "uploads"))).toEqual([]);
    expect(repo.all()).toEqual([]);
  });
});
