import { useEffect, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";

interface Preview {
  videoId: string;
  title: string;
  durationSec: number;
  thumbnail: string;
}
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

function minutes(sec: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}` : `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
}

async function post(path: string, body: object): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const messageOf = (body: Record<string, unknown>): string => (typeof body.error === "string" ? body.error : "Something went wrong. Try again.");

export function OwnerPanel({ onAdded }: { onAdded: (playing: NowPlaying) => void }) {
  const [url, setUrl] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });

  async function lookUp(event: React.FormEvent) {
    event.preventDefault();
    setStep({ kind: "busy", what: "Checking the link…" });
    try {
      const { status, body } = await post("/api/owner/preview", { url });
      setStep(status === 200 ? { kind: "preview", preview: body as unknown as Preview } : { kind: "error", message: messageOf(body) });
    } catch {
      setStep({ kind: "error", message: "Couldn't reach the station. Try again." });
    }
  }

  async function add(preview: Preview, position: Position, confirmLong = false) {
    setStep({ kind: "busy", what: "Adding…" });
    try {
      const { status, body } = await post("/api/owner/songs", { videoId: preview.videoId, position, confirmLong });
      if (status === 409) return setStep({ kind: "confirm", preview, position, question: messageOf(body) });
      if (status !== 200) return setStep({ kind: "error", message: messageOf(body) });
      setUrl("");
      setStep({ kind: "done", message: `Added "${preview.title}" ${position === "next" ? "as up next" : "to the end of the queue"}.` });
      onAdded(body.playing as NowPlaying);
    } catch {
      setStep({ kind: "error", message: "Couldn't reach the station. Try again." });
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
    </section>
  );
}
