import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { nanoid } from "nanoid";
import { createApp } from "../app.ts";
import { JsonTrackRepo } from "../repo.ts";
import { JsonStationRepo } from "../station-repo.ts";
import { LocalDiskStorage, type StorageAdapter } from "../storage.ts";
import { createAuth, type AuthOptions } from "../auth.ts";
import type { Track } from "../types.ts";

/**
 * A valid 16-bit mono PCM WAV of a 440 Hz tone (8 kHz, so 16 KB per second), which
 * music-metadata reads with a real duration. Size = 44 + 16000 * seconds bytes.
 */
export function makeWav(seconds: number, rate = 8000): Buffer {
  const samples = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVE", 8, "latin1");
  buf.write("fmt ", 12, "latin1");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  }
  return buf;
}

/** Bytes of a committed fixture under server/__tests__/fixtures/ (tiny ffmpeg-made 1 s tones). */
export function fixture(name: string): Buffer {
  return readFileSync(join(import.meta.dirname, "fixtures", name));
}

/** Deterministic pseudo-random bytes (LCG), for "corrupt file" uploads that never flake. */
export function noiseBytes(size: number, seed = 1): Buffer {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    buf[i] = x >>> 24;
  }
  return buf;
}

export interface TestApp {
  app: Express;
  repo: JsonTrackRepo;
  storage: StorageAdapter;
  station: JsonStationRepo;
  /** The seeded track (a fake audio file of `size` bytes). */
  track: Track;
  /** Exact bytes stored for the seeded track, for asserting response bodies. */
  bytes: Buffer;
  /** Root temp dir holding data/, storage/ and incoming/; removed by cleanup(). */
  root: string;
  /** Where multer writes uploads before storage.put moves them. */
  uploadDir: string;
  cleanup(): void;
}

/**
 * Builds an app against throwaway temp dirs (JsonTrackRepo + LocalDiskStorage, or
 * the given `storage` adapter) with one seeded track whose file is `size` deterministic bytes (default 1000, `.mp3`).
 * Pass `auth` to put /api and /audio behind the owner password.
 * Call cleanup() in afterEach.
 */
export async function makeTestApp(
  opts: {
    size?: number;
    ext?: string;
    /** storage adapter to use instead of a temp-dir LocalDiskStorage (e.g. S3Storage) */
    storage?: StorageAdapter;
    /** enable the owner-password gate */
    auth?: AuthOptions;
    /** express "trust proxy" setting */
    trustProxy?: boolean | number | string;
    /** built front end to serve (SPA) */
    staticDir?: string;
  } = {},
): Promise<TestApp> {
  const size = opts.size ?? 1000;
  const ext = opts.ext ?? ".mp3";
  const root = mkdtempSync(join(tmpdir(), "ttunes-test-"));
  const repo = new JsonTrackRepo(join(root, "data", "tracks.json"));
  const storage = opts.storage ?? new LocalDiskStorage(join(root, "storage"));
  const uploadDir = join(root, "incoming");

  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 256;
  const storageKey = `seed-${nanoid()}${ext}`; // unique: S3 suites share one bucket
  const src = join(root, `src${ext}`);
  writeFileSync(src, bytes);
  await storage.put(storageKey, src);

  const track: Track = {
    id: "seed-track",
    title: "Seed Track",
    artist: "Test Artist",
    album: null,
    durationSec: null,
    bitrate: null,
    format: null,
    sizeBytes: size,
    storageKey,
    createdAt: new Date(0).toISOString(),
  };
  await repo.add(track);

  const station = new JsonStationRepo(join(root, "data", "station.json"));
  const app = createApp({
    repo,
    storage,
    uploadDir,
    station,
    auth: opts.auth ? createAuth(opts.auth) : undefined,
    trustProxy: opts.trustProxy,
    staticDir: opts.staticDir,
  });
  return {
    app,
    repo,
    storage,
    station,
    track,
    bytes,
    root,
    uploadDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
