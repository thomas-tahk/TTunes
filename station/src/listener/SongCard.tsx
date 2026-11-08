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
  /** Move focus to the first action when the card opens (search results do; a pasted link does not). */
  focusOnOpen?: boolean;
  children: ReactNode;
}

/** One song, collapsed to a button row or expanded in place with a bigger thumbnail, its length and the caller's actions. */
export function SongCard({ pick, open, onToggle, focusOnOpen = true, children }: Props) {
  const head = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const bodyId = `song-card-${pick.videoId}`;
  useEffect(() => {
    if (open && focusOnOpen) body.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open, focusOnOpen]);

  function closeOnEscape(event: React.KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onToggle();
    head.current?.focus();
  }

  return (
    <div className={`song-card${open ? " open" : ""}`} data-testid="song-card">
      <button type="button" ref={head} className="song-card-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <img src={pick.thumbnail} alt="" width={96} height={54} />
        <span className="song-card-meta">
          <strong>{pick.title}</strong>
          <span>{pick.channelTitle ? `${pick.channelTitle} · ` : ""}{minutes(pick.durationSec)}</span>
        </span>
      </button>
      {open && (
        <div id={bodyId} ref={body} className="song-card-body" role="group" aria-label={pick.title} onKeyDown={closeOnEscape}>
          <img className="song-card-art" src={pick.thumbnail} alt={`Thumbnail of ${pick.title}`} width={320} height={180} />
          <p className="song-card-length" data-testid="song-length">Length {minutes(pick.durationSec)}</p>
          <div className="song-card-actions">{children}</div>
        </div>
      )}
    </div>
  );
}
