import type { Express, Request, Response } from "express";
import { extname } from "node:path";
import type { LocalDiskStorage } from "../storage.ts";
import type { TrackRepo } from "../repo.ts";
import { CONTENT_TYPES } from "../extract.ts";
import { sendRanged } from "../range.ts";

export function registerAudioRoutes(app: Express, storage: LocalDiskStorage, repo: TrackRepo): void {
  app.get("/audio/:id", (req: Request, res: Response) => {
    const track = repo.get(String(req.params.id));
    if (!track) {
      res.status(404).end();
      return;
    }
    const key = track.storageKey;
    sendRanged(req, res, {
      size: storage.stat(key).size,
      contentType: CONTENT_TYPES[extname(key)] ?? "application/octet-stream",
      open: (start, end) => storage.readRange(key, start, end),
    });
  });
}
