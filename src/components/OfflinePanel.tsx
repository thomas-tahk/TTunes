import { UNLIMITED, type OfflineLibrary } from "../offline/useOfflineLibrary.ts";

const GB = 1024 ** 3;
const BUDGET_OPTIONS: { label: string; bytes: number }[] = [
  { label: "1 GB", bytes: 1 * GB },
  { label: "2 GB", bytes: 2 * GB },
  { label: "5 GB", bytes: 5 * GB },
  { label: "Unlimited", bytes: UNLIMITED },
];

export function OfflinePanel({ offline, trackCount }: { offline: OfflineLibrary; trackCount: number }) {
  const { isOffline, availableIds, status, progress, usedBytes, budgetBytes, setBudget } = offline;
  const syncing = status === "syncing";

  return (
    <div className="offline">
      <div className="offline__head">
        <span className={`offline__pill ${isOffline ? "offline__pill--off" : "offline__pill--on"}`}>
          {isOffline ? "○ Offline" : "● Online"}
        </span>
        <span className="offline__summary">
          {syncing
            ? `Downloading ${progress.done}/${progress.total}…`
            : `${availableIds.size} of ${trackCount} tracks saved offline`}
          {usedBytes != null && ` · ${formatBytes(usedBytes)} used`}
        </span>
      </div>

      {syncing && progress.total > 0 && (
        <div className="offline__bar">
          <div className="offline__bar-fill" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
        </div>
      )}

      <label className="offline__budget">
        <span>Keep offline up to</span>
        <select
          value={budgetBytes === UNLIMITED ? "unlimited" : String(budgetBytes)}
          onChange={(e) => setBudget(e.target.value === "unlimited" ? UNLIMITED : Number(e.target.value))}
        >
          {BUDGET_OPTIONS.map((o) => (
            <option key={o.label} value={o.bytes === UNLIMITED ? "unlimited" : String(o.bytes)}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
