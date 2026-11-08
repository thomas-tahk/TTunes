import { useState } from "react";
import { call, messageOf, minutes, NETWORK_MESSAGE } from "./ownerFetch.ts";

export interface SearchPick {
  videoId: string;
  title: string;
  durationSec: number;
  thumbnail: string;
}
interface Result extends SearchPick {
  channelTitle: string;
}
type State = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string } | { kind: "results"; results: Result[] };

interface Props {
  onPick: (pick: SearchPick) => void;
  endpoint: string;
  inputId: string;
  label: string;
  buttonLabel: string;
  /** Owner panel wraps the field in its own form; the request box already sits inside one, so Enter is handled by hand. */
  inForm?: boolean;
}

export function SongSearch({ onPick, endpoint, inputId, label, buttonLabel, inForm = false }: Props) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function search() {
    if (!query.trim()) return;
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
        <ul className="owner-list results" data-testid="search-results">
          {state.results.map((r) => (
            <li key={r.videoId}>
              <img src={r.thumbnail} alt="" width={96} height={54} />
              <div className="owner-meta">
                <strong>{r.title}</strong>
                <span>{r.channelTitle} · {minutes(r.durationSec)}</span>
              </div>
              <button type="button" className="btn small ghost" aria-label={`Choose ${r.title}`} onClick={() => onPick(r)}>
                Choose
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
