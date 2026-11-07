import { useState } from "react";
import type { AddChoice } from "../../shared/addChoice.ts";
import type { Track } from "../types.ts";
import { AddChoiceButtons } from "./AddChoiceButtons.tsx";
import { formatDuration } from "../format.ts";
import { SearchResults } from "./SearchResults.tsx";
import {
  ingestYouTube,
  searchYouTube,
  commitIngest,
  discardIngest,
  stagedAudioUrl,
  type SearchHit,
  type StagedIngest,
} from "../api.ts";

export function YouTubeAdd({ onAdded }: { onAdded: (track: Track, choice: AddChoice) => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [staged, setStaged] = useState<StagedIngest | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  // Same staging path for a pasted link and a clicked search result.
  const stage = (link: string) =>
    run(async () => {
      setStaged(await ingestYouTube(link));
    }, "Couldn't fetch that link.");

  const search = (query: string) =>
    run(async () => {
      setHits([]);
      const found = await searchYouTube(query);
      setHits(found);
      if (!found.length) setError("No results found.");
    }, "Search failed.");

  function handleSubmit() {
    const text = url.trim();
    if (!text || busy) return;
    if (!/^https?:\/\//i.test(text)) {
      void search(text);
      return;
    }
    setHits([]);
    void stage(text);
  }

  async function handleAdd(edits: { title: string; artist: string; album: string }, choice: AddChoice) {
    if (!staged) return;
    setBusy(true);
    setError(null);
    try {
      const track = await commitIngest(staged.id, edits);
      setStaged(null);
      setHits([]);
      setUrl("");
      await onAdded(track, choice);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that track.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscard() {
    if (!staged) return;
    await discardIngest(staged.id);
    setStaged(null);
  }

  if (staged) {
    return <ConfirmCard staged={staged} busy={busy} error={error} onAdd={handleAdd} onDiscard={handleDiscard} />;
  }

  return (
    <div className="yt">
      <div className="yt__row">
        <input
          className="yt__input"
          type="text"
          placeholder="Paste a YouTube link, or search “artist – song”…"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        />
        <button className="ctrl ctrl--primary" disabled={busy || !url.trim()} onClick={handleSubmit}>
          {busy ? "Working…" : "Go"}
        </button>
      </div>
      {error && <p className="yt__error">{error}</p>}
      <SearchResults hits={hits} disabled={busy} onPick={(hit) => stage(hit.url)} />
    </div>
  );
}

function ConfirmCard({
  staged,
  busy,
  error,
  onAdd,
  onDiscard,
}: {
  staged: StagedIngest;
  busy: boolean;
  error: string | null;
  onAdd: (edits: { title: string; artist: string; album: string }, choice: AddChoice) => void;
  onDiscard: () => void;
}) {
  const [title, setTitle] = useState(staged.title);
  const [artist, setArtist] = useState(staged.artist);
  const [album, setAlbum] = useState(staged.album ?? "");

  return (
    <div className="yt yt--confirm">
      <div className="yt__confirm-head">
        <span className="yt__confirm-label">Ready to add — check it's the right track</span>
        <span className="yt__meta">
          {staged.uploader ?? "unknown source"}
          {staged.durationSec != null && ` · ${formatDuration(staged.durationSec)}`}
        </span>
      </div>

      {staged.warnings.map((w) => (
        <p key={w} className="yt__warning">
          ⚠ {w}
        </p>
      ))}

      <label className="yt__field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="yt__field">
        <span>Artist</span>
        <input value={artist} onChange={(e) => setArtist(e.target.value)} />
      </label>
      <label className="yt__field">
        <span>Album</span>
        <input value={album} placeholder="—" onChange={(e) => setAlbum(e.target.value)} />
      </label>

      <audio className="yt__preview" src={stagedAudioUrl(staged.id)} controls preload="none" />

      {error && <p className="yt__error">{error}</p>}

      <div className="yt__actions">
        <button className="ctrl" disabled={busy} onClick={onDiscard}>
          Discard
        </button>
        <AddChoiceButtons busy={busy} onChoose={(choice) => onAdd({ title, artist, album }, choice)} />
      </div>
    </div>
  );
}
