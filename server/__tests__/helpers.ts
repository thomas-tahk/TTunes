import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import { createApp } from "../app.ts";
import { JsonTrackRepo } from "../repo.ts";
import { LocalDiskStorage } from "../storage.ts";
import { createAuth, type AuthOptions } from "../auth.ts";
import type { Track } from "../types.ts";

export interface TestApp {
  app: Express;
  repo: JsonTrackRepo;
  storage: LocalDiskStorage;
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
 * Builds an app against throwaway temp dirs (JsonTrackRepo + LocalDiskStorage)
 * with one seeded track whose file is `size` deterministic bytes (default 1000, `.mp3`).
 * Pass `auth` to put /api and /audio behind the owner password.
 * Call cleanup() in afterEach.
 */
export async function makeTestApp(
  opts: { size?: number; ext?: string; /** enable the owner-password gate */ auth?: AuthOptions } = {},
): Promise<TestApp> {
  const size = opts.size ?? 1000;
  const ext = opts.ext ?? ".mp3";
  const root = mkdtempSync(join(tmpdir(), "ttunes-test-"));
  const repo = new JsonTrackRepo(join(root, "data", "tracks.json"));
  const storage = new LocalDiskStorage(join(root, "storage"));
  const uploadDir = join(root, "incoming");

  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 256;
  const storageKey = `seed${ext}`;
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

  const app = createApp({ repo, storage, uploadDir, auth: opts.auth ? createAuth(opts.auth) : undefined });
  return {
    app,
    repo,
    storage,
    track,
    bytes,
    root,
    uploadDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
