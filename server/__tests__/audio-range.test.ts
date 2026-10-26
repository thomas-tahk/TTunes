import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
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

  it("answers HEAD with range headers and no body, without reading from storage", async () => {
    const readRange = vi.spyOn(t.storage, "readRange");
    const ranged = await request(t.app).head(`/audio/${t.track.id}`).set("Range", "bytes=0-99");
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-range"]).toBe("bytes 0-99/1000");
    expect(ranged.headers["content-length"]).toBe("100");
    const whole = await request(t.app).head(`/audio/${t.track.id}`);
    expect(whole.status).toBe(200);
    expect(whole.headers["content-length"]).toBe("1000");
    expect(readRange).not.toHaveBeenCalled();
  });

  it("still logs when the storage stream resets mid-response (client didn't leave)", async () => {
    t.storage.readRange = async () => {
      const r = new Readable({ read() {} });
      r.push(Buffer.alloc(100));
      setTimeout(() => r.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" })), 20);
      return r;
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await request(t.app).get(`/audio/${t.track.id}`).catch(() => {}); // response is cut short
      await new Promise((r) => setTimeout(r, 100));
      expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^stream error for /), expect.anything());
    } finally {
      errors.mockRestore();
    }
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
