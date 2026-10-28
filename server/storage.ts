import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

// Storage abstraction (design spec §7): audio I/O lives behind this interface so
// the local-disk adapter below can later be swapped for an S3-compatible one
// (Cloudflare R2, or self-hosted MinIO) with no changes to callers.
export interface StorageAdapter {
  /** Size of the stored object. Rejects with StorageNotFoundError if the key doesn't exist. */
  stat(key: string): Promise<{ size: number }>;
  /** Stream of bytes start..end inclusive. Rejects with StorageNotFoundError if the key doesn't exist. */
  readRange(key: string, start: number, end: number): Promise<Readable>;
  /** Remove the object. Resolves (no error) if it's already gone. */
  delete(key: string): Promise<void>;
  /**
   * Store the local file at sourcePath under key. The adapter may move or copy it;
   * the caller removes sourcePath afterwards if it still exists.
   */
  put(key: string, sourcePath: string, contentType?: string): Promise<void>;
}

/** Thrown by adapters when a key has no stored object; the HTTP layer maps it to 404. */
export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`storage object not found: ${key}`);
    this.name = "StorageNotFoundError";
  }
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export class LocalDiskStorage implements StorageAdapter {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  private pathFor(key: string): string {
    return join(this.baseDir, key);
  }

  async stat(key: string): Promise<{ size: number }> {
    try {
      return { size: (await stat(this.pathFor(key))).size };
    } catch (err) {
      if (isEnoent(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async readRange(key: string, start: number, end: number): Promise<Readable> {
    await this.stat(key); // surface a missing file as a rejection, not a stream error
    return createReadStream(this.pathFor(key), { start, end });
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async put(key: string, sourcePath: string, _contentType?: string): Promise<void> {
    const dest = this.pathFor(key);
    const src = resolve(sourcePath);
    if (src === dest) return; // already in place (upload dir == storage dir)
    await mkdir(this.baseDir, { recursive: true });
    try {
      await rename(src, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      // different filesystem: copy, then drop the source
      await copyFile(src, dest);
      await unlink(src);
    }
  }
}
