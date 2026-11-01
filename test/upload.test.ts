import { describe, expect, it } from "vitest";
import request from "supertest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { FIXTURES, makeTestApp } from "./helpers.ts";

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
});
