import type { SearchHit } from "../api.ts";
import { formatDuration } from "../format.ts";

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
