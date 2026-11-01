import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rmSync } from "node:fs";
import { extname } from "node:path";

const run = promisify(execFile);

export class NotMediaError extends Error {}

interface Stream {
  codec_type: string;
  codec_name: string;
  disposition?: { attached_pic?: number };
}

async function probeStreams(path: string): Promise<Stream[]> {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path]);
    return JSON.parse(stdout).streams ?? [];
  } catch {
    throw new NotMediaError("That file isn't audio or video.");
  }
}

/**
 * Ensures the file at `path` holds audio only. Video files are replaced by an audio-only
 * file next to them (AAC is copied to .m4a, anything else becomes .mp3); audio files
 * (including MP3s with cover art) are left alone. Returns the final path.
 * Throws NotMediaError when ffprobe finds no audio.
 */
export async function keepAudioOnly(path: string): Promise<string> {
  const streams = await probeStreams(path);
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!audio) throw new NotMediaError("That file isn't audio or video.");
  const hasVideo = streams.some((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!hasVideo) return path;

  const isAac = audio.codec_name === "aac";
  const out = path.slice(0, path.length - extname(path).length) + (isAac ? ".m4a" : ".mp3");
  const codec = isAac ? ["-c:a", "copy"] : ["-c:a", "libmp3lame", "-q:a", "2"];
  await run("ffmpeg", ["-y", "-v", "error", "-i", path, "-vn", ...codec, out]);
  rmSync(path);
  return out;
}
