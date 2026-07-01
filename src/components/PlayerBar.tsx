import type { Track } from "../types.ts";
import type { PlayerControls } from "../usePlayer.ts";

interface PlayerBarProps {
  tracks: Track[];
  controls: PlayerControls;
}

export function PlayerBar({ tracks, controls }: PlayerBarProps) {
  const current = tracks.find((t) => t.id === controls.currentId) ?? null;

  return (
    <footer className="playerbar">
      <div className="playerbar__now">
        {current ? (
          <>
            <span className="playerbar__title">{current.title}</span>
            <span className="playerbar__artist">{current.artist}</span>
          </>
        ) : (
          <span className="playerbar__idle">Nothing playing</span>
        )}
      </div>

      <div className="playerbar__controls">
        {controls.currentId ? (
          <button onClick={controls.toggle} className="ctrl">
            {controls.isPlaying ? "❚❚" : "▶"}
          </button>
        ) : (
          <button onClick={controls.startShuffle} className="ctrl ctrl--primary" disabled={!tracks.length}>
            Shuffle & Play
          </button>
        )}
        <button onClick={controls.next} className="ctrl" disabled={!controls.currentId} title="Next">
          ⏭
        </button>
      </div>

      <div className="playerbar__queue" title="Manual queue">
        {controls.queue.length > 0 ? `${controls.queue.length} queued` : "queue empty"}
      </div>
    </footer>
  );
}
