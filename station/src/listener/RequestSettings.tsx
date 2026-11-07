import type { Mode } from "./useRequests.ts";
import type { OwnerFeed } from "./useOwnerRequests.ts";

const CHOICES: { mode: Mode; label: string; hint: string }[] = [
  { mode: "open", label: "Open", hint: "Requests are queued right away." },
  { mode: "approve", label: "Approve first", hint: "Every request waits until you approve it." },
  { mode: "off", label: "Off", hint: "Nobody can send requests." },
];

export function RequestSettings({ feed, onMode, onReload }: { feed: OwnerFeed; onMode: (mode: Mode) => void; onReload: () => void }) {
  const waiting = feed.status === "ready" ? feed.waitingCount : 0;
  return (
    <div className="owner-controls request-settings" data-testid="request-settings">
      <h2 id="request-settings-h">
        Requests <span className="chip waiting-badge" data-testid="waiting-badge" aria-label={`${waiting} waiting for approval`}>{waiting}</span>
      </h2>
      {feed.status === "loading" && <p>Loading…</p>}
      {feed.status === "error" && (
        <div role="alert">
          <p className="owner-error">{feed.message}</p>
          <button type="button" className="btn small ghost" onClick={onReload}>Try again</button>
        </div>
      )}
      {feed.status === "ready" && (
        <div role="radiogroup" aria-labelledby="request-settings-h" className="segmented">
          {CHOICES.map((c) => (
            <button key={c.mode} type="button" role="radio" aria-checked={feed.mode === c.mode} className={feed.mode === c.mode ? "seg on" : "seg"} onClick={() => onMode(c.mode)}>
              <strong>{c.label}</strong>
              <small>{c.hint}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
