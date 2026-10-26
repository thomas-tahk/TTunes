import type { TrackRepo } from "./repo.ts";
import {
  QUEUE_CAP,
  StationConflictError,
  type ActivePool,
  type NowPlayingState,
  type StationRepo,
  type StationState,
} from "./station-repo.ts";
import type { Track } from "./types.ts";

// Station logic (design spec §5) over the catalog + station state. The server owns
// the station; devices report position and ask for the next track.
//
// Shuffle: uniform random over the active pool, avoiding the current track when
// there's anything else. Spec §5's "one entry per version group" rule is not applied
// yet — version groups don't exist in M1.
//
// Stale requests. Several devices race: a GET may lazily advance past a finished
// track while the playing device's `ended` handler is about to POST /next, or a
// device may report a position for a track the station has already left. Requests
// that would act on an outdated track are no-ops answered with 200, the *current*
// station and `stale: true`, so the device just adopts what it gets back:
//   - POST /next {fromTrackId}: stale unless fromTrackId is the current track.
//   - PUT /now-playing {trackId}: a position for the current track always applies.
//     A different track replaces the current one only if `fromTrackId` names the
//     current track (the device knowingly switched from it), or the current track
//     isn't playing (e.g. auto-cued and nobody's listening). Otherwise stale.

/** Seconds a playing track may run past its (rounded) durationSec before the station moves on. */
export const END_GRACE_SEC = 2;

export interface StationView {
  nowPlaying: { track: Track; offsetSec: number; playing: boolean; reportedAt: string } | null;
  /** What plays after nowPlaying: the queue head, else the pre-drawn shuffle pick. Prefetch this. */
  upNext: Track | null;
  queue: Track[];
  activePool: ActivePool;
  queueCap: number;
  /** Present (true) only when the request was ignored as stale; the rest is the current station. */
  stale?: true;
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
  /** The track the device believes is current before this report (see "Stale requests"). */
  fromTrackId?: string;
}

/** Library snapshot for one operation. */
interface Library {
  all: Track[];
  byId: Map<string, Track>;
}

/** What an op tells mutate: "stale" = leave the state as normalised, flag the response. */
type OpResult = void | "stale";

