// A Track is the atomic, playable unit. Artist is first-class (see design spec §4).
export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
  bitrate: number | null; // bits/sec, for the passive quality badge
  format: string | null; // container/codec, e.g. "MP3", "FLAC"
  sizeBytes: number;
  storageKey: string; // opaque key into the StorageAdapter
  createdAt: string;
}
