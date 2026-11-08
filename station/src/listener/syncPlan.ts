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
export function planSync(prev: SyncState, next: SyncTarget, listenerPaused: boolean): SyncAction {
  const newVideo = prev.loadedVideoId !== next.videoId;
  const newStart = prev.syncedStartedAt !== next.startedAt;
  const handoff = !newVideo && prev.wasLocalStart && !next.isLocalStart; // server caught up with the song we already started locally
  if (!newVideo && handoff) return "none";
  if (!newVideo && !newStart) return "drift";
  return listenerPaused ? "cue" : "load";
}
