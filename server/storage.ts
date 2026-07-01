import { createReadStream, existsSync, mkdirSync, statSync, rmSync, type ReadStream } from "node:fs";
import { join, resolve } from "node:path";

// Storage abstraction (design spec §7): audio I/O lives behind this interface so
// the local-disk adapter below can later be swapped for an S3-compatible one
// (Cloudflare R2, or self-hosted MinIO) with no changes to callers.
export interface StorageAdapter {
  /** Absolute path/URL callers should never need — streaming goes through the methods. */
  stat(key: string): { size: number };
  readRange(key: string, start: number, end: number): ReadStream;
  delete(key: string): void;
  /** Where multipart uploads should be written for this key (local adapter only). */
  destinationFor(key: string): string;
}

export class LocalDiskStorage implements StorageAdapter {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
  }

  private pathFor(key: string): string {
    return join(this.baseDir, key);
  }

  stat(key: string): { size: number } {
    return { size: statSync(this.pathFor(key)).size };
  }

  readRange(key: string, start: number, end: number): ReadStream {
    return createReadStream(this.pathFor(key), { start, end });
  }

  delete(key: string): void {
    const path = this.pathFor(key);
    if (existsSync(path)) rmSync(path);
  }

  destinationFor(key: string): string {
    return this.pathFor(key);
  }
}
