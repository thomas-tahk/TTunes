import { useRef, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";
import { activeSkip, resolveTarget, skipUnplayable, type LocalSkip } from "./skip.ts";
import { SongIndicator } from "./SongIndicator.tsx";
import { useYouTubePlayer } from "./useYouTubePlayer.ts";

interface Props {
  playing: NowPlaying;
  serverTime: () => number;
  onPausedChange: (paused: boolean) => void;
}

// Mounted by the Play click, so the browser lets it start with sound. Always visible and unobstructed (YouTube policy).
export function Player({ playing, serverTime, onPausedChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState<LocalSkip | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const target = resolveTarget(playing, local);
  const latest = useRef({ playing, local, target, serverTime });
  latest.current = { playing, local, target, serverTime };

  const player = useYouTubePlayer(host, {
    videoId: target.song.videoId,
    startedAt: target.startedAt,
    isLocalStart: activeSkip(playing, local) !== null,
    expectedSec: () => {
      const { target: t, serverTime: now } = latest.current;
      return Math.min(t.song.durationSec, Math.max(0, (now() - t.startedAt) / 1000));
    },
    onUnplayable: () => {
      const { playing: p, local: l, serverTime: now } = latest.current;
      setLocal(skipUnplayable(p, l, now()));
    },
    onLoadFailed: () => setLoadFailed(true),
    onPausedChange,
  });

  const skip = activeSkip(playing, local);
  const notice = loadFailed
    ? "The YouTube player could not load. Check your connection and reload."
    : skip && `"${skip.skippedTitle}" can't be embedded here, so it was skipped.`;
  return (
    <>
      <div className="player-frame">
        <div ref={host} className="player-host" />
      </div>
      {!loadFailed && <SongIndicator player={player} durationSec={target.song.durationSec} />}
      {notice && <p role="status" className="notice">{notice}</p>}
    </>
  );
}
