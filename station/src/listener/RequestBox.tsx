import { useEffect, useRef, useState } from "react";
import { call, messageOf, NETWORK_MESSAGE } from "./ownerFetch.ts";
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

export function RequestBox({ mine, mode, onPosted }: Props) {
  const [name, setName] = useState(savedName);
  const [dedication, setDedication] = useState("");
  const [by, setBy] = useState<"link" | "search">("link");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const nameInput = useRef<HTMLInputElement>(null);

  function submitLink(event: React.FormEvent) {
    event.preventDefault();
    if (by === "link" && link.trim()) void send(link.trim());
  }

  async function send(target: string) {
    if (busy) return;
    if (!name.trim()) {
      setError("Type your name first, then send.");
      nameInput.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const cleaned = oneLine(dedication);
      const body = { link: target, name: name.trim(), ...(cleaned ? { dedication: cleaned } : {}) };
      const { status, body: reply } = await call("POST", "/api/requests", body);
      if (status === 201) {
        saveName(name.trim());
        setLink("");
        setDedication("");
        setSent(true);
        await onPosted(reply.request as PostedRequest);
      } else {
        setError(messageOf(reply));
        await onPosted();
      }
    } catch {
      setError(NETWORK_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

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
          <form onSubmit={submitLink}>
            <label htmlFor="req-name">Your name</label>
            <input id="req-name" ref={nameInput} maxLength={30} autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} />
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
                <input id="req-link" inputMode="url" autoComplete="off" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://youtu.be/…" />
              </>
            ) : (
              <SongSearch
                endpoint="/api/requests/search"
                inputId="req-search"
                label="Song or artist to find"
                buttonLabel="Find"
                renderActions={(pick) => (
                  <div className="owner-actions">
                    <button type="button" className="btn small send" disabled={busy} onClick={() => void send(pick.videoId)}>
                      {busy ? "Sending…" : "Send request"}
                    </button>
                  </div>
                )}
              />
            )}
            <div aria-live="polite">{error && <p className="owner-error" role="alert">{error}</p>}</div>
            {by === "link" && (
              <button type="submit" className="btn send" disabled={!link.trim() || busy}>{busy ? "Sending…" : "Send request"}</button>
            )}
          </form>
        </>
      )}
    </section>
  );
}
