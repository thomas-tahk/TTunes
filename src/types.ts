export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
  bitrate: number | null;
  format: string | null;
  sizeBytes: number;
  storageKey: string;
  createdAt: string;
}
