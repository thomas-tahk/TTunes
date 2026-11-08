import { useEffect, useRef, useState } from "react";
import { call, messageOf, NETWORK_MESSAGE } from "./ownerFetch.ts";
import { SongCard, type SongPick } from "./SongCard.tsx";
import { SongSearch } from "./SongSearch.tsx";
import { type Mine, type Mode, type PostedRequest, saveName, savedName } from "./useRequests.ts";

const MAX_DEDICATION = 140;
const MINE_TEXT: Record<string, string> = {
  waiting: "is waiting for approval.",
  queued: "is queued and will play soon.",
  playing: "is playing now.",
};

function MineNotice({ mine, focusOnShow }: { mine: Mine; focusOnShow: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnShow) ref.current?.focus();
  }, [focusOnShow]);
  return (
    <div className="mine" tabIndex={-1} ref={ref} data-testid="mine">
      <img src={mine.thumbnail} alt="" width={64} height={36} />
      <p>
        Your request, <strong>{mine.title}</strong>, {MINE_TEXT[mine.status] ?? "is in."} You can send another once it has played.
      </p>
    </div>
  );
}

const oneLine = (text: string) => text.replace(/[\s\u00a0]+/g, " ").trim();

interface Props {
  mine: Mine | null;
  mode: Mode | null;
  onPosted: (posted?: PostedRequest) => Promise<void>;
}

type Open = { source: "link" | "search"; videoId: string } | null;

export function RequestBox({ mine, mode, onPosted }: Props) {
  const [name, setName] = useState(savedName);
  const [dedication, setDedication] = useState("");
  const [by, setBy] = useState<"link" | "search">("link");
  const [link, setLink] = useState("");
  const [linked, setLinked] = useState<SongPick | null>(null); // the card for a pasted link
  const [open, setOpen] = useState<Open>(null); // one open card in the whole box
  const [checking, setChecking] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [cardError, setCardError] = useState<{ videoId: string; message: string } | null>(null);

  async function lookUp() {
    if (!link.trim() || checking) return;
    setChecking(true);
    setLinkError("");
    setLinked(null);
    setOpen(null);
    try {
      const { status, body } = await call("GET", `/api/requests/preview?link=${encodeURIComponent(link.trim())}`);
      if (status !== 200) return setLinkError(messageOf(body));
      const pick = body as unknown as SongPick;
      setLinked(pick);
      setOpen({ source: "link", videoId: pick.videoId });
    } catch {
      setLinkError(NETWORK_MESSAGE);
    } finally {
      setChecking(false);
    }
  }

  async function send(pick: SongPick) {
    if (busy) return;
    setCardError(null);
    if (!name.trim()) return setCardError({ videoId: pick.videoId, message: "Type your name first (at the top of this box), then send." });
    setBusy(true);
    try {
      const cleaned = oneLine(dedication);
      const body = { link: pick.videoId, name: name.trim(), ...(cleaned ? { dedication: cleaned } : {}) };
      const { status, body: reply } = await call("POST", "/api/requests", body);
      if (status === 201) {
        saveName(name.trim());
        setLink("");
        setLinked(null);
        setOpen(null);
        setDedication("");
        setSent(true);
        await onPosted(reply.request as PostedRequest);
      } else {
        setCardError({ videoId: pick.videoId, message: messageOf(reply) });
        await onPosted();
      }
    } catch {
      setCardError({ videoId: pick.videoId, message: NETWORK_MESSAGE });
    } finally {
      setBusy(false);
    }
  }

  function openSearchCard(videoId: string | null) {
    setOpen(videoId ? { source: "search", videoId } : null);
    setCardError(null);
    if (videoId) setLinked(null);
  }

  const actionsFor = (pick: SongPick) => (
    <>
      <div className="owner-actions">
        <button type="button" className="btn small" onClick={() => void send(pick)}>Send request</button>
      </div>
      <div aria-live="polite" className="song-card-status">
        {busy && <p>Sending…</p>}
        {cardError?.videoId === pick.videoId && <p className="owner-error" role="alert">{cardError.message}</p>}
      </div>
    </>
  );

  return (
    <section className="request-box" aria-labelledby="req-h">
      <h2 id="req-h">Request a song</h2>
      <div role="status" aria-live="polite">
        {mine && <MineNotice mine={mine} focusOnShow={sent} />}
      </div>
      {!mine && (
        <>
          <p className="hint">
            One request at a time.
            {mode === "approve" && " Every request waits for approval."}
            {mode === "open" && " Music requests play on their own; others wait for approval."}
          </p>
          <form onSubmit={(e) => (e.preventDefault(), by === "link" && void lookUp())}>
            <label htmlFor="req-name">Your name</label>
            <input id="req-name" maxLength={30} autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} />
            <label htmlFor="req-ded">Dedication (optional)</label>
            <textarea
              id="req-ded"
              rows={2}
              maxLength={MAX_DEDICATION}
              value={dedication}
              onChange={(e) => setDedication(e.target.value)}
            />
            <p className="counter" data-testid="counter">{dedication.length}/{MAX_DEDICATION}</p>
            <div className="owner-tabs" role="group" aria-label="How to pick the song">
              <button type="button" className={`tab${by === "link" ? " on" : ""}`} aria-pressed={by === "link"} onClick={() => setBy("link")}>Paste a link</button>
              <button type="button" className={`tab${by === "search" ? " on" : ""}`} aria-pressed={by === "search"} onClick={() => setBy("search")}>Search by name</button>
            </div>
            {by === "link" ? (
              <>
                <label htmlFor="req-link">Song link</label>
                <div className="owner-row">
                  <input id="req-link" inputMode="url" autoComplete="off" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://youtu.be/…" />
                  <button type="submit" className="btn small" disabled={!link.trim()}>Look up</button>
                </div>
                <div aria-live="polite" className="owner-status">
                  {checking && <p>Checking the link…</p>}
                  {linkError && <p className="owner-error" role="alert">{linkError}</p>}
                </div>
                {linked && (
                  <div data-testid="preview">
                    <SongCard pick={linked} open={open?.source === "link"} onToggle={() => setOpen(open?.source === "link" ? null : { source: "link", videoId: linked.videoId })}>
                      {actionsFor(linked)}
                    </SongCard>
                  </div>
                )}
              </>
            ) : (
              <SongSearch
                endpoint="/api/requests/search"
                inputId="req-search"
                label="Song or artist to find"
                buttonLabel="Find"
                openId={open?.source === "search" ? open.videoId : null}
                onOpenChange={openSearchCard}
                renderActions={actionsFor}
              />
            )}
          </form>
        </>
      )}
    </section>
  );
}
