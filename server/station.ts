import type { TrackRepo } from "./repo.ts";
import { QUEUE_CAP, type ActivePool, type NowPlayingState, type StationRepo, type StationState } from "./station-repo.ts";
import type { Track } from "./types.ts";

// Station logic (design spec §5) over the catalog + station state. The server owns
// the station; devices report position and ask for the next track.
//
// Shuffle: uniform random over the active pool, avoiding the track that just played
// when there's anything else. Spec §5's "one entry per version group" rule is not
// applied yet — version groups don't exist in M1.

export interface StationView {
  nowPlaying: { track: Track; offsetSec: number; playing: boolean; reportedAt: string } | null;
  queue: Track[];
  activePool: ActivePool;
  queueCap: number;
}

/** A request the station can't honour; the HTTP layer sends `status` + `{ error: message }`. */
export class StationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StationError";
    this.status = status;
  }
}

export interface StationOptions {
  /** ms since epoch; injectable for tests. */
  now?: () => number;
  /** [0, 1); injectable for tests. */
  random?: () => number;
}

export interface PositionReport {
  trackId: string;
  offsetSec: number;
  playing: boolean;
}

/** Library snapshot for one operation. */
interface Library {
  all: Track[];
  byId: Map<string, Track>;
}

export class StationService {
  private readonly tracks: TrackRepo;
  private readonly station: StationRepo;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(tracks: TrackRepo, station: StationRepo, opts: StationOptions = {}) {
    this.tracks = tracks;
    this.station = station;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  /** Current station. May advance (track ran out) or pick a first track, and persists that. */
  get(): Promise<StationView> {
    return this.mutate(() => {});
  }

  /** A device reports where it is. */
  report({ trackId, offsetSec, playing }: PositionReport): Promise<StationView> {
    return this.mutate((s, lib, now) => {
      if (!lib.byId.has(trackId)) throw new StationError(404, "track not found");
      s.nowPlaying = { trackId, offsetSec, playing, reportedAt: iso(now) };
    });
  }

  /** Skip: queue head first, else shuffle. Starts playing. */
  next(): Promise<StationView> {
    return this.mutate((s, lib, now) => {
      this.advance(s, lib, now, true);
    });
  }

  /** Interrupt: play this track now from the start. The queue is untouched. */
  playNow(trackId: string): Promise<StationView> {
    return this.mutate((s, lib, now) => {
      if (!lib.byId.has(trackId)) throw new StationError(404, "track not found");
      s.nowPlaying = { trackId, offsetSec: 0, playing: true, reportedAt: iso(now) };
    });
  }

  enqueue(trackId: string): Promise<StationView> {
    return this.mutate((s, lib) => {
      if (!lib.byId.has(trackId)) throw new StationError(404, "track not found");
      if (s.queue.length >= QUEUE_CAP) throw new StationError(409, "queue full");
      s.queue.push(trackId);
    });
  }

  dequeue(index: number): Promise<StationView> {
    return this.mutate((s) => {
      if (!Number.isInteger(index) || index < 0 || index >= s.queue.length) {
        throw new StationError(404, "no queue entry at that index");
      }
      s.queue.splice(index, 1);
    });
  }

  /**
   * Loads the library, then runs one atomic station update: normalise the stored
   * state (drop deleted tracks, advance past a finished track, pick a first track),
   * apply `op`, and persist only if anything changed.
   */
  private async mutate(op: (s: StationState, lib: Library, now: number) => void): Promise<StationView> {
    // Read the catalog before taking the station lock: the Pg update holds a pooled
    // connection while `fn` runs, so `fn` must not need another one.
    const all = await this.tracks.all();
    const lib: Library = { all, byId: new Map(all.map((t) => [t.id, t])) };
    const now = this.now();
    const after = await this.station.update((current) => {
      const before = JSON.stringify(current);
      const s = structuredClone(current);
      this.normalise(s, lib, now);
      op(s, lib, now);
      return JSON.stringify(s) === before ? null : s;
    });
    return this.view(after, lib, now);
  }

  private normalise(s: StationState, lib: Library, now: number): void {
    if (s.activePool.kind !== "library") {
      throw new Error(`unsupported active pool: ${JSON.stringify(s.activePool)}`);
    }
    // The JSON store doesn't know about deletes; Pg cascades, but filtering is harmless.
    s.queue = s.queue.filter((id) => lib.byId.has(id));
    if (s.nowPlaying && !lib.byId.has(s.nowPlaying.trackId)) s.nowPlaying = null;

    const np = s.nowPlaying;
    if (np) {
      const duration = lib.byId.get(np.trackId)!.durationSec;
      // Unknown duration: we can't tell when it ends, so wait for a device to report/skip.
      if (np.playing && duration != null && position(np, now) >= duration) {
        // Overflow is not carried: the next track starts at 0 as of now.
        this.advance(s, lib, now, true);
      }
    } else {
      // Nothing set yet (or its track was deleted): cue one up, paused.
      this.advance(s, lib, now, false);
    }
  }

  /** Move to the queue head, else a random pool track. Empty library → nothing playing. */
  private advance(s: StationState, lib: Library, now: number, playing: boolean): void {
    const justPlayed = s.nowPlaying?.trackId;
    let trackId = s.queue.shift();
    if (trackId === undefined) {
      const pool = lib.all; // activePool kind "library" (checked in normalise)
      const others = pool.filter((t) => t.id !== justPlayed);
      const from = others.length ? others : pool;
      trackId = from.length ? from[Math.floor(this.random() * from.length)].id : undefined;
    }
    s.nowPlaying = trackId === undefined ? null : { trackId, offsetSec: 0, playing, reportedAt: iso(now) };
  }

  private view(s: StationState, lib: Library, now: number): StationView {
    const np = s.nowPlaying;
    const track = np && lib.byId.get(np.trackId);
    return {
      nowPlaying: np && track ? { track, offsetSec: position(np, now), playing: np.playing, reportedAt: np.reportedAt } : null,
      queue: s.queue.flatMap((id) => lib.byId.get(id) ?? []),
      activePool: s.activePool,
      queueCap: QUEUE_CAP,
    };
  }
}

/** Where playback is at `now`: the stored offset, plus elapsed time while playing. */
function position(np: NowPlayingState, now: number): number {
  if (!np.playing) return np.offsetSec;
  return np.offsetSec + Math.max(0, now - Date.parse(np.reportedAt)) / 1000;
}

const iso = (ms: number) => new Date(ms).toISOString();
