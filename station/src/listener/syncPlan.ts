export interface SyncState {
  loadedVideoId: string;
  syncedStartedAt: number;
  wasLocalStart: boolean; // the last target was a client-made start after an unplayable skip
}
export interface SyncTarget {
  videoId: string;
  startedAt: number;
  isLocalStart: boolean;
}
export type SyncAction = "none" | "drift" | "load" | "cue";

/** What the player does when the target may have changed. Live position is for Play and a new song only; a listener-paused player gets the new song cued, not started. */
export function planSync(prev: SyncState, next: SyncTarget, player: { listenerPaused: boolean; ended: boolean }): SyncAction {
  const newVideo = prev.loadedVideoId !== next.videoId;
  const newStart = prev.syncedStartedAt !== next.startedAt;
  const handoff = !newVideo && prev.wasLocalStart && !next.isLocalStart; // server caught up with the song we already started locally
  if (!newVideo && handoff && !player.ended) return "none"; // an ended local start needs the live song, or the slot is silent
  if (!newVideo && !newStart) return "drift";
  return player.listenerPaused ? "cue" : "load";
}

export interface PauseState {
  listenerPaused: boolean;
  loading: boolean; // we called loadVideoById/cueVideoById and YouTube has not settled yet
  buffering: boolean; // BUFFERING was seen since our last load/cue
}
export type PauseEvent = "load" | "cue" | "paused" | "playing" | "cued" | "error" | "buffering" | "unstarted";

/** YouTube itself emits PAUSED while replacing a video, so only a PAUSED with no load of ours pending is the listener pausing.
 *  A pause pressed mid-buffer sends no PAUSED at all: the real sequence is load -> UNSTARTED -> BUFFERING -> UNSTARTED, so an UNSTARTED after BUFFERING while our load is pending is that pause. */
export function nextPauseState(s: PauseState, event: PauseEvent): PauseState {
  if (event === "load") return { listenerPaused: false, loading: true, buffering: false };
  if (event === "cue") return { listenerPaused: s.listenerPaused, loading: true, buffering: false };
  if (event === "buffering") return { ...s, buffering: s.loading };
  if (event === "unstarted") return s.loading && s.buffering ? { listenerPaused: true, loading: false, buffering: false } : s;
  if (event === "paused") return s.loading ? s : { ...s, listenerPaused: true };
  if (event === "playing") return { listenerPaused: false, loading: false, buffering: false };
  return { ...s, loading: false, buffering: false }; // cued, error
}

export interface LiveSettle {
  pending: boolean; // the next PLAYING is the first since mount or one of our loads/cues
  forced: boolean; // a cue: always land on live, however close
}
export const LIVE_TOLERANCE_SEC = 1;

/** On that first PLAYING, buffering has put the player behind the schedule: seek to live unless it is already within a second. */
export const shouldSeekToLive = (currentSec: number, expectedSec: number, forced: boolean): boolean =>
  forced || Math.abs(currentSec - expectedSec) > LIVE_TOLERANCE_SEC;
