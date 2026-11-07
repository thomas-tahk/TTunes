import { useEffect, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";
import { OwnerControls } from "./OwnerControls.tsx";
import { call, messageOf, minutes, NETWORK_MESSAGE } from "./ownerFetch.ts";
import { RequestSettings } from "./RequestSettings.tsx";
import { type SearchPick, SongSearch } from "./SongSearch.tsx";
import type { useOwnerRequests } from "./useOwnerRequests.ts";

type Preview = SearchPick;
type Position = "next" | "queue";
type Step =
  | { kind: "idle" }
  | { kind: "busy"; what: string }
  | { kind: "preview"; preview: Preview }
  | { kind: "confirm"; preview: Preview; position: Position; question: string }
  | { kind: "error"; message: string }
  | { kind: "done"; message: string };

/** False until /api/auth/me says otherwise; failures count as "not owner" (listeners must never see an error here). */
export function useOwner(): boolean {
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : { owner: false }))
      .then((body: { owner?: boolean }) => live && setOwner(body.owner === true))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return owner;
}

export function SignInLink({ owner }: { owner: boolean }) {
  if (owner) return <span className="owner-badge">Owner</span>;
  return (
    <a className="signin" href="/api/auth/github/login">
      Sign in
    </a>
  );
}

interface PanelProps {
  playing: NowPlaying | null;
  onPlaying: (playing: NowPlaying) => void;
  requests: ReturnType<typeof useOwnerRequests>;
}

export function OwnerPanel({ playing, onPlaying, requests }: PanelProps) {
  const [adds, setAdds] = useState(0); // bumps on every successful add so the open list refetches
  const [url, setUrl] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });

  async function lookUp(event: React.FormEvent) {
    event.preventDefault();
    setStep({ kind: "busy", what: "Checking the link…" });
    try {
      const { status, body } = await call("POST", "/api/owner/preview", { url });
      setStep(status === 200 ? { kind: "preview", preview: body as unknown as Preview } : { kind: "error", message: messageOf(body) });
    } catch {
      setStep({ kind: "error", message: NETWORK_MESSAGE });
    }
  }

  async function add(preview: Preview, position: Position, confirmLong = false) {
    setStep({ kind: "busy", what: "Adding…" });
    try {
      const { status, body } = await call("POST", "/api/owner/songs", { videoId: preview.videoId, position, confirmLong });
      if (status === 409) return setStep({ kind: "confirm", preview, position, question: messageOf(body) });
      if (status !== 200) return setStep({ kind: "error", message: messageOf(body) });
      setUrl("");
      setStep({ kind: "done", message: `Added "${preview.title}" ${position === "next" ? "as up next" : "to the end of the queue"}.` });
      setAdds((n) => n + 1);
      onPlaying(body.playing as NowPlaying);
    } catch {
      setStep({ kind: "error", message: NETWORK_MESSAGE });
    }
  }

  const preview = step.kind === "preview" || step.kind === "confirm" ? step.preview : null;
  return (
    <section className="owner-panel" aria-labelledby="add-song-heading">
      <h2 id="add-song-heading">Add song</h2>
      <form onSubmit={lookUp} className="owner-form">
        <label htmlFor="song-url">YouTube link</label>
        <div className="owner-row">
          <input id="song-url" type="text" inputMode="url" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube link" />
          <button type="submit" className="btn small" disabled={!url.trim() || step.kind === "busy"}>
            Preview
          </button>
        </div>
      </form>
      <SongSearch endpoint="/api/owner/search" inputId="song-search" label="Search YouTube" buttonLabel="Search" inForm onPick={(pick) => setStep({ kind: "preview", preview: pick })} />
      <div aria-live="polite" className="owner-status">
        {step.kind === "busy" && <p>{step.what}</p>}
        {step.kind === "error" && <p className="owner-error" role="alert">{step.message}</p>}
        {step.kind === "done" && <p className="owner-done">{step.message}</p>}
      </div>
      {preview && (
        <div className="owner-preview" data-testid="preview">
          <img src={preview.thumbnail} alt={`Thumbnail of ${preview.title}`} width={160} height={90} />
          <div className="owner-meta">
            <strong data-testid="preview-title">{preview.title}</strong>
            <span>{minutes(preview.durationSec)}</span>
          </div>
          {step.kind === "preview" && (
            <div className="owner-actions">
              <button type="button" className="btn small" onClick={() => void add(preview, "next")}>
                Play next
              </button>
              <button type="button" className="btn small ghost" onClick={() => void add(preview, "queue")}>
                Add to queue
              </button>
            </div>
          )}
          {step.kind === "confirm" && (
            <div className="owner-confirm" role="alert">
              <p>{step.question}</p>
              <div className="owner-actions">
                <button type="button" className="btn small" onClick={() => void add(preview, step.position, true)}>
                  Add anyway
                </button>
                <button type="button" className="btn small ghost" onClick={() => setStep({ kind: "preview", preview })}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <RequestSettings feed={requests.feed} onMode={(mode) => void requests.setMode(mode)} onReload={() => void requests.reload()} />
      <OwnerControls playing={playing} changes={adds + requests.changes} onPlaying={onPlaying} />
    </section>
  );
}
