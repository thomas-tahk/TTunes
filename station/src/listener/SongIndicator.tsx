import { useEffect, useState, type RefObject } from "react";
import type { YTPlayer } from "./youtube.ts";

type Marker = "on-air" | "paused" | "buffering" | "between" | "waiting";
const LABEL: Record<Marker, string> = { "on-air": "On air", paused: "Paused", buffering: "Buffering", between: "Between songs", waiting: "Waiting" };

// YouTube states: 1 playing, 2 paused, 5 cued, 3 buffering, 0 ended, -1 unstarted (e.g. autoplay blocked).
function markerOf(state: number | undefined): Marker {
  if (state === 1) return "on-air";
  if (state === 2 || state === 5) return "paused";
  if (state === 0) return "between";
  if (state === -1) return "waiting";
  return "buffering";
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/** Honest, calm: progress is the player's own time, the marker is the player's own state. No fake audio motion. */
export function SongIndicator({ player, durationSec }: { player: RefObject<YTPlayer | undefined>; durationSec: number }) {
  const [elapsed, setElapsed] = useState(0);
  const [marker, setMarker] = useState<Marker>("buffering");
  const [said, setSaid] = useState<Marker>("waiting"); // the screen-reader text: the last state that was not a brief buffering
  useEffect(() => {
    const read = () => {
      const p = player.current;
      setElapsed(p ? Math.min(durationSec, Math.max(0, p.getCurrentTime())) : 0);
      const next = markerOf(p?.getPlayerState());
      setMarker(next);
      if (next !== "buffering") setSaid(next);
    };
    read();
    const id = setInterval(read, 500);
    return () => clearInterval(id);
  }, [player, durationSec]);

  const shown = Math.floor(elapsed);
  return (
    <div className={`song-indicator is-${marker}`} data-testid="song-indicator">
      <p className="marker">
        <i aria-hidden="true" />
        <span aria-hidden="true" data-testid="marker-text">{LABEL[marker]}</span>
        <span role="status" className="sr-only">{LABEL[said]}</span>
      </p>
      <div className="progress" role="progressbar" aria-label="Song progress" aria-valuemin={0} aria-valuemax={durationSec} aria-valuenow={shown} aria-valuetext={`${clock(shown)} of ${clock(durationSec)}`}>
        <span style={{ width: `${durationSec > 0 ? (elapsed / durationSec) * 100 : 0}%` }} />
      </div>
      <p className="clock" aria-hidden="true">{clock(shown)} / {clock(durationSec)}</p>
    </div>
  );
}
