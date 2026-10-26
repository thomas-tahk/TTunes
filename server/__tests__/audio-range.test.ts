import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { makeTestApp, type TestApp } from "./helpers.ts";

describe("GET /audio/:id range streaming", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeTestApp();
  });
  afterEach(() => t.cleanup());

  it("returns 206 with the first 100 bytes for Range: bytes=0-99", async () => {
    const res = await request(t.app).get(`/audio/${t.track.id}`).set("Range", "bytes=0-99");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-99/1000");
    expect(res.headers["content-length"]).toBe("100");
    expect(res.headers["content-type"]).toBe("audio/mpeg");
    expect(Buffer.from(res.body).equals(t.bytes.subarray(0, 100))).toBe(true);
  });

  it("returns the whole file with 200 when no Range header is sent", async () => {
    const res = await request(t.app).get(`/audio/${t.track.id}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe("1000");
    expect(res.headers["accept-ranges"]).toBe("bytes");
  });

  it("serves an open-ended range to the end of the file", async () => {
    const res = await request(t.app).get(`/audio/${t.track.id}`).set("Range", "bytes=900-");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 900-999/1000");
  });

  it("serves the last N bytes for a suffix range (bytes=-500)", async () => {
    const res = await request(t.app).get(`/audio/${t.track.id}`).set("Range", "bytes=-500");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 500-999/1000");
    expect(Buffer.from(res.body).equals(t.bytes.subarray(500))).toBe(true);
  });

  it("clamps an end past the file size", async () => {
    const res = await request(t.app).get(`/audio/${t.track.id}`).set("Range", "bytes=950-5000");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 950-999/1000");
  });

  it("returns 416 when the range starts past the end of the file", async () => {
    const res = await request(t.app).get(`/audio/${t.track.id}`).set("Range", "bytes=5000-");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */1000");
  });

  it("returns 404 for an unknown track", async () => {
    const res = await request(t.app).get("/audio/nope").set("Range", "bytes=0-99");
    expect(res.status).toBe(404);
  });

  it("returns 404 and keeps serving when the track's file is missing from storage", async () => {
    await t.storage.delete(t.track.storageKey);
    const res = await request(t.app).get(`/audio/${t.track.id}`).set("Range", "bytes=0-99");
    expect(res.status).toBe(404);
    const again = await request(t.app).get("/api/tracks");
    expect(again.status).toBe(200);
  });
});
