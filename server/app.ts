import express, { type Express, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { extname } from "node:path";
import { rm } from "node:fs/promises";
import { pipeline, type Readable } from "node:stream";
import { parseFile } from "music-metadata";
import { StorageNotFoundError, type StorageAdapter } from "./storage.ts";
import type { TrackRepo } from "./repo.ts";
import type { Track } from "./types.ts";
import type { Auth } from "./auth.ts";

export interface AppDeps {
  repo: TrackRepo;
  storage: StorageAdapter;
  /** Scratch dir multer writes incoming uploads to before storage.put takes them. */
  uploadDir: string;
  /** Owner-password gate. When present, /api (except login/logout/session) and /audio need a session. */
  auth?: Auth;
  /**
   * Express "trust proxy" setting, so req.ip (and the login lockout keyed on it)
   * is the real client behind a reverse proxy. Fly.io's edge is one hop: TRUST_PROXY=1.
   * Unset = trust nothing (req.ip is the direct peer).
   */
  trustProxy?: boolean | number | string;
}

/** Parses TRUST_PROXY per the express docs: "true"/"false", a hop count, or an IP/subnet list. */
export function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
};

function contentTypeFor(key: string): string {
  return CONTENT_TYPES[extname(key).toLowerCase()] ?? "application/octet-stream";
}

export type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * Parses a single-range `Range` header against a known size.
 * Returns null when the header is absent or malformed (serve the whole file),
 * "unsatisfiable" for a 416, or an inclusive {start, end} clamped to the file.
 */
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    // suffix range: last N bytes
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

export function createApp({ repo, storage, uploadDir, auth, trustProxy }: AppDeps): Express {
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      // temp name differs from the final storage key, so even if uploadDir is the
      // storage dir, cleaning up the temp file can never delete the stored track
      filename: (_req, file, cb) => cb(null, `incoming-${nanoid()}${extname(file.originalname).toLowerCase()}`),
    }),
  });

  const app = express();
  // No CORS middleware: the UI is same-origin (served by this server, or via the
  // vite dev proxy), so cross-origin reads stay blocked by the browser default.
  if (trustProxy !== undefined) app.set("trust proxy", trustProxy);

  // Public liveness probe for the container (outside auth).
  app.get("/health", (_req: Request, res: Response) => {
    res.type("text/plain").send("ok");
  });

  if (auth) {
    app.use(auth.router);
    app.use(["/api", "/audio"], auth.requireSession);
  } else {
    // auth off (dev): the front end asks this before rendering, so report "logged in"
    app.get("/api/session", (_req: Request, res: Response) => {
      res.status(204).end();
    });
  }

  app.get("/api/tracks", async (_req: Request, res: Response) => {
    res.json(await repo.all());
  });

  app.post("/api/tracks", upload.single("file"), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "no file uploaded" });
      return;
    }
    const file = req.file;
    try {
      const ext = extname(file.originalname).toLowerCase();
      const storageKey = nanoid() + ext;
      const track = await buildTrack(file, storageKey);
      await storage.put(storageKey, file.path, contentTypeFor(storageKey));
      try {
        await repo.add(track);
      } catch (err) {
        // don't leave an orphaned object in storage when the catalog write fails
        await storage.delete(storageKey).catch(() => {});
        throw err;
      }
      // remove the scratch file before answering (S3 put copies it); finally covers error paths
      await rm(file.path, { force: true });
      res.status(201).json(track);
    } finally {
      await rm(file.path, { force: true });
    }
  });

  app.delete("/api/tracks/:id", async (req: Request, res: Response) => {
    const removed = await repo.remove(String(req.params.id));
    if (!removed) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // Delete = purge from library AND storage (spec §6). The library is the source
    // of truth, so a storage failure here is logged rather than failing the request.
    try {
      await storage.delete(removed.storageKey);
    } catch (err) {
      console.error(`failed to delete storage object ${removed.storageKey}:`, err);
    }
    res.status(204).end();
  });

  // Range-aware streaming so the browser can seek instantly and start playback
  // before the full file arrives — the "no buffering" requirement (design spec §5).
  app.get("/audio/:id", async (req: Request, res: Response) => {
    const track = await repo.get(String(req.params.id));
    if (!track) {
      res.status(404).end();
      return;
    }
    let size: number;
    try {
      ({ size } = await storage.stat(track.storageKey));
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        res.status(404).end();
        return;
      }
      throw err;
    }
    const contentType = contentTypeFor(track.storageKey);
    const range = parseRange(req.headers.range, size);

    if (range === "unsatisfiable") {
      res.writeHead(416, { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" });
      res.end();
      return;
    }

    const { start, end } = range ?? { start: 0, end: size - 1 };
    const headers: Record<string, string | number> = {
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType,
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;

    if (size === 0) {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    if (req.method === "HEAD") {
      // headers only: don't pull the range from storage just to discard it
      res.writeHead(range ? 206 : 200, headers);
      res.end();
      return;
    }

    let stream: Readable;
    try {
      stream = await storage.readRange(track.storageKey, start, end);
    } catch (err) {
      // deleted between stat and read
      if (err instanceof StorageNotFoundError) {
        res.status(404).end();
        return;
      }
      throw err;
    }
    res.writeHead(range ? 206 : 200, headers);
    // pipeline destroys both sides on error, so a mid-stream failure (or a client
    // disconnect) ends this response instead of crashing the process
    // Record which side failed first (listeners added before pipeline's run first): a
    // listener seeking or closing the tab is routine, but an upstream reset must be logged.
    let clientLeft = false;
    let upstreamFailed = false;
    stream.once("error", () => {
      if (!clientLeft) upstreamFailed = true;
    });
    res.once("close", () => {
      if (!res.writableFinished && !upstreamFailed) clientLeft = true;
    });
    pipeline(stream, res, (err) => {
      const benign =
        err?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
        (clientLeft && (err?.code === "ECONNRESET" || err?.message === "aborted"));
      if (err && !benign) {
        console.error(`stream error for ${track.storageKey}:`, err);
      }
    });
  });

  // Rejected async handlers land here (express 5) — answer 500 instead of hanging.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    // Log message/stack only, never the whole object: body-parser errors carry
    // the raw request body (err.body), and their message can quote it too.
    const type = (err as { type?: unknown } | null)?.type;
    if (typeof type === "string" && type.startsWith("entity.")) console.error(`request body error: ${type}`);
    else console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

async function buildTrack(file: Express.Multer.File, storageKey: string): Promise<Track> {
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
    storageKey,
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
