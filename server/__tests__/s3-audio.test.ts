import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import request from "supertest";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { makeTestS3Storage, testS3Config } from "./s3-test-env.ts";
import type { S3Storage } from "../s3-storage.ts";
import { StorageNotFoundError } from "../storage.ts";

describe.skipIf(!testS3Config)("upload + range playback through S3Storage", () => {
  let t: TestApp;
  let s3: S3Storage;
  beforeEach(async () => {
    s3 = await makeTestS3Storage(testS3Config!);
    t = await makeTestApp({ storage: s3 });
  });
  afterEach(async () => {
    await s3.delete(t.track.storageKey);
    t.cleanup();
  });

  it("stores the upload in the bucket (not on local disk) and serves 206 ranges from it", async () => {
    const upload = Buffer.alloc(3000);
    for (let i = 0; i < upload.length; i++) upload[i] = (i * 13) % 256;

    const res = await request(t.app).post("/api/tracks").attach("file", upload, "Bucket Song.flac");
    expect(res.status).toBe(201);
    const key: string = res.body.storageKey;
    expect(key).toMatch(/\.flac$/);

    try {
      // the object is in the bucket, with its content type...
      const head = await s3.client.send(new HeadObjectCommand({ Bucket: testS3Config!.bucket, Key: key }));
      expect(head.ContentLength).toBe(3000);
      expect(head.ContentType).toBe("audio/flac");
      // ...and nothing is left on local disk: scratch upload removed, no local copy
      expect(readdirSync(t.uploadDir)).toEqual([]);
      expect(existsSync(join(t.root, "storage", key))).toBe(false);

      const audio = await request(t.app).get(`/audio/${res.body.id}`).set("Range", "bytes=1000-1999");
      expect(audio.status).toBe(206);
      expect(audio.headers["content-range"]).toBe("bytes 1000-1999/3000");
      expect(audio.headers["content-length"]).toBe("1000");
      expect(audio.headers["content-type"]).toBe("audio/flac");
      expect(Buffer.from(audio.body).equals(upload.subarray(1000, 2000))).toBe(true);

      const tail = await request(t.app).get(`/audio/${res.body.id}`).set("Range", "bytes=-100");
      expect(tail.status).toBe(206);
      expect(tail.headers["content-range"]).toBe("bytes 2900-2999/3000");
      expect(Buffer.from(tail.body).equals(upload.subarray(2900))).toBe(true);
    } finally {
      await s3.delete(key);
    }
  });

  it("returns 404 when the object is missing from the bucket", async () => {
    await s3.delete(t.track.storageKey);
    const res = await request(t.app).get(`/audio/${t.track.id}`).set("Range", "bytes=0-99");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/tracks/:id removes the object from the bucket", async () => {
    const res = await request(t.app).delete(`/api/tracks/${t.track.id}`);
    expect(res.status).toBe(204);
    await expect(s3.stat(t.track.storageKey)).rejects.toBeInstanceOf(StorageNotFoundError);
  });
});