const CONFLICT_RETRIES = 3;

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

  /** Current station. May advance (track ran out), cue a first track or draw upNext, and persists that. */
  get(): Promise<StationView> {
    return this.mutate(() => {});
  }

  /** A device reports where it is. */
  report({ trackId, offsetSec, playing, fromTrackId }: PositionReport): Promise<StationView> {
    return this.mutate((s, lib, now) => {
      const track = lib.byId.get(trackId);
      if (!track) throw new StationError(404, "track not found");
      const cur = s.nowPlaying;
      if (cur && fromTrackId !== undefined && fromTrackId !== cur.trackId) return "stale";
      if (cur && trackId !== cur.trackId && fromTrackId !== cur.trackId && cur.playing) return "stale";
      // A report past the end is clamped to the end; the grace period then decides when to move on.
      const offset = track.durationSec != null ? Math.min(offsetSec, track.durationSec) : offsetSec;
      s.nowPlaying = { trackId, offsetSec: offset, playing, reportedAt: iso(now) };
    });
  }

  /** Skip: queue head first, else upNext. Starts playing. */
  next(fromTrackId?: string): Promise<StationView> {
    return this.mutate((s, lib, now) => {
      if (fromTrackId !== undefined && fromTrackId !== s.nowPlaying?.trackId) return "stale";
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

  /** Remove queue entry `index`; with `trackId`, only if that entry is still that track (else 409). */
  dequeue(index: number, trackId?: string): Promise<StationView> {
    return this.mutate((s) => {
      if (!Number.isInteger(index) || index < 0 || index >= s.queue.length) {
        if (trackId !== undefined) throw new StationError(409, "queue changed");
        throw new StationError(404, "no queue entry at that index");
      }
      if (trackId !== undefined && s.queue[index] !== trackId) throw new StationError(409, "queue changed");
      s.queue.splice(index, 1);
    });
  }

  /**
   * Loads the library, then runs one atomic station update: normalise the stored
   * state, apply `op`, normalise again, and persist only if anything changed.
   *
   * The catalog is read before taking the station lock (the Pg update holds a pooled
   * connection while `fn` runs, so `fn` can't need another). A track deleted in that
   * window makes the write fail with StationConflictError; we then re-read and retry.
   */
  private async mutate(op: (s: StationState, lib: Library, now: number) => OpResult): Promise<StationView> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.mutateOnce(op);
      } catch (err) {
        if (!(err instanceof StationConflictError) || attempt >= CONFLICT_RETRIES) throw err;
      }
    }
  }

  private async mutateOnce(op: (s: StationState, lib: Library, now: number) => OpResult): Promise<StationView> {
    const all = await this.tracks.all();
    const lib: Library = { all, byId: new Map(all.map((t) => [t.id, t])) };
    const now = this.now();
    let stale = false;
    const after = await this.station.update((current) => {
      const before = JSON.stringify(current);
      const s = structuredClone(current);
      this.normalise(s, lib, now);
      if (op(s, lib, now) === "stale") stale = true;
      else this.normalise(s, lib, now); // e.g. a report past the end
      return JSON.stringify(s) === before ? null : s;
    });
    const view = this.view(after, lib, now);
    return stale ? { ...view, stale: true } : view;
  }

  private normalise(s: StationState, lib: Library, now: number): void {
    if (s.activePool.kind !== "library") {
      throw new Error(`unsupported active pool: ${JSON.stringify(s.activePool)}`);
    }
    // The JSON store doesn't know about deletes; Pg cascades / SETs NULL, but filtering is harmless.
    s.queue = s.queue.filter((id) => lib.byId.has(id));
    if (s.nowPlaying && !lib.byId.has(s.nowPlaying.trackId)) s.nowPlaying = null;
    if (s.upNext !== null && !lib.byId.has(s.upNext)) s.upNext = null;

    const np = s.nowPlaying;
    if (np) {
      const duration = lib.byId.get(np.trackId)!.durationSec;
      // Unknown duration: we can't tell when it ends, so wait for a device to skip.
      if (np.playing && duration != null && position(np, now) >= duration + END_GRACE_SEC) {
        // Overflow is not carried: the next track starts at 0 as of now.
        this.advance(s, lib, now, true);
      }
    } else {
      // Nothing set yet (or its track was deleted): cue one up, paused.
      this.advance(s, lib, now, false);
    }

    // Keep a shuffle pick ready for prefetch, and never the track that's playing.
    const current = s.nowPlaying?.trackId;
    if (s.upNext === null || (s.upNext === current && lib.all.length > 1)) {
      s.upNext = this.draw(lib, current);
    }
  }

  /** Move to the queue head, else upNext (or a fresh draw). Empty library → nothing playing. */
  private advance(s: StationState, lib: Library, now: number, playing: boolean): void {
    const justPlayed = s.nowPlaying?.trackId;
    let trackId = s.queue.shift();
    if (trackId === undefined) {
      const drawn = s.upNext !== null && (s.upNext !== justPlayed || lib.all.length === 1) ? s.upNext : null;
      trackId = drawn ?? this.draw(lib, justPlayed) ?? undefined;
      s.upNext = null; // consumed; normalise draws the next one
    }
    s.nowPlaying = trackId === undefined ? null : { trackId, offsetSec: 0, playing, reportedAt: iso(now) };
  }

  /** Uniform pick from the pool, avoiding `avoid` when anything else exists. */
  private draw(lib: Library, avoid: string | undefined): string | null {
    const pool = lib.all; // activePool kind "library" (checked in normalise)
    const others = pool.filter((t) => t.id !== avoid);
    const from = others.length ? others : pool;
    return from.length ? from[Math.floor(this.random() * from.length)].id : null;
  }

  private view(s: StationState, lib: Library, now: number): StationView {
    const np = s.nowPlaying;
    const track = np && lib.byId.get(np.trackId);
    const queue = s.queue.flatMap((id) => lib.byId.get(id) ?? []);
    return {
      nowPlaying:
        np && track
          ? {
              track,
              // within the end grace, report the end rather than a position past it
              offsetSec: track.durationSec != null ? Math.min(position(np, now), track.durationSec) : position(np, now),
              playing: np.playing,
              reportedAt: np.reportedAt,
            }
          : null,
      upNext: queue[0] ?? (s.upNext !== null ? (lib.byId.get(s.upNext) ?? null) : null),
      queue,
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
