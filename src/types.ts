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

/** GET /api/station and every station mutation's response (server/station.ts StationView). */
export interface StationView {
  nowPlaying: { track: Track; offsetSec: number; playing: boolean; reportedAt: string } | null;
  /** Queue head, else the pre-drawn shuffle pick. The player prefetches this. */
  upNext: Track | null;
  queue: Track[];
  activePool: { kind: "library" };
  queueCap: number;
  /** true when the server ignored the request as stale; the rest is still the current station. */
  stale?: true;
}
