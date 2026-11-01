import { parseFile } from "music-metadata";

// Shared audio-metadata reader used by both the upload path and YouTube ingest,
// so the two agree on how duration/bitrate/format are derived from a file.
export interface AudioMeta {
  title: string | null;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
  bitrate: number | null;
  format: string | null;
}

export async function readAudioMeta(path: string): Promise<AudioMeta> {
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
