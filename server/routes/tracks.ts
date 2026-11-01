import type { Express, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { basename, extname } from "node:path";
import { rmSync, statSync } from "node:fs";
import type { LocalDiskStorage } from "../storage.ts";
import type { TrackRepo } from "../repo.ts";
import { readAudioMeta } from "../metadata.ts";
import { keepAudioOnly, MediaError } from "../extract.ts";
import type { Track } from "../types.ts";

interface TrackRoutesDeps {
  storage: LocalDiskStorage;
  repo: TrackRepo;
  uploadDir: string;
}

export function registerTrackRoutes(app: Express, deps: TrackRoutesDeps): void {
  app.get("/api/tracks", (_req: Request, res: Response) => {
    res.json(deps.repo.all());
  });
  app.post("/api/tracks", uploader(deps.uploadDir).single("file"), addTrackHandler(deps.repo));
  app.delete("/api/tracks/:id", deleteTrackHandler(deps));
}

function uploader(uploadDir: string): multer.Multer {
  return multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, cb) => cb(null, nanoid() + extname(file.originalname).toLowerCase()),
    }),
  });
}

function addTrackHandler(repo: TrackRepo): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "no file uploaded" });
      return;
    }
    try {
      const track = await buildTrack(req.file);
      repo.add(track);
      res.status(201).json(track);
    } catch (err) {
      const failure = err instanceof MediaError ? err : new MediaError("Couldn't add that file.", 500);
      res.status(failure.status).json({ error: failure.message });
    }
  };
}

function deleteTrackHandler({ storage, repo }: TrackRoutesDeps): RequestHandler {
  return (req: Request, res: Response) => {
    const removed = repo.remove(String(req.params.id));
    if (!removed) {
      res.status(404).json({ error: "not found" });
      return;
    }
    storage.delete(removed.storageKey); // Delete = purge from library AND storage (spec §6)
    res.status(204).end();
  };
}

// Always leaves the upload dir clean on failure: no original, no partial output.
async function buildTrack(file: Express.Multer.File): Promise<Track> {
  let audioPath = file.path;
  try {
    audioPath = await keepAudioOnly(file.path);
    return await describeTrack(file, audioPath);
  } catch (err) {
    rmSync(file.path, { force: true });
    rmSync(audioPath, { force: true });
    throw err;
  }
}

async function describeTrack(file: Express.Multer.File, audioPath: string): Promise<Track> {
  const meta = await readAudioMeta(audioPath);
  return {
    id: nanoid(),
    title: meta.title ?? file.originalname.replace(extname(file.originalname), ""),
    artist: meta.artist ?? "Unknown Artist",
    album: meta.album,
    durationSec: meta.durationSec,
    bitrate: meta.bitrate,
    format: meta.format,
    sizeBytes: statSync(audioPath).size,
    storageKey: basename(audioPath),
    createdAt: new Date().toISOString(),
  };
}
