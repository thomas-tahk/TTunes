import { minutes } from "./ownerFetch.ts";

export interface QueueRow {
  queueId: string;
  index: number;
  videoId: string;
  title: string;
  durationSec: number;
}
export interface SongRow {
  videoId: string;
  title: string;
  durationSec: number;
}
export interface LogRow {
  id: string;
  what: string;
  at: string;
  details: { title?: string | null; mode?: string; skipped?: { title?: string | null } } | null;
}

const LABELS: Record<string, string> = {
  song_added: "Added",
  song_trashed: "Deleted",
  song_restored: "Restored",
  skip: "Skipped",
  queue_move: "Moved in queue",
  queue_remove: "Removed from queue",
  song_removed: "Removed (unplayable)",
  trash_purged: "Trash emptied",
  request_approve: "Request approved",
  request_deny: "Request denied",
  request_age_restricted: "Request blocked (age-restricted)",
  request_remove: "Request removed",
  request_expired: "Request expired",
  request_keep: "Request kept in library",
  request_mode: "Request mode changed",
};

const Meta = ({ title, sub }: { title: string; sub: string }) => (
  <div className="owner-meta">
    <strong>{title}</strong>
    <span>{sub}</span>
  </div>
);

interface RowButtonProps {
  label: string;
  text: string;
  disabled: boolean;
  onClick: () => void;
}
const RowButton = ({ label, text, disabled, onClick }: RowButtonProps) => (
  <button type="button" className="btn small ghost" disabled={disabled} aria-label={label} onClick={onClick}>
    {text}
  </button>
);

interface QueueListProps {
  rows: QueueRow[];
  busy: boolean;
  onMove: (row: QueueRow, toIndex: number) => void;
  onRemove: (row: QueueRow) => void;
}
export function QueueList({ rows, busy, onMove, onRemove }: QueueListProps) {
  return (
    <ul className="owner-list" data-testid="list-queue">
      {rows.map((r, i) => (
        <li key={r.queueId}>
          <Meta title={r.title} sub={minutes(r.durationSec)} />
          <div className="row-actions">
            <RowButton label={`Move ${r.title} up`} text="Up" disabled={busy || i === 0} onClick={() => onMove(r, i - 1)} />
            <RowButton label={`Move ${r.title} down`} text="Down" disabled={busy || i === rows.length - 1} onClick={() => onMove(r, i + 1)} />
            <RowButton label={`Remove ${r.title} from queue`} text="Remove" disabled={busy} onClick={() => onRemove(r)} />
          </div>
        </li>
      ))}
    </ul>
  );
}

interface SongListProps {
  rows: SongRow[];
  busy: boolean;
  onAct: (row: SongRow) => void;
}
function SongList({ rows, busy, onAct, testId, verb }: SongListProps & { testId: string; verb: string }) {
  return (
    <ul className="owner-list" data-testid={testId}>
      {rows.map((s) => (
        <li key={s.videoId}>
          <Meta title={s.title} sub={minutes(s.durationSec)} />
          <div className="row-actions">
            <RowButton label={`${verb} ${s.title}`} text={verb} disabled={busy} onClick={() => onAct(s)} />
          </div>
        </li>
      ))}
    </ul>
  );
}
export const LibraryList = (props: SongListProps) => <SongList {...props} testId="list-library" verb="Delete" />;
export const TrashList = (props: SongListProps) => <SongList {...props} testId="list-trash" verb="Restore" />;

export function LogList({ rows }: { rows: LogRow[] }) {
  return (
    <ul className="owner-list" data-testid="list-log">
      {rows.map((r) => (
        <li key={r.id}>
          <Meta title={LABELS[r.what] ?? r.what} sub={[r.details?.title ?? r.details?.skipped?.title ?? r.details?.mode, new Date(r.at).toLocaleString()].filter(Boolean).join(" · ")} />
        </li>
      ))}
    </ul>
  );
}
