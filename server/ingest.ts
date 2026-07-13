import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, rmSync, createReadStream, type ReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { nanoid } from "nanoid";
import { readAudioMeta } from "./metadata.ts";

// One-time YouTube audio extraction into a staging area (design spec §6). Audio
// is pulled to a staging dir first; nothing enters the library until the user
// confirms. Personal use only — see spec §11.

export interface StagedIngest {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  uploader: string | null;
  durationSec: number | null;
  bitrate: number | null;
  format: string | null;
  sizeBytes: number;
  warnings: string[];
}

const YTDLP_TIMEOUT_MS = 120_000;
const MAX_FILESIZE = "80M";
const LONG_TRACK_SEC = 12 * 60;
const ALLOWED_HOSTS = ["youtube.com", "youtu.be", "music.youtube.com", "m.youtube.com", "www.youtube.com"];
const VERSION_FLAGS = ["live", "cover", "remix", "acoustic", "sped up", "nightcore", "reaction", "1 hour", "full album", "hour loop"];

interface StagedEntry extends StagedIngest {
  filePath: string;
}

export class YouTubeIngest {
  private readonly stagingDir: string;
  private readonly entries = new Map<string, StagedEntry>();

  constructor(stagingDir: string) {
    this.stagingDir = resolve(stagingDir);
    if (!existsSync(this.stagingDir)) mkdirSync(this.stagingDir, { recursive: true });
  }

  async stage(url: string): Promise<StagedIngest> {
    if (!isSupportedUrl(url)) {
      throw new IngestError("That doesn't look like a YouTube link. Paste a youtube.com or youtu.be URL.");
    }
    const id = nanoid();
    const info = await runYtDlp(url, join(this.stagingDir, `${id}.%(ext)s`));
    const filePath = join(this.stagingDir, `${id}.mp3`);
    if (!existsSync(filePath)) {
      throw new IngestError("Couldn't get clean audio from that link — it may be too large, region-locked, or not a single track.");
    }

    const audio = await readAudioMeta(filePath);
    const identity = parseIdentity(info);
    const durationSec = audio.durationSec ?? (typeof info.duration === "number" ? Math.round(info.duration) : null);

    const entry: StagedEntry = {
      id,
      title: identity.title,
      artist: identity.artist,
      album: identity.album,
      uploader: info.uploader ?? info.channel ?? null,
      durationSec,
      bitrate: audio.bitrate,
      format: audio.format,
      sizeBytes: statSync(filePath).size,
      warnings: warningsFor(info, durationSec),
      filePath,
    };
    this.entries.set(id, entry);
    return toStaged(entry);
  }

  get(id: string): StagedEntry | undefined {
    return this.entries.get(id);
  }

  stream(id: string): ReadStream | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    return createReadStream(entry.filePath);
  }

  discard(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (existsSync(entry.filePath)) rmSync(entry.filePath);
    this.entries.delete(id);
    return true;
  }

  /** Hand the staged file off to the caller for committing into the library. */
  take(id: string): StagedEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    return entry;
  }
}

export class IngestError extends Error {}

function toStaged(entry: StagedEntry): StagedIngest {
  const { filePath: _filePath, ...staged } = entry;
  return staged;
}

interface YtInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  artist?: string;
  track?: string;
  album?: string;
}

function isSupportedUrl(url: string): boolean {
  try {
    return ALLOWED_HOSTS.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function runYtDlp(url: string, outputTemplate: string): Promise<YtInfo> {
  const args = [
    "-x", "--audio-format", "mp3", "--audio-quality", "0",
    "--no-playlist", "--no-simulate", "--socket-timeout", "30",
    "--max-filesize", MAX_FILESIZE, "--dump-json",
    "-o", outputTemplate, url,
  ];
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn("yt-dlp", args, { timeout: YTDLP_TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", () => rejectPromise(new IngestError("yt-dlp isn't installed or couldn't run.")));
    proc.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new IngestError(lastLine(stderr) || "yt-dlp failed to fetch that link."));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as YtInfo);
      } catch {
        rejectPromise(new IngestError("Couldn't read metadata for that link."));
      }
    });
  });
}

function parseIdentity(info: YtInfo): { title: string; artist: string; album: string | null } {
  const album = info.album ?? null;
  const uploader = (info.uploader ?? info.channel ?? "").trim();
  const rawTitle = (info.title ?? "").trim();

  if (info.track && info.artist) return { title: info.track, artist: info.artist, album };
  if (uploader.endsWith(" - Topic")) {
    return { title: cleanTitle(rawTitle), artist: uploader.replace(/ - Topic$/, "").trim(), album };
  }
  const dash = rawTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) return { title: cleanTitle(dash[2]), artist: dash[1].trim(), album };

  return { title: cleanTitle(rawTitle) || "Untitled", artist: uploader || "Unknown Artist", album };
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s*[([]\s*(official\s*(music\s*)?(video|audio|visualizer|lyric video)?|audio|lyrics?|visualizer|hd|4k|mv)\s*[)\]]/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function warningsFor(info: YtInfo, durationSec: number | null): string[] {
  const warnings: string[] = [];
  if (durationSec != null && durationSec > LONG_TRACK_SEC) {
    warnings.push(`This is ${formatDuration(durationSec)} long — might be a loop, full album, or compilation rather than a single track.`);
  }
  const haystack = `${info.title ?? ""} ${info.uploader ?? ""} ${info.channel ?? ""}`.toLowerCase();
  const hits = VERSION_FLAGS.filter((flag) => haystack.includes(flag));
  if (hits.length) {
    warnings.push(`Looks like it might be a ${hits.join(" / ")} version — add it only if that's what you want.`);
  }
  return warnings;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1].replace(/^ERROR:\s*/i, "").trim() : "";
}
