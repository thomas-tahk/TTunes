import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import request from "supertest";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { makeTestS3Storage, runServer, testS3Config } from "./s3-test-env.ts";
import { S3Storage } from "../s3-storage.ts";
import { StorageNotFoundError } from "../storage.ts";

describe.skipIf(!testS3Config)("S3Storage.verify against a live store", () => {
  it("resolves for an existing bucket", async () => {
    const s3 = await makeTestS3Storage(testS3Config!);
    await expect(s3.verify()).resolves.toBeUndefined();
  });

  it("rejects for a nonexistent bucket, which would otherwise make every object a silent 404", async () => {
    const s3 = new S3Storage({ ...testS3Config!, bucket: "ttunes-t6-does-not-exist" });
    await expect(s3.stat("x.mp3")).rejects.toBeInstanceOf(StorageNotFoundError); // the silent failure
    await expect(s3.verify()).rejects.toThrow(/bucket "ttunes-t6-does-not-exist" .*bucket does not exist/);
  });

  it("rejects with access denied for bad credentials, without echoing them", async () => {
    const s3 = new S3Storage({ ...testS3Config!, accessKeyId: "bad-key-xyz", secretAccessKey: "bad-secret-xyz" });
    const err = await s3.verify().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/access denied/);
    expect(err?.message).not.toMatch(/bad-(key|secret)-xyz/);
  });

  it("server exits 1 at startup when the bucket doesn't exist, and runs when it does", async () => {
    const env = {
      S3_ENDPOINT: testS3Config!.endpoint!,
      S3_ACCESS_KEY_ID: testS3Config!.accessKeyId!,
      S3_SECRET_ACCESS_KEY: testS3Config!.secretAccessKey!,
    };
    const bad = await runServer({ ...env, S3_BUCKET: "ttunes-t6-does-not-exist" });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/storage misconfigured: .*bucket does not exist/);
    expect(bad.stderr).not.toContain(env.S3_SECRET_ACCESS_KEY);

    const good = await runServer({ ...env, S3_BUCKET: testS3Config!.bucket }, 4000);
    expect(good.code).toBeNull(); // still running when killed
    expect(good.stdout).toMatch(/TTunes server on/);
  }, 30_000);
});

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

  it("HEAD /audio/:id answers from HeadObject alone, without reading the range", async () => {
    const readRange = vi.spyOn(s3, "readRange");
    const res = await request(t.app).head(`/audio/${t.track.id}`).set("Range", "bytes=0-99");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-99/${t.bytes.length}`);
    expect(res.headers["content-length"]).toBe("100");
    expect(readRange).not.toHaveBeenCalled();
  });

  it("doesn't log an error when the client disconnects mid-stream", async () => {
    // a body big enough that the response is still streaming when we hang up
    const big = await makeTestApp({ storage: s3, size: 16 * 1024 * 1024 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = big.app.listen(0);
    try {
      await new Promise<void>((r) => server.once("listening", () => r()));
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((done, fail) => {
        const req = httpGet(`http://127.0.0.1:${port}/audio/${big.track.id}`, (res) => {
          res.once("data", () => {
            req.destroy();
            done();
          });
        });
        req.on("error", (e) => (e.message === "socket hang up" || (e as NodeJS.ErrnoException).code === "ECONNRESET" ? done() : fail(e)));
      });
      await new Promise((r) => setTimeout(r, 500)); // let the pipeline callback fire
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      server.close();
      await s3.delete(big.track.storageKey);
      big.cleanup();
    }
  }, 30_000);

  it("DELETE /api/tracks/:id removes the object from the bucket", async () => {
    const res = await request(t.app).delete(`/api/tracks/${t.track.id}`);
    expect(res.status).toBe(204);
    await expect(s3.stat(t.track.storageKey)).rejects.toBeInstanceOf(StorageNotFoundError);
  });
});
