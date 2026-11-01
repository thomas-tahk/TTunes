import { useState } from "react";
import {
  ingestYouTube,
  commitIngest,
  discardIngest,
  stagedAudioUrl,
  type StagedIngest,
} from "../api.ts";

export function YouTubeAdd({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [staged, setStaged] = useState<StagedIngest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFetch() {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStaged(await ingestYouTube(trimmed));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't fetch that link.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(edits: { title: string; artist: string; album: string }) {
    if (!staged) return;
    setBusy(true);
    try {
      await commitIngest(staged.id, edits);
      setStaged(null);
      setUrl("");
      onAdded();
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
          type="url"
          placeholder="Paste a YouTube link to add a song…"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleFetch()}
        />
        <button className="ctrl ctrl--primary" disabled={busy || !url.trim()} onClick={handleFetch}>
          {busy ? "Fetching…" : "Fetch"}
        </button>
      </div>
      {error && <p className="yt__error">{error}</p>}
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
  onAdd: (edits: { title: string; artist: string; album: string }) => void;
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
        <button className="ctrl ctrl--primary" disabled={busy} onClick={() => onAdd({ title, artist, album })}>
          {busy ? "Adding…" : "Add to Library"}
        </button>
      </div>
    </div>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
