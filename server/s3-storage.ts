import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { parseBool } from "./env.ts";
import { LocalDiskStorage, StorageNotFoundError, type StorageAdapter } from "./storage.ts";

export interface S3StorageConfig {
  bucket: string;
  /** e.g. https://<account>.r2.cloudflarestorage.com, or http://127.0.0.1:9000 for MinIO. Omit for AWS S3. */
  endpoint?: string;
  /** "auto" is what R2 wants. */
  region?: string;
  /** Omit both to use the SDK's default credential chain. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** MinIO needs path-style; R2 accepts it. Default true. */
  forcePathStyle?: boolean;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

/**
 * StorageAdapter over any S3-compatible store (Cloudflare R2 in prod, MinIO in tests).
 * Audio is still proxied through the server (GET /audio/:id), not served via signed
 * redirect URLs, so it can sit behind the session cookie.
 */
export class S3Storage implements StorageAdapter {
  readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.endpoint = config.endpoint ?? "default AWS endpoint";
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region ?? "auto",
      forcePathStyle: config.forcePathStyle ?? true,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
          : undefined,
      // Only send/verify checksums when an operation requires them: newer SDK defaults
      // add CRC headers that not every S3-compatible store handles.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  /**
   * Confirms the bucket exists and the credentials can reach it. Call at startup:
   * a missing bucket otherwise looks like "every object is missing" (silent 404s).
   * The error message names bucket + endpoint only, never credentials.
   */
  async verify(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
      const status = e.$metadata?.httpStatusCode;
      const reason =
        status === 404 ? "bucket does not exist"
        : status === 403 ? "access denied (check S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY)"
        : status !== undefined ? `HTTP ${status} ${e.name ?? ""}`.trim()
        : `${e.name ?? "Error"}: ${e.message ?? "unreachable"}`;
      throw new Error(`S3 storage check failed for bucket "${this.bucket}" at ${this.endpoint}: ${reason}`, {
        cause: err,
      });
    }
  }

  async stat(key: string): Promise<{ size: number }> {
    let size: number | undefined;
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      size = head.ContentLength;
    } catch (err) {
      if (isNotFound(err)) throw new StorageNotFoundError(key);
      throw err;
    }
    if (size === undefined) throw new Error(`HeadObject returned no ContentLength for ${key}`);
    return { size };
  }

  async readRange(key: string, start: number, end: number): Promise<Readable> {
    try {
      const obj = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
      );
      // In Node the body is an http.IncomingMessage (a Readable).
      return obj.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 DeleteObject succeeds for a missing key.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async put(key: string, sourcePath: string, contentType?: string): Promise<void> {
    // Upload streams from disk and switches to multipart for large files, so a
    // multi-hundred-MB FLAC never sits in memory. The caller removes sourcePath.
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: createReadStream(sourcePath), ContentType: contentType },
    });
    await upload.done();
  }
}

/** Default local-disk dir when S3_BUCKET is unset (dev). */
const LOCAL_STORAGE_DIR = "uploads";

/**
 * S3Storage when S3_BUCKET is set, else LocalDiskStorage(uploads/).
 * Env: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
 * S3_REGION (default "auto"), S3_FORCE_PATH_STYLE (default true).
 */
export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) return new LocalDiskStorage(LOCAL_STORAGE_DIR);

  const accessKeyId = env.S3_ACCESS_KEY_ID || undefined;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY || undefined;
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together");
  }
  const endpoint = env.S3_ENDPOINT || undefined;
  const region = env.S3_REGION || "auto";
  if (!endpoint && region === "auto") {
    // the SDK would silently target s3.auto.amazonaws.com
    throw new Error('S3_BUCKET is set but S3_ENDPOINT is not; set S3_ENDPOINT (e.g. your R2 endpoint), or set a real S3_REGION for AWS S3');
  }
  return new S3Storage({
    bucket,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: parseBool(env.S3_FORCE_PATH_STYLE, true, "S3_FORCE_PATH_STYLE"),
  });
}

/** Startup check: verifies S3 config (no-op for local disk). Rejects with a secret-free message. */
export async function verifyStorage(storage: StorageAdapter): Promise<void> {
  if (storage instanceof S3Storage) await storage.verify();
}

