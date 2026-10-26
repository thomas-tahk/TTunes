import type { PlayerControls } from "../usePlayer.ts";
import { formatTime } from "./NowPlaying.tsx";

export function PlayerBar({ player }: { player: PlayerControls }) {
  const { current, isPlaying, position, duration, notice } = player;
  const max = duration ?? current?.durationSec ?? 0;

  return (
    <footer className="playerbar">
      {notice && (
        <p className="playerbar__notice" role="status">
          {notice}
        </p>
      )}
      <input
        className="playerbar__seek"
        type="range"
        min={0}
        max={max || 1}
        step={1}
        value={Math.min(position, max || 1)}
        disabled={!current || !max || !player.started}
        onChange={(e) => player.seek(Number(e.target.value))}
        aria-label="Seek"
        aria-valuetext={`${formatTime(position)} of ${formatTime(max)}`}
      />
      <div className="playerbar__row">
        <div className="playerbar__now">
          {current ? (
            <>
              <span className="playerbar__title">{current.title}</span>
              <span className="playerbar__artist">
                {current.artist}
                <span className="playerbar__time">
                  {" · "}
                  {formatTime(position)} / {formatTime(max)}
                </span>
              </span>
            </>
          ) : (
            <span className="playerbar__idle">Nothing playing</span>
          )}
        </div>

        <div className="playerbar__controls">
          <button
            onClick={player.toggle}
            className="ctrl ctrl--round ctrl--primary"
            disabled={!current}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            <span aria-hidden="true">{isPlaying ? "❚❚" : "▶"}</span>
          </button>
          <button onClick={player.next} className="ctrl ctrl--round" disabled={!current} aria-label="Next track">
            <span aria-hidden="true">⏭</span>
          </button>
        </div>
      </div>
    </footer>
  );
}
