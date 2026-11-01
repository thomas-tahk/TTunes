import express, { type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { nanoid } from "nanoid";
import { extname } from "node:path";
import { renameSync } from "node:fs";
import { LocalDiskStorage } from "./storage.ts";
import { JsonTrackRepo } from "./repo.ts";
import { YouTubeIngest, IngestError } from "./ingest.ts";
import { readAudioMeta } from "./metadata.ts";
import type { Track } from "./types.ts";

const PORT = Number(process.env.PORT) || 8787;
const UPLOAD_DIR = "uploads"; // local adapter; swaps to R2 later (design spec §9)
const DATA_FILE = "data/tracks.json"; // local adapter; swaps to Postgres later
const STAGING_DIR = "staging"; // holds extracted audio until the user confirms

const storage = new LocalDiskStorage(UPLOAD_DIR);
const repo = new JsonTrackRepo(DATA_FILE);
const ingest = new YouTubeIngest(STAGING_DIR);

const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, nanoid() + extname(file.originalname).toLowerCase()),
  }),
});

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/tracks", (_req: Request, res: Response) => {
  res.json(repo.all());
});

app.post("/api/tracks", upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: "no file uploaded" });
    return;
  }
  const track = await buildTrack(req.file);
  repo.add(track);
  res.status(201).json(track);
});

app.delete("/api/tracks/:id", (req: Request, res: Response) => {
  const removed = repo.remove(String(req.params.id));
  if (!removed) {
    res.status(404).json({ error: "not found" });
    return;
  }
  storage.delete(removed.storageKey); // Delete = purge from library AND storage (spec §6)
  res.status(204).end();
});

// Range-aware streaming so the browser can seek instantly and start playback
// before the full file arrives — the "no buffering" requirement (design spec §5).
app.get("/audio/:id", (req: Request, res: Response) => {
  const track = repo.get(String(req.params.id));
  if (!track) {
    res.status(404).end();
    return;
  }
  const { size } = storage.stat(track.storageKey);
  const contentType = CONTENT_TYPES[extname(track.storageKey)] ?? "application/octet-stream";
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, { "Content-Length": size, "Content-Type": contentType, "Accept-Ranges": "bytes" });
    storage.readRange(track.storageKey, 0, size - 1).pipe(res);
    return;
  }

  const [startRaw, endRaw] = range.replace(/bytes=/, "").split("-");
  const start = Number(startRaw);
  const end = endRaw ? Number(endRaw) : size - 1;
  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": contentType,
  });
  storage.readRange(track.storageKey, start, end).pipe(res);
});

// --- YouTube ingest (design spec §6): stage -> preview -> commit/discard ---

app.post("/api/ingest/youtube", async (req: Request, res: Response) => {
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
});

// Preview the staged audio before committing — the user's "is this the song?" check.
app.get("/api/ingest/youtube/:id/audio", (req: Request, res: Response) => {
  const stream = ingest.stream(String(req.params.id));
  if (!stream) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "audio/mpeg");
  stream.pipe(res);
});

app.post("/api/ingest/youtube/:id/commit", (req: Request, res: Response) => {
  const staged = ingest.get(String(req.params.id));
  if (!staged) {
    res.status(404).json({ error: "staged track not found" });
    return;
  }
  const storageKey = nanoid() + ".mp3";
  renameSync(staged.filePath, storage.destinationFor(storageKey));
  ingest.take(staged.id); // forget staging entry; file now lives in the library
  const track: Track = {
    id: nanoid(),
    title: cleanField(req.body?.title) ?? staged.title,
    artist: cleanField(req.body?.artist) ?? staged.artist,
    album: cleanField(req.body?.album) ?? staged.album,
    durationSec: staged.durationSec,
    bitrate: staged.bitrate,
    format: staged.format,
    sizeBytes: staged.sizeBytes,
    storageKey,
    createdAt: new Date().toISOString(),
  };
  repo.add(track);
  res.status(201).json(track);
});

app.delete("/api/ingest/youtube/:id", (req: Request, res: Response) => {
  ingest.discard(String(req.params.id));
  res.status(204).end();
});

function cleanField(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length ? trimmed : null;
}

async function buildTrack(file: Express.Multer.File): Promise<Track> {
  const meta = await readAudioMeta(file.path);
  return {
    id: nanoid(),
    title: meta.title ?? file.originalname.replace(extname(file.originalname), ""),
    artist: meta.artist ?? "Unknown Artist",
    album: meta.album,
    durationSec: meta.durationSec,
    bitrate: meta.bitrate,
    format: meta.format,
    sizeBytes: file.size,
    storageKey: file.filename,
    createdAt: new Date().toISOString(),
  };
}

app.listen(PORT, () => {
  console.log(`TTunes server on http://localhost:${PORT}`);
});
