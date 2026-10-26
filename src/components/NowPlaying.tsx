import { useEffect, useState } from "react";
import type { PlayerControls } from "../usePlayer.ts";

export function formatTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "–:––";
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The "tap to tune in" card: browsers won't start sound without a tap, so before
// this device has started we show what the station is on and one big play button.
export function NowPlaying({ player }: { player: PlayerControls }) {
  const { loadState, station, started, liveOffset } = player;

  // The "pick up at m:ss" hint follows the station while it plays.
  const ticking = !started && !!station?.nowPlaying?.playing;
  const [liveAt, setLiveAt] = useState(() => liveOffset());
  useEffect(() => {
    setLiveAt(liveOffset());
    if (!ticking) return;
    const id = setInterval(() => setLiveAt(liveOffset()), 1000);
    return () => clearInterval(id);
  }, [ticking, station, liveOffset]);

  if (loadState === "loading" && !station) {
    return <p className="state">Tuning in…</p>;
  }
  if (loadState === "error" && !station) {
    return (
      <div className="state state--error" role="alert">
        <span>Couldn't reach the station.</span>
        <button className="ctrl" onClick={() => void player.refresh()}>
          Try again
        </button>
      </div>
    );
  }

  const np = station?.nowPlaying;
  if (started || !np) return null;

  const dur = np.track.durationSec;
  const at = dur != null ? Math.min(liveAt, dur) : liveAt;

  return (
    <section className="hero" aria-label="On air">
      <button className="hero__play" onClick={player.start} aria-label={`Play ${np.track.title}`}>
        <span aria-hidden="true">▶</span>
      </button>
      <div className="hero__meta">
        <span className="hero__label">{np.playing ? "On air now" : "Ready to play"}</span>
        <span className="hero__title">{np.track.title}</span>
        <span className="hero__artist">{np.track.artist}</span>
        <span className="hero__hint">
          Tap to {at >= 1 ? `pick up at ${formatTime(at)}` : "start"}
        </span>
      </div>
    </section>
  );
}
