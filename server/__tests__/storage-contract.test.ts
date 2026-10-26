import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { nanoid } from "nanoid";
import { LocalDiskStorage, StorageNotFoundError, type StorageAdapter } from "../storage.ts";
import { makeTestS3Storage, testS3Config } from "./s3-test-env.ts";

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * The behaviour every StorageAdapter must have. Each adapter runs the same cases,
 * so swapping local disk for S3/R2 can't change what callers observe.
 */
function storageContract(name: string, makeStorage: () => Promise<StorageAdapter>, opts: { skip?: boolean } = {}) {
  describe.skipIf(opts.skip ?? false)(`StorageAdapter contract: ${name}`, () => {
    let storage: StorageAdapter;
    let scratch: string;
    const keys: string[] = [];
    const bytes = Buffer.alloc(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;

    beforeAll(async () => {
      storage = await makeStorage();
      scratch = mkdtempSync(join(tmpdir(), "ttunes-contract-"));
    });
    afterAll(async () => {
      for (const key of keys) await storage.delete(key);
      rmSync(scratch, { recursive: true, force: true });
    });

    function newKey(ext = ".mp3"): string {
      const key = `contract-${nanoid()}${ext}`;
      keys.push(key);
      return key;
    }

    /** Writes `data` to a fresh source file and puts it under a unique key. */
    async function putBytes(data: Buffer, ext = ".mp3"): Promise<string> {
      const key = newKey(ext);
      const src = join(scratch, `src-${nanoid()}${ext}`);
      writeFileSync(src, data);
      await storage.put(key, src, "audio/mpeg");
      rmSync(src, { force: true }); // what the caller does after put
      return key;
    }

    it("put then stat reports the stored size", async () => {
      const key = await putBytes(bytes);
      expect(await storage.stat(key)).toEqual({ size: 1000 });
    });

    it("readRange returns exactly start..end inclusive", async () => {
      const key = await putBytes(bytes);
      expect((await readAll(await storage.readRange(key, 0, 99))).equals(bytes.subarray(0, 100))).toBe(true);
      expect((await readAll(await storage.readRange(key, 500, 999))).equals(bytes.subarray(500))).toBe(true);
      expect((await readAll(await storage.readRange(key, 42, 42))).equals(bytes.subarray(42, 43))).toBe(true);
    });

    it("put overwrites an existing key", async () => {
      const key = await putBytes(bytes);
      const src = join(scratch, `over-${nanoid()}.mp3`);
      writeFileSync(src, Buffer.alloc(10, 9));
      await storage.put(key, src);
      expect(await storage.stat(key)).toEqual({ size: 10 });
      expect((await readAll(await storage.readRange(key, 0, 9))).equals(Buffer.alloc(10, 9))).toBe(true);
    });

    it("stores a file larger than one multipart part (12 MB) intact", async () => {
      const big = Buffer.alloc(12 * 1024 * 1024);
      for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) % 256;
      const key = await putBytes(big, ".flac");
      expect(await storage.stat(key)).toEqual({ size: big.length });
      const start = 5 * 1024 * 1024 - 10; // straddles the first part boundary
      const got = await readAll(await storage.readRange(key, start, start + 8191));
      expect(got.equals(big.subarray(start, start + 8192))).toBe(true);
    }, 30_000);

    it("stores an empty file", async () => {
      const key = await putBytes(Buffer.alloc(0));
      expect(await storage.stat(key)).toEqual({ size: 0 });
    });

    it("stat rejects with StorageNotFoundError for a missing key", async () => {
      await expect(storage.stat(`missing-${nanoid()}.mp3`)).rejects.toBeInstanceOf(StorageNotFoundError);
    });

    it("readRange rejects with StorageNotFoundError for a missing key", async () => {
      await expect(storage.readRange(`missing-${nanoid()}.mp3`, 0, 99)).rejects.toBeInstanceOf(StorageNotFoundError);
    });

    it("delete removes the object, and deleting again resolves", async () => {
      const key = await putBytes(bytes);
      await storage.delete(key);
      await expect(storage.stat(key)).rejects.toBeInstanceOf(StorageNotFoundError);
      await expect(storage.delete(key)).resolves.toBeUndefined();
    });

    it("keeps the stored copy intact once the caller removes the source file", async () => {
      const key = newKey();
      const src = join(scratch, `src-${nanoid()}.mp3`);
      writeFileSync(src, bytes);
      await storage.put(key, src);
      if (existsSync(src)) rmSync(src);
      expect((await readAll(await storage.readRange(key, 0, 999))).equals(bytes)).toBe(true);
    });
  });
}

storageContract("LocalDiskStorage", async () => new LocalDiskStorage(mkdtempSync(join(tmpdir(), "ttunes-local-"))));

storageContract("S3Storage", async () => makeTestS3Storage(testS3Config!), { skip: !testS3Config });
