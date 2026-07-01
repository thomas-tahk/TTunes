import express, { type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import { nanoid } from "nanoid";
import { extname } from "node:path";
import { parseFile } from "music-metadata";
import { LocalDiskStorage } from "./storage.ts";
import { JsonTrackRepo } from "./repo.ts";
import type { Track } from "./types.ts";

const PORT = 8787;
const UPLOAD_DIR = "uploads"; // local adapter; swaps to R2 later (design spec §9)
const DATA_FILE = "data/tracks.json"; // local adapter; swaps to Postgres later

const storage = new LocalDiskStorage(UPLOAD_DIR);
const repo = new JsonTrackRepo(DATA_FILE);

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

async function buildTrack(file: Express.Multer.File): Promise<Track> {
  const meta = await readMetadata(file.path);
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

interface ParsedMetadata {
  title: string | null;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  bitrate: number | null;
  format: string | null;
}

async function readMetadata(path: string): Promise<ParsedMetadata> {
  try {
    const { common, format } = await parseFile(path);
    return {
      title: common.title ?? null,
      artist: common.artist ?? null,
      album: common.album ?? null,
      durationSec: format.duration ? Math.round(format.duration) : null,
      bitrate: format.bitrate ? Math.round(format.bitrate) : null,
      format: format.container ?? format.codec ?? null,
    };
  } catch {
    return { title: null, artist: null, album: null, durationSec: null, bitrate: null, format: null };
  }
}

app.listen(PORT, () => {
  console.log(`TTunes server on http://localhost:${PORT}`);
});
