import { describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, fakeYtDlp, makeTestApp } from "./helpers.ts";
import { IngestError, type YtInfo } from "../server/ingest.ts";

const info: YtInfo = JSON.parse(readFileSync(join(FIXTURES, "ytdlp-info-topic.json"), "utf8"));
const LINK = "https://www.youtube.com/watch?v=fixture0001";

describe("YouTube ingest", () => {
  it("stages a youtube.com link with parsed artist and title", async () => {
    const { app } = makeTestApp(fakeYtDlp(info));

    const res = await request(app).post("/api/ingest/youtube").send({ url: LINK });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ artist: "Neon Coast", title: "Midnight Drive" });
  });

  it("commits with an edited title into the library and streams it", async () => {
    const { app } = makeTestApp(fakeYtDlp(info));
    const staged = await request(app).post("/api/ingest/youtube").send({ url: LINK });

    const commit = await request(app).post(`/api/ingest/youtube/${staged.body.id}/commit`).send({ title: "Edited" });
    const list = await request(app).get("/api/tracks");
    const audio = await request(app).get(`/audio/${commit.body.id}`);

    expect(commit.status).toBe(201);
    expect(list.body.map((t: { title: string }) => t.title)).toEqual(["Edited"]);
    expect(audio.status).toBe(200);
    expect(audio.headers["content-type"]).toBe("audio/mpeg");
  });

  it("rejects a non-YouTube URL with a plain message", async () => {
    const { app } = makeTestApp(fakeYtDlp(info));

    const res = await request(app).post("/api/ingest/youtube").send({ url: "https://example.com/x" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/YouTube link/);
  });

  it("surfaces the runner's IngestError message", async () => {
    const { app } = makeTestApp(async () => {
      throw new IngestError("yt-dlp isn't installed or couldn't run.");
    });

    const res = await request(app).post("/api/ingest/youtube").send({ url: LINK });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("yt-dlp isn't installed or couldn't run.");
  });

  it("404s committing an unknown staged id", async () => {
    const { app } = makeTestApp(fakeYtDlp(info));

    const res = await request(app).post("/api/ingest/youtube/nope/commit").send({});

    expect(res.status).toBe(404);
  });
});
