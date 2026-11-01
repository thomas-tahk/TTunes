import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rmSync } from "node:fs";
import { extname } from "node:path";

const run = promisify(execFile);

export const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
};

/** A failure with a message safe to show the user and the HTTP status to send. */
export class MediaError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const NOT_MEDIA = () => new MediaError("That file isn't audio or video.", 415);
const NO_SOUND = () => new MediaError("That video has no sound.", 415);
const FFMPEG_MISSING = () => new MediaError("ffmpeg isn't installed — run: brew install ffmpeg", 500);
const EXTRACT_FAILED = () => new MediaError("Couldn't extract the audio from that file.", 500);

interface Stream {
  codec_type: string;
  codec_name: string;
  disposition?: { attached_pic?: number };
}

const isMissingBinary = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

async function probeStreams(path: string): Promise<Stream[]> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path]);
    return JSON.parse(stdout).streams ?? [];
  } catch (err) {
    throw isMissingBinary(err) ? FFMPEG_MISSING() : NOT_MEDIA();
  }
}

async function convert(from: string, to: string, codecArgs: string[]): Promise<void> {
  try {
    await run("ffmpeg", ["-y", "-v", "error", "-i", from, "-vn", ...codecArgs, to]);
  } catch (err) {
    rmSync(to, { force: true });
    throw isMissingBinary(err) ? FFMPEG_MISSING() : EXTRACT_FAILED();
  }
}

/**
 * Makes the file at `path` a plain audio file the server can stream with an audio/* type.
 * Files that are already audio-only with a known extension are left alone; anything else
 * (video, or audio in an .mp4/.webm/.mkv/.mov container) is rewritten next to it —
 * AAC is copied to .m4a, other codecs become .mp3 — and the original is removed.
 * Returns the final path.
 */
export async function keepAudioOnly(path: string): Promise<string> {
  const streams = await probeStreams(path);
  const audio = streams.find((s) => s.codec_type === "audio");
  const hasVideo = streams.some((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!audio) throw hasVideo ? NO_SOUND() : NOT_MEDIA();
  if (!hasVideo && extname(path) in CONTENT_TYPES) return path;

  const isAac = audio.codec_name === "aac";
  const out = path.slice(0, path.length - extname(path).length) + (isAac ? ".m4a" : ".mp3");
  await convert(path, out, isAac ? ["-c:a", "copy"] : ["-c:a", "libmp3lame", "-q:a", "2"]);
  rmSync(path);
  return out;
}
