import type { NowPlaying, Song } from "../../lib/schedule.ts";

export interface Target {
  song: Song;
  startedAt: number; // server epoch ms
}

/** A local override after an embed error. Valid only for the exact server round (video + start) it was made in. */
export interface LocalSkip {
  forVideoId: string;
  forStartedAt: number;
  skippedTitle: string;
  target: Target;
}

const serverTarget = (p: NowPlaying): Target => ({ song: p.current!, startedAt: p.startedAt! });

export function activeSkip(playing: NowPlaying, local: LocalSkip | null): LocalSkip | null {
  if (!local) return null;
  const same = local.forVideoId === playing.current!.videoId && local.forStartedAt === playing.startedAt;
  return same ? local : null;
}

export function resolveTarget(playing: NowPlaying, local: LocalSkip | null): Target {
  return activeSkip(playing, local)?.target ?? serverTarget(playing);
}

/** Embed error: start the server's next song from its beginning until the server's own schedule catches up. */
export function skipUnplayable(playing: NowPlaying, local: LocalSkip | null, nowMs: number): LocalSkip | null {
  if (activeSkip(playing, local)) return local; // the error came from the song we already moved to
  const current = playing.current!;
  const target = playing.next ? { song: playing.next, startedAt: nowMs } : serverTarget(playing);
  return { forVideoId: current.videoId, forStartedAt: playing.startedAt!, skippedTitle: current.title, target };
}
