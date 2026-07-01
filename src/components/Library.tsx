import type { Track } from "../types.ts";
import type { PlayerControls } from "../usePlayer.ts";

const LOW_BITRATE = 128_000; // below this, flag the file as low quality (spec §6)

function QualityBadge({ track }: { track: Track }) {
  if (!track.format && !track.bitrate) return null;
  const kbps = track.bitrate ? Math.round(track.bitrate / 1000) : null;
  const low = track.bitrate != null && track.bitrate < LOW_BITRATE;
  return (
    <span className={`badge ${low ? "badge--low" : ""}`} title={low ? "Low quality source" : undefined}>
      {track.format ?? "?"}
      {kbps ? ` · ${kbps}k` : ""}
    </span>
  );
}

interface LibraryProps {
  tracks: Track[];
  controls: PlayerControls;
  onDelete: (id: string) => void;
}

export function Library({ tracks, controls, onDelete }: LibraryProps) {
  if (!tracks.length) {
    return <p className="empty">Your station is empty. Add some music to start the shuffle.</p>;
  }

  // Artist-first browse (spec §7).
  const sorted = [...tracks].sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));

  return (
    <ul className="library">
      {sorted.map((track) => (
        <li key={track.id} className={track.id === controls.currentId ? "row row--playing" : "row"}>
          <button className="row__play" onClick={() => controls.playNow(track.id)} title="Play now">
            {track.id === controls.currentId ? "♪" : "▶"}
          </button>
          <div className="row__meta">
            <span className="row__title">{track.title}</span>
            <span className="row__artist">{track.artist}</span>
          </div>
          <QualityBadge track={track} />
          <button
            className="row__queue"
            onClick={() => controls.enqueue(track.id)}
            disabled={!controls.canQueue}
            title={controls.canQueue ? "Add to queue" : "Queue full"}
          >
            + Queue
          </button>
          <button className="row__delete" onClick={() => onDelete(track.id)} title="Delete from library">
            🗑
          </button>
        </li>
      ))}
    </ul>
  );
}
