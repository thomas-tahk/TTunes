import { type ReactNode, useState } from "react";
import { call, messageOf, NETWORK_MESSAGE } from "./ownerFetch.ts";
import { SongCard, type SongPick } from "./SongCard.tsx";

type Result = SongPick;
type State = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string } | { kind: "results"; results: Result[] };

interface Props {
  /** The actions shown inside the expanded card for this result. */
  renderActions: (pick: SongPick) => ReactNode;
  /** The video id of the open card, or null. The parent owns it so only one card in the whole panel is open. */
  openId: string | null;
  onOpenChange: (videoId: string | null) => void;
  endpoint: string;
  inputId: string;
  label: string;
  buttonLabel: string;
  /** Owner panel wraps the field in its own form; the request box already sits inside one, so Enter is handled by hand. */
  inForm?: boolean;
}

export function SongSearch({ renderActions, openId, onOpenChange, endpoint, inputId, label, buttonLabel, inForm = false }: Props) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function search() {
    if (!query.trim()) return;
    onOpenChange(null);
    setState({ kind: "busy" });
    try {
      const { status, body } = await call("GET", `${endpoint}?q=${encodeURIComponent(query.trim())}`);
      setState(status === 200 ? { kind: "results", results: body.results as Result[] } : { kind: "error", message: messageOf(body) });
    } catch {
      setState({ kind: "error", message: NETWORK_MESSAGE });
    }
  }

  const field = (
    <>
      <label htmlFor={inputId}>{label}</label>
      <div className="owner-row">
        <input
          id={inputId}
          type="search"
          autoComplete="off"
          value={query}
          placeholder="Song or artist"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={inForm ? undefined : (e) => e.key === "Enter" && (e.preventDefault(), void search())}
        />
        <button
          type={inForm ? "submit" : "button"}
          className="btn small"
          disabled={!query.trim() || state.kind === "busy"}
          onClick={inForm ? undefined : () => void search()}
        >
          {buttonLabel}
        </button>
      </div>
    </>
  );

  return (
    <div className="song-search">
      {inForm ? (
        <form
          className="owner-form"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          {field}
        </form>
      ) : (
        field
      )}
      <div aria-live="polite" className="owner-status">
        {state.kind === "busy" && <p>Searching…</p>}
        {state.kind === "error" && <p className="owner-error" role="alert">{state.message}</p>}
        {state.kind === "results" && state.results.length === 0 && <p>No playable songs found. Try other words.</p>}
      </div>
      {state.kind === "results" && state.results.length > 0 && (
        <ul className="song-results" data-testid="search-results">
          {state.results.map((r) => (
            <li key={r.videoId}>
              <SongCard pick={r} open={openId === r.videoId} onToggle={() => onOpenChange(openId === r.videoId ? null : r.videoId)}>
                {renderActions(r)}
              </SongCard>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
