import type { Express, Request, RequestHandler, Response } from "express";
import { nanoid } from "nanoid";
import { createReadStream, renameSync } from "node:fs";
import type { LocalDiskStorage } from "../storage.ts";
import type { TrackRepo } from "../repo.ts";
import { type YouTubeIngest, IngestError } from "../ingest.ts";
import { sendRanged } from "../range.ts";
import type { Track } from "../types.ts";

interface IngestRoutesDeps {
  storage: LocalDiskStorage;
  repo: TrackRepo;
  ingest: YouTubeIngest;
}

// YouTube ingest (design spec §6): stage -> preview -> commit/discard.
export function registerIngestRoutes(app: Express, deps: IngestRoutesDeps): void {
  app.post("/api/ingest/youtube", stageHandler(deps.ingest));
  app.get("/api/ingest/youtube/:id/audio", previewHandler(deps.ingest));
  app.post("/api/ingest/youtube/:id/commit", commitHandler(deps));
  app.delete("/api/ingest/youtube/:id", discardHandler(deps.ingest));
}

function stageHandler(ingest: YouTubeIngest): RequestHandler {
  return async (req: Request, res: Response) => {
    const url = String(req.body?.url ?? "").trim();
    if (!url) {
      res.status(400).json({ error: "no url provided" });
      return;
    }
    try {
      res.status(201).json(await ingest.stage(url));
    } catch (err) {
      const message = err instanceof IngestError ? err.message : "Failed to fetch that link.";
      res.status(422).json({ error: message });
    }
  };
}

// Preview the staged audio before committing — the user's "is this the song?" check.
function previewHandler(ingest: YouTubeIngest): RequestHandler {
  return (req: Request, res: Response) => {
    const staged = ingest.get(String(req.params.id));
    if (!staged) {
      res.status(404).end();
      return;
    }
    sendRanged(req, res, {
      size: staged.sizeBytes,
      contentType: "audio/mpeg",
      open: (start, end) => createReadStream(staged.filePath, { start, end }),
    });
  };
}

function discardHandler(ingest: YouTubeIngest): RequestHandler {
  return (req: Request, res: Response) => {
    ingest.discard(String(req.params.id));
    res.status(204).end();
  };
}

function commitHandler({ storage, repo, ingest }: IngestRoutesDeps): RequestHandler {
  return (req: Request, res: Response) => {
    const staged = ingest.get(String(req.params.id));
    if (!staged) {
      res.status(404).json({ error: "staged track not found" });
      return;
    }
    const storageKey = nanoid() + ".mp3";
    renameSync(staged.filePath, storage.destinationFor(storageKey));
    ingest.take(staged.id); // forget staging entry; file now lives in the library
    const track = trackFromStaged(staged, storageKey, req.body);
    repo.add(track);
    res.status(201).json(track);
  };
}

function trackFromStaged(staged: NonNullable<ReturnType<YouTubeIngest["get"]>>, storageKey: string, edits: unknown): Track {
  const fields = (edits ?? {}) as Record<string, unknown>;
  return {
    id: nanoid(),
    title: cleanField(fields.title) ?? staged.title,
    artist: cleanField(fields.artist) ?? staged.artist,
    album: cleanField(fields.album) ?? staged.album,
    durationSec: staged.durationSec,
    bitrate: staged.bitrate,
    format: staged.format,
    sizeBytes: staged.sizeBytes,
    storageKey,
    createdAt: new Date().toISOString(),
  };
}

function cleanField(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length ? trimmed : null;
}
