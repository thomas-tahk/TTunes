import { open } from "node:fs/promises";
import { parseFile, type IAudioMetadata } from "music-metadata";

/** The upload is not something the player can play: unparseable, no audio stream, or no duration. */
export class UnplayableAudioError extends Error {
  constructor(reason: string) {
    super(`not a playable audio file: ${reason}`);
    this.name = "UnplayableAudioError";
  }
}

export interface AudioMetadata {
  title: string | null;
  artist: string | null;
  album: string | null;
  /** Whole seconds, always >= 1 (a playable file has a known, positive duration). */
  durationSec: number;
  bitrate: number | null;
  format: string | null;
}

// C0 controls (incl. NUL, which Postgres text rejects) and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * The one cleanup every user-visible metadata string goes through before it becomes
 * part of a Track: control characters removed, whitespace trimmed, empty → null.
 */
export function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS, "").trim();
  return cleaned === "" ? null : cleaned;
}

/**
 * Parses an uploaded file and returns its metadata, or throws UnplayableAudioError.
 * Strings here are raw (not yet cleaned); the caller passes them through cleanText.
 */
export async function readAudioMetadata(path: string): Promise<AudioMetadata> {
  let parsed: IAudioMetadata;
  try {
    parsed = await parseFile(path);
    // Some files (e.g. a VBR MP3 without a Xing header) only yield a duration from a full scan.
    if (!isPositive(parsed.format.duration) && parsed.format.hasAudio) {
      parsed = await parseFile(path, { duration: true });
    }
  } catch (err) {
    throw new UnplayableAudioError(err instanceof Error ? err.message : String(err));
  }
  const { common, format, native } = parsed;
  if (!format.hasAudio) throw new UnplayableAudioError("no audio stream");
  if (!isPositive(format.duration)) throw new UnplayableAudioError("unknown duration");

  let { title, artist, album } = common;
  if (format.container === "WAVE") {
    // music-metadata decodes RIFF INFO as 7-bit ASCII, which turns UTF-8 tags into
    // garbage with NULs in it. Re-read those values as UTF-8 where they came from INFO.
    const info = native.exif ?? [];
    const fromInfo = (id: string, value: string | undefined) =>
      value !== undefined && info.some((t) => t.id === id && t.value === value);
    if (fromInfo("INAM", title) || fromInfo("IART", artist) || fromInfo("IPRD", album)) {
      const utf8 = await readRiffInfo(path).catch(() => new Map<string, string>());
      if (fromInfo("INAM", title) && utf8.has("INAM")) title = utf8.get("INAM");
      if (fromInfo("IART", artist) && utf8.has("IART")) artist = utf8.get("IART");
      if (fromInfo("IPRD", album) && utf8.has("IPRD")) album = utf8.get("IPRD");
    }
  }

  return {
    title: title ?? null,
    artist: artist ?? null,
    album: album ?? null,
    durationSec: Math.max(1, Math.round(format.duration!)),
    bitrate: isPositive(format.bitrate) ? Math.round(format.bitrate!) : null,
    format: format.container ?? format.codec ?? null,
  };
}

function isPositive(n: number | undefined): boolean {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

const MAX_INFO_BYTES = 1 << 20;
const MAX_CHUNKS = 1000;

/**
 * Reads a WAV's LIST/INFO chunk and returns its sub-chunks (INAM, IART, ...) decoded as
 * UTF-8, or Latin-1 when the bytes aren't valid UTF-8. Reads chunk headers only, so a
 * large file isn't loaded into memory.
 */
export async function readRiffInfo(path: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const header = Buffer.alloc(12);
    await fh.read(header, 0, 12, 0);
    if (header.toString("latin1", 0, 4) !== "RIFF" || header.toString("latin1", 8, 12) !== "WAVE") return out;

    let offset = 12;
    const chunk = Buffer.alloc(12);
    for (let n = 0; n < MAX_CHUNKS && offset + 8 <= size; n++) {
      const { bytesRead } = await fh.read(chunk, 0, 12, offset);
      if (bytesRead < 8) break;
      const id = chunk.toString("latin1", 0, 4);
      const chunkSize = chunk.readUInt32LE(4);
      if (id === "LIST" && bytesRead === 12 && chunk.toString("latin1", 8, 12) === "INFO") {
        const len = Math.min(chunkSize - 4, MAX_INFO_BYTES, size - offset - 12);
        const body = Buffer.alloc(Math.max(0, len));
        await fh.read(body, 0, body.length, offset + 12);
        parseInfoBody(body, out);
        return out;
      }
      offset += 8 + chunkSize + (chunkSize & 1);
    }
    return out;
  } finally {
    await fh.close();
  }
}

function parseInfoBody(body: Buffer, out: Map<string, string>): void {
  let p = 0;
  while (p + 8 <= body.length) {
    const id = body.toString("latin1", p, p + 4);
    const len = body.readUInt32LE(p + 4);
    const data = body.subarray(p + 8, Math.min(body.length, p + 8 + len));
    out.set(id, decode(data));
    p += 8 + len + (len & 1);
  }
}

function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}
