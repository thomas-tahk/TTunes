import type { AddChoice } from "./addChoice.ts";

// Pure "never silent" decisions: manual queue first, then a shuffle cycle over the
// whole library. Tracks added mid-cycle jump to the front of the cycle; deleted
// tracks are dropped. No React, no audio — usePlayer just applies the result.
export interface Station {
  queue: string[];
  unplayed: string[]; // rest of the current shuffle cycle, in play order
  played: string[]; // already heard this cycle
  current: string | null;
  library: string[]; // library as of the last sync, to tell "deleted" from "not loaded yet"
}

export type Random = () => number;

export const emptyStation = (): Station => ({ queue: [], unplayed: [], played: [], current: null, library: [] });

function shuffle(ids: string[], random: Random): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Reconcile with the library: drop deleted ids, put brand-new ids at the front of the cycle.
 * Queued ids never seen in a library yet are kept (a just-added track may not have loaded).
 */
export function sync(station: Station, library: string[], random: Random): Station {
  const alive = new Set(library);
  const wasListed = new Set(station.library);
  const keep = (ids: string[]) => ids.filter((id) => alive.has(id));
  const queue = station.queue.filter((id) => alive.has(id) || !wasListed.has(id));
  const unplayed = keep(station.unplayed);
  const played = keep(station.played);
  const current = library.length ? station.current : null;
  const known = new Set([...unplayed, ...played, ...(current ? [current] : [])]);
  const fresh = library.filter((id) => !known.has(id));
  return { queue, unplayed: [...shuffle(fresh, random), ...unplayed], played, current, library };
}

function markPlaying(station: Station, id: string): Station {
  const played = station.played.includes(id) ? station.played : [...station.played, id];
  return { ...station, current: id, played, unplayed: station.unplayed.filter((u) => u !== id) };
}

export function playNow(station: Station, id: string): Station {
  return markPlaying(station, id);
}

/** Explicit "+ Queue" on a library row: id goes to the tail (moved if queued), even if it is the current track. */
export function queueLast(station: Station, id: string): Station {
  return { ...station, queue: [...station.queue.filter((q) => q !== id), id] };
}

/**
 * Add a batch the user just chose a placement for. Nothing playing: the first id plays and the
 * rest queue at the head in drop order. Otherwise "now" plays the first and queues the rest next;
 * "next"/"last" put every id at the head/tail in drop order. The current track is never re-queued.
 */
export function addMany(station: Station, ids: string[], choice: AddChoice): Station {
  const startsNow = choice === "now" || !station.current;
  const [first, ...rest] = ids;
  if (startsNow && first !== undefined) {
    const playing = markPlaying(station, first);
    return { ...playing, queue: placed(playing, rest, "next") };
  }
  return { ...station, queue: placed(station, ids, choice === "last" ? "last" : "next") };
}

function placed(station: Station, ids: string[], where: "next" | "last"): string[] {
  const fresh = ids.filter((id) => id !== station.current);
  const others = station.queue.filter((q) => !fresh.includes(q));
  return where === "next" ? [...fresh, ...others] : [...others, ...fresh];
}

// Whole library reshuffled; if the just-played track landed first, swap it away.
function startNewCycle(station: Station, library: string[], random: Random): Station {
  const order = shuffle(library, random);
  if (order.length > 1 && order[0] === station.current) [order[0], order[1]] = [order[1], order[0]];
  return { ...station, played: [], unplayed: order };
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
  const queued = station.queue[0];
  if (queued) return queued;
  const fresh = library.find((id) => id !== station.current && !station.played.includes(id) && !station.unplayed.includes(id));
  return fresh ?? station.unplayed.find((id) => library.includes(id)) ?? null;
}
