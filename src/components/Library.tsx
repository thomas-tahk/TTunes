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
  player: PlayerControls;
  onDelete: (id: string) => void;
}

export function Library({ tracks, player, onDelete }: LibraryProps) {
  if (!tracks.length) return null; // the empty-station prompt above covers this

  // Artist-first browse (spec §7).
  const sorted = [...tracks].sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
  const currentId = player.current?.id;

  return (
    <section aria-label="Library">
      <h2 className="section-title">
        Library <span className="section-title__count">{tracks.length}</span>
      </h2>
      <ul className="library">
        {sorted.map((track) => {
          const playing = track.id === currentId;
          return (
            <li key={track.id} className={playing ? "row row--playing" : "row"}>
              <button
                className="row__play"
                onClick={() => player.playNow(track)}
                aria-label={`Play ${track.title} now`}
                title="Play now"
              >
                <span aria-hidden="true">{playing ? "♪" : "▶"}</span>
              </button>
              <div className="row__meta">
                <span className="row__title">{track.title}</span>
                <span className="row__sub">
                  <span className="row__artist">{track.artist}</span>
                  <QualityBadge track={track} />
                </span>
              </div>
              <div className="row__actions">
                <button
                  className="row__queue"
                  onClick={() => player.enqueue(track.id)}
                  disabled={!player.canQueue}
                  aria-label={player.canQueue ? `Add ${track.title} to the queue` : `Queue full, can't add ${track.title}`}
                  title={player.canQueue ? "Add to queue" : "Queue full"}
                >
                  {player.canQueue ? "+ Queue" : "Queue full"}
                </button>
                <button
                  className="row__delete"
                  onClick={() => onDelete(track.id)}
                  aria-label={`Delete ${track.title}`}
                  title="Delete from library"
                >
                  <span aria-hidden="true">🗑</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
