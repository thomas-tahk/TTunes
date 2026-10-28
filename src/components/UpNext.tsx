import type { PlayerControls } from "../usePlayer.ts";

// What plays after the current track: the manual queue (removable), else the shuffle pick.
export function UpNext({ player }: { player: PlayerControls }) {
  const station = player.station;
  if (!station?.nowPlaying) return null;
  const { queue, upNext, queueCap } = station;

  return (
    <section className="upnext" aria-label="Up next">
      <h2 className="section-title">
        Up next
        {queue.length > 0 && (
          <span className="section-title__count">
            {queue.length}/{queueCap} queued
          </span>
        )}
      </h2>
      {queue.length > 0 ? (
        <ol className="upnext__list">
          {queue.map((track, i) => (
            <li key={`${i}-${track.id}`} className="upnext__item">
              <span className="upnext__text">
                <span className="upnext__title">{track.title}</span>
                <span className="upnext__artist">{track.artist}</span>
              </span>
              <button
                className="icon-btn"
                onClick={() => player.dequeue(i, track.id)}
                aria-label={`Remove ${track.title} from the queue`}
                title="Remove from queue"
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      ) : upNext ? (
        <p className="upnext__shuffle">
          <span className="upnext__tag">shuffle</span>
          <span className="upnext__text">
            <span className="upnext__title">{upNext.title}</span>
            <span className="upnext__artist">{upNext.artist}</span>
          </span>
        </p>
      ) : null}
      {queue.length >= queueCap && (
        <p className="upnext__full" role="status">
          Queue is full — remove one to add more.
        </p>
      )}
    </section>
  );
}
