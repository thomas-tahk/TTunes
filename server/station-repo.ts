import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Station state (design spec §4/§5): what the station is playing, from where, and
// what's queued — held server-side so any device resumes where another left off.

/** Manual "play next" queue length cap (spec §5: "≤ ~6"). Mirrors the DB CHECK in 001. */
export const QUEUE_CAP = 6;

/** What the station shuffles. M1 has only the whole library; filters/playlists come later. */
export type ActivePool = { kind: "library" };

export interface NowPlayingState {
  trackId: string;
  /** Position in seconds (fractional) as of reportedAt. */
  offsetSec: number;
  /** ISO timestamp the offset was taken at. */
  reportedAt: string;
  playing: boolean;
}

export interface StationState {
  activePool: ActivePool;
  nowPlaying: NowPlayingState | null;
  /** Track ids, index 0 plays first. Duplicates allowed. */
  queue: string[];
  /** Pre-drawn shuffle pick: plays next once the queue is empty. null = not drawn yet. */
  upNext: string | null;
}

export function defaultStation(): StationState {
  return { activePool: { kind: "library" }, nowPlaying: null, queue: [], upNext: null };
}

/**
 * A write referenced a track that no longer exists (deleted between the caller's
 * catalog read and the write). Nothing was written; re-read the catalog and retry.
 */
export class StationConflictError extends Error {
  constructor(cause?: unknown) {
    super("station write referenced a deleted track", { cause });
    this.name = "StationConflictError";
  }
}

export interface StationRepo {
  get(): Promise<StationState>;
  /**
   * Atomic read-modify-write. `fn` gets the current state and returns the new state,
   * or null to leave it unchanged; it must not do I/O (the Pg version holds a row lock
   * while it runs). Throwing aborts with nothing written. Concurrent updates run one
   * after another, never interleaved. Resolves with the state after the update.
   * May reject with StationConflictError (see there).
   */
  update(fn: (current: StationState) => StationState | null): Promise<StationState>;
}

const clone = (s: StationState): StationState => structuredClone(s);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Parses a stored station, or returns undefined if it isn't one. */
function parseStation(v: unknown): StationState | undefined {
  if (!isObj(v)) return undefined;
  const { activePool, nowPlaying, queue, upNext = null } = v;
  if (!isObj(activePool) || activePool.kind !== "library") return undefined;
  if (!Array.isArray(queue) || queue.length > QUEUE_CAP || !queue.every((id) => typeof id === "string")) {
    return undefined;
  }
  if (upNext !== null && typeof upNext !== "string") return undefined;
  if (nowPlaying !== null) {
    if (!isObj(nowPlaying)) return undefined;
    const { trackId, offsetSec, reportedAt, playing } = nowPlaying;
    if (typeof trackId !== "string" || typeof playing !== "boolean") return undefined;
    if (typeof offsetSec !== "number" || !(offsetSec >= 0)) return undefined;
    if (typeof reportedAt !== "string" || Number.isNaN(Date.parse(reportedAt))) return undefined;
  }
  return {
    activePool: { kind: "library" },
    nowPlaying: nowPlaying as NowPlayingState | null,
    queue: queue as string[],
    upNext: upNext as string | null,
  };
}

/** Dev default: one JSON file. Updates are serialised through a promise chain. */
export class JsonStationRepo implements StationRepo {
  private readonly file: string;
  private state: StationState;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
    this.state = this.load();
  }

  // A corrupt or hand-mangled file must not stop the server: the station is
  // recoverable state (worst case: a fresh shuffle), so log loudly and start over.
  private load(): StationState {
    if (!existsSync(this.file)) return defaultStation();
    let parsed: StationState | undefined;
    try {
      parsed = parseStation(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (err) {
      console.error(`station: can't read ${this.file} (${(err as Error).message}); starting fresh`);
      return defaultStation();
    }
    if (!parsed) {
      console.error(`station: ${this.file} isn't a valid station; starting fresh`);
      return defaultStation();
    }
    return parsed;
  }

  async get(): Promise<StationState> {
    await this.tail.catch(() => {});
    return clone(this.state);
  }

  update(fn: (current: StationState) => StationState | null): Promise<StationState> {
    const run = async (): Promise<StationState> => {
      const next = fn(clone(this.state));
      if (next) {
        await this.persist(next);
        this.state = clone(next);
      }
      return clone(this.state);
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => {});
    return result;
  }

  // Write-then-rename so a crash mid-write never leaves a truncated file.
  private async persist(s: StationState): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2));
    await rename(tmp, this.file);
  }
}
