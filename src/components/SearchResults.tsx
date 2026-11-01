import type { SearchHit } from "../api.ts";

export function SearchResults({
  hits,
  disabled,
  onPick,
}: {
  hits: SearchHit[];
  disabled: boolean;
  onPick: (hit: SearchHit) => void;
}) {
  if (!hits.length) return null;
  return (
    <ul className="yt__results">
      {hits.map((hit) => (
        <li key={hit.url}>
          <button className="yt__result" disabled={disabled} onClick={() => onPick(hit)}>
            <span className="yt__result-title">{hit.title}</span>
            <span className="yt__meta">
              {hit.channel ?? "unknown channel"}
              {hit.durationSec != null && ` · ${formatDuration(hit.durationSec)}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
