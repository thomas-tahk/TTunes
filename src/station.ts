import { queueWith, type AddChoice } from "./addChoice.ts";

// Pure "never silent" decisions: manual queue first, then a shuffle cycle over the
// whole library. Tracks added mid-cycle jump to the front of the cycle; deleted
// tracks are dropped. No React, no audio — usePlayer just applies the result.
export interface Station {
  queue: string[];
  unplayed: string[]; // rest of the current shuffle cycle, in play order
  played: string[]; // already heard this cycle
  current: string | null;
}

export type Random = () => number;

export const emptyStation = (): Station => ({ queue: [], unplayed: [], played: [], current: null });

function shuffle(ids: string[], random: Random): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Reconcile with the library: drop deleted ids, put brand-new ids at the front of the cycle. */
export function sync(station: Station, library: string[], random: Random): Station {
  const alive = new Set(library);
  const keep = (ids: string[]) => ids.filter((id) => alive.has(id));
  const unplayed = keep(station.unplayed);
  const played = keep(station.played);
  const known = new Set([...unplayed, ...played, ...(station.current ? [station.current] : [])]);
  const fresh = library.filter((id) => !known.has(id));
  return { ...station, queue: keep(station.queue), unplayed: [...shuffle(fresh, random), ...unplayed], played };
}

function markPlaying(station: Station, id: string): Station {
  const played = station.played.includes(id) ? station.played : [...station.played, id];
  return { ...station, current: id, played, unplayed: station.unplayed.filter((u) => u !== id) };
}

export function playNow(station: Station, id: string): Station {
  return markPlaying(station, id);
}

export function enqueue(station: Station, id: string, choice: Exclude<AddChoice, "now">): Station {
  return { ...station, queue: queueWith(station.queue, id, choice) };
}

function startNewCycle(station: Station, library: string[], random: Random): Station {
  const others = library.filter((id) => id !== station.current);
  const pool = others.length ? others : library; // a one-track library repeats; nothing else can
  return { ...station, played: [], unplayed: shuffle(pool, random) };
}

/** The track to play next and the station after choosing it; id is null only for an empty library. */
export function advance(station: Station, library: string[], random: Random): { id: string | null; station: Station } {
  let synced = sync(station, library, random);
  if (synced.queue.length) {
    const [head, ...queue] = synced.queue;
    return { id: head, station: markPlaying({ ...synced, queue }, head) };
  }
  if (!library.length) return { id: null, station: synced };
  if (!synced.unplayed.length) synced = startNewCycle(synced, library, random);
  const id = synced.unplayed[0];
  return { id, station: markPlaying(synced, id) };
}

/** Best guess at what plays after the current track, for prefetching. Null when unknown (new cycle). */
export function peekNext(station: Station, library: string[]): string | null {
  const alive = new Set(library);
  const queued = station.queue.find((id) => alive.has(id));
  if (queued) return queued;
  const fresh = library.find((id) => id !== station.current && !station.played.includes(id) && !station.unplayed.includes(id));
  return fresh ?? station.unplayed.find((id) => alive.has(id)) ?? null;
}
