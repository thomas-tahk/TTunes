import { useEffect, useRef, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";
import { DrawerPanel, type DrawerTab } from "./Drawer.tsx";
import { OwnerAccount } from "./OwnerAccount.tsx";
import { OwnerControls } from "./OwnerControls.tsx";
import { call, messageOf, NETWORK_MESSAGE } from "./ownerFetch.ts";
import { SongCard, type SongPick } from "./SongCard.tsx";
import { SongSearch } from "./SongSearch.tsx";
import type { useOwnerRequests } from "./useOwnerRequests.ts";

type Preview = SongPick;
type Position = "next" | "queue";
type Step =
  | { kind: "idle" }
  | { kind: "busy"; what: string; videoId?: string }
  | { kind: "confirm"; preview: Preview; position: Position; question: string }
  | { kind: "error"; message: string; videoId?: string } // videoId set: the message belongs inside that song's card
  | { kind: "done"; message: string };

export type OwnerState = "unknown" | "owner" | "listener";

/** "unknown" until /api/auth/me answers; failures count as "listener" (listeners must never see an error here). */
export function useOwner(): OwnerState {
  const [state, setState] = useState<OwnerState>("unknown");
  useEffect(() => {
    let live = true;
    const set = (next: OwnerState) => live && setState(next);
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : { owner: false }))
      .then((body: { owner?: boolean }) => set(body.owner === true ? "owner" : "listener"))
      .catch(() => set("listener"));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

export function SignInLink({ owner }: { owner: boolean }) {
  if (owner) return <span className="owner-badge">Owner</span>;
  return (
    <a className="signin" href="/api/auth/github/login">
      Owner sign-in (station owner only)
    </a>
  );
}

interface PanelProps {
  playing: NowPlaying | null;
  onPlaying: (playing: NowPlaying) => void;
  requests: ReturnType<typeof useOwnerRequests>;
  tab: DrawerTab;
}

export function OwnerPanel({ playing, onPlaying, requests, tab }: PanelProps) {
  const [adds, setAdds] = useState(0); // bumps on every successful add so the open list refetches
  const [url, setUrl] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [linked, setLinked] = useState<Preview | null>(null); // the card for a pasted link
  const [open, setOpen] = useState<{ source: "link" | "search"; videoId: string } | null>(null); // one open card across the whole panel
  const status = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step.kind === "done") status.current?.focus(); // the card has collapsed; say what happened where the eye and the screen reader are
  }, [step]);

  async function lookUp(event: React.FormEvent) {
    event.preventDefault();
    if (step.kind === "busy") return;
    setOpen(null);
    setLinked(null);
    setStep({ kind: "busy", what: "Checking the link…" });
    try {
      const { status, body } = await call("POST", "/api/owner/preview", { url });
      if (status !== 200) return setStep({ kind: "error", message: messageOf(body) });
      const pick = body as unknown as Preview;
      setStep({ kind: "idle" });
      setLinked(pick);
      setOpen({ source: "link", videoId: pick.videoId });
    } catch {
      setStep({ kind: "error", message: NETWORK_MESSAGE });
    }
  }

  async function add(preview: Preview, position: Position, confirmLong = false) {
    if (step.kind === "busy") return;
    setStep({ kind: "busy", what: "Adding…", videoId: preview.videoId });
    try {
      const { status, body } = await call("POST", "/api/owner/songs", { videoId: preview.videoId, position, confirmLong });
      if (status === 409) return setStep({ kind: "confirm", preview, position, question: messageOf(body) });
      if (status !== 200) return setStep({ kind: "error", message: messageOf(body), videoId: preview.videoId });
      setUrl("");
      setLinked(null);
      setOpen(null);
      setStep({ kind: "done", message: `Added "${preview.title}" ${position === "next" ? "as up next" : "to the end of the queue"}.` });
      setAdds((n) => n + 1);
      onPlaying(body.playing as NowPlaying);
    } catch {
      setStep({ kind: "error", message: NETWORK_MESSAGE, videoId: preview.videoId });
    }
  }

  function openSearchCard(videoId: string | null) {
    setOpen(videoId ? { source: "search", videoId } : null);
    if (videoId) setLinked(null);
  }

  function actionsFor(pick: SongPick) {
    const mine = (step.kind === "busy" || step.kind === "error") && step.videoId === pick.videoId;
    return (
      <>
        {step.kind === "confirm" && step.preview.videoId === pick.videoId ? (
          <div className="owner-confirm" role="alert">
            <p>{step.question}</p>
            <div className="owner-actions">
              <button type="button" className="btn small" autoFocus onClick={() => void add(pick, step.position, true)}>
                Add anyway
              </button>
              <button type="button" className="btn small ghost" onClick={() => setStep({ kind: "idle" })}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="owner-actions">
            <button type="button" className="btn small" onClick={() => void add(pick, "next")}>
              Play next
            </button>
            <button type="button" className="btn small ghost" onClick={() => void add(pick, "queue")}>
              Add to queue
            </button>
          </div>
        )}
        <div aria-live="polite" className="song-card-status">
          {mine && step.kind === "busy" && <p>{step.what}</p>}
          {mine && step.kind === "error" && <p className="owner-error" role="alert">{step.message}</p>}
        </div>
      </>
    );
  }

  return (
    <div className="owner-panel">
      <DrawerPanel id="add" tab={tab} owner>
      <section aria-labelledby="add-song-heading">
      <h2 id="add-song-heading">Add song</h2>
      <form onSubmit={lookUp} className="owner-form">
        <label htmlFor="song-url">YouTube link</label>
        <div className="owner-row">
          <input id="song-url" type="text" inputMode="url" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube link" />
          <button type="submit" className="btn small" disabled={!url.trim()}>
            Look up
          </button>
        </div>
      </form>
      {linked && (
        <div data-testid="preview">
          <SongCard pick={linked} open={open?.source === "link"} onToggle={() => setOpen(open?.source === "link" ? null : { source: "link", videoId: linked.videoId })}>
            {actionsFor(linked)}
          </SongCard>
        </div>
      )}
      <div aria-live="polite" className="owner-status" tabIndex={-1} ref={status}>
        {step.kind === "busy" && !step.videoId && <p>{step.what}</p>}
        {step.kind === "error" && !step.videoId && <p className="owner-error" role="alert">{step.message}</p>}
        {step.kind === "done" && <p className="owner-done">{step.message}</p>}
      </div>
      <SongSearch endpoint="/api/owner/search" inputId="song-search" label="Search YouTube" buttonLabel="Search" inForm openId={open?.source === "search" ? open.videoId : null} onOpenChange={openSearchCard} renderActions={actionsFor} />
      </section>
      </DrawerPanel>
      <DrawerPanel id="tools" tab={tab} owner>
      <OwnerControls playing={playing} changes={adds + requests.changes} onPlaying={onPlaying} />
      <OwnerAccount />
      </DrawerPanel>
    </div>
  );
}
