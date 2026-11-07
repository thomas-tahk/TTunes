import { useState } from "react";
import { call, messageOf, minutes, NETWORK_MESSAGE } from "./ownerFetch.ts";
import type { SearchPick } from "./OwnerSearch.tsx";

interface Result extends SearchPick {
  channelTitle: string;
}
type State = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string } | { kind: "results"; results: Result[] };

export function ListenerSearch({ onPick }: { onPick: (pick: SearchPick) => void }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function search() {
    if (!query.trim()) return;
    setState({ kind: "busy" });
    try {
      const { status, body } = await call("GET", `/api/requests/search?q=${encodeURIComponent(query.trim())}`);
      setState(status === 200 ? { kind: "results", results: body.results as Result[] } : { kind: "error", message: messageOf(body) });
    } catch {
      setState({ kind: "error", message: NETWORK_MESSAGE });
    }
  }

  return (
    <div className="owner-search">
      <label htmlFor="req-search">Song or artist to find</label>
      <div className="owner-row">
        <input
          id="req-search"
          type="search"
          autoComplete="off"
          value={query}
          placeholder="Song or artist"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void search())}
        />
        <button type="button" className="btn small" disabled={!query.trim() || state.kind === "busy"} onClick={() => void search()}>Find</button>
      </div>
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
              <button type="button" className="btn small ghost" aria-label={`Choose ${r.title}`} onClick={() => onPick(r)}>Choose</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
