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
}

export function defaultStation(): StationState {
  return { activePool: { kind: "library" }, nowPlaying: null, queue: [] };
}

export interface StationRepo {
  get(): Promise<StationState>;
  /**
   * Atomic read-modify-write. `fn` gets the current state and returns the new state,
   * or null to leave it unchanged; it must not do I/O (the Pg version holds a row lock
   * while it runs). Throwing aborts with nothing written. Concurrent updates run one
   * after another, never interleaved. Resolves with the state after the update.
   */
  update(fn: (current: StationState) => StationState | null): Promise<StationState>;
}

const clone = (s: StationState): StationState => structuredClone(s);

/** Dev default: one JSON file. Updates are serialised through a promise chain. */
export class JsonStationRepo implements StationRepo {
  private readonly file: string;
  private state: StationState;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
    this.state = existsSync(file)
      ? { ...defaultStation(), ...(JSON.parse(readFileSync(file, "utf8")) as Partial<StationState>) }
      : defaultStation();
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
