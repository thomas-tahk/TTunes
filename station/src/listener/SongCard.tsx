import { type ReactNode, useEffect, useRef } from "react";
import { minutes } from "./ownerFetch.ts";

export interface SongPick {
  videoId: string;
  title: string;
  durationSec: number;
  thumbnail: string;
  channelTitle?: string;
}

interface Props {
  pick: SongPick;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/** One song, collapsed to a button row or expanded in place with a bigger thumbnail, its length and the caller's actions (and their messages). */
export function SongCard({ pick, open, onToggle, children }: Props) {
  const head = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const bodyId = `song-card-${pick.videoId}`;
  useEffect(() => {
    if (open) body.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  // On the whole card, so Escape on the header closes the card and not the drawer around it.
  function closeOnEscape(event: React.KeyboardEvent) {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    onToggle();
    head.current?.focus();
  }

  return (
    <div className={`song-card${open ? " open" : ""}`} data-testid="song-card" onKeyDown={closeOnEscape}>
      <button type="button" ref={head} className="song-card-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <img src={pick.thumbnail} alt="" width={96} height={54} />
        <span className="song-card-meta">
          <strong>{pick.title}</strong>
          <span>{pick.channelTitle ? `${pick.channelTitle} · ` : ""}{minutes(pick.durationSec)}</span>
        </span>
      </button>
      {open && (
        <div id={bodyId} ref={body} className="song-card-body" role="group" aria-label={pick.title}>
          <img className="song-card-art" src={pick.thumbnail} alt={`Thumbnail of ${pick.title}`} width={320} height={180} />
          <p className="song-card-length" data-testid="song-length">Length {minutes(pick.durationSec)}</p>
          <div className="song-card-actions">{children}</div>
        </div>
      )}
    </div>
  );
}
