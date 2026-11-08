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

export function OwnerSearch({ onPick }: { onPick: (pick: SearchPick) => void }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setState({ kind: "busy" });
    try {
      const { status, body } = await call("GET", `/api/owner/search?q=${encodeURIComponent(query.trim())}`);
      setState(status === 200 ? { kind: "results", results: body.results as Result[] } : { kind: "error", message: messageOf(body) });
    } catch {
      setState({ kind: "error", message: NETWORK_MESSAGE });
    }
  }

  return (
    <div className="owner-search">
      <form onSubmit={search} className="owner-form">
        <label htmlFor="song-search">Search YouTube</label>
        <div className="owner-row">
          <input id="song-search" type="search" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Song or artist" />
          <button type="submit" className="btn small" disabled={!query.trim() || state.kind === "busy"}>
            Search
          </button>
        </div>
      </form>
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
