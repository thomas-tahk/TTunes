import { describe, expect, it } from "vitest";
import request from "supertest";
import { join } from "node:path";
import { FIXTURES, makeTestApp } from "./helpers.ts";

describe("library (June MVP baseline)", () => {
  it("adds an uploaded MP3 to the library and streams it back", async () => {
    const { app } = makeTestApp();

    const added = await request(app).post("/api/tracks").attach("file", join(FIXTURES, "tone.mp3"));
    const list = await request(app).get("/api/tracks");
    const audio = await request(app).get(`/audio/${added.body.id}`);

    expect(added.status).toBe(201);
    expect(list.body.map((t: { id: string }) => t.id)).toEqual([added.body.id]);
    expect(audio.status).toBe(200);
    expect(audio.headers["content-type"]).toBe("audio/mpeg");
  });
});
