import { useCallback, useEffect, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";
import { call, messageOf, minutes, NETWORK_MESSAGE, type Reply } from "./ownerFetch.ts";

interface QueueRow { queueId: string; index: number; videoId: string; title: string; durationSec: number }
interface SongRow { videoId: string; title: string; durationSec: number }
interface LogRow { id: string; what: string; at: string; details: { title?: string | null; skipped?: { title?: string | null } } | null }
type Tab = "queue" | "library" | "trash" | "log";
type Rows = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; rows: unknown[] };
type Note = { text: string; undo?: { videoId: string; title: string }; error?: boolean };

const TABS: { id: Tab; label: string; path: string; key: string }[] = [
  { id: "queue", label: "Queue", path: "/api/owner/queue", key: "queue" },
  { id: "library", label: "Library", path: "/api/owner/library", key: "songs" },
  { id: "trash", label: "Trash", path: "/api/owner/trash", key: "songs" },
  { id: "log", label: "Activity", path: "/api/owner/log?limit=50", key: "entries" },
];
const LABELS: Record<string, string> = {
  song_added: "Added", song_trashed: "Deleted", song_restored: "Restored", skip: "Skipped", queue_move: "Moved in queue", queue_remove: "Removed from queue",
  song_removed: "Removed (unplayable)", trash_purged: "Trash emptied",
};
const logTitle = (r: LogRow): string => r.details?.title ?? r.details?.skipped?.title ?? "";
const EMPTY: Record<Tab, string> = { queue: "Nothing queued. The station is shuffling the library.", library: "The library is empty.", trash: "Trash is empty.", log: "No activity yet." };

function useRows(tab: Tab, stationKey: string) {
  const [state, setState] = useState<Rows>({ kind: "loading" });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    const spec = TABS.find((t) => t.id === tab)!;
    call("GET", spec.path)
      .then(({ status, body }) => live && setState(status === 200 ? { kind: "ready", rows: body[spec.key] as unknown[] } : { kind: "error", message: messageOf(body) }))
      .catch(() => live && setState({ kind: "error", message: NETWORK_MESSAGE }));
    return () => {
      live = false;
    };
  }, [tab, version, stationKey]); // stationKey: an add/skip elsewhere on the page refreshes the open list
  return { state, reload: () => setVersion((v) => v + 1), reset: () => setState({ kind: "loading" }) };
}

const Meta = ({ title, sub }: { title: string; sub: string }) => (
  <div className="owner-meta">
    <strong>{title}</strong>
    <span>{sub}</span>
  </div>
);

export function OwnerControls({ playing, onPlaying, onRefresh }: { playing: NowPlaying; onPlaying: (p: NowPlaying) => void; onRefresh: () => void }) {
  const [tab, setTab] = useState<Tab>("queue");
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const { state, reload, reset } = useRows(tab, `${playing.current?.videoId}|${playing.next?.videoId}`);

  const act = useCallback(async (run: () => Promise<Reply>, ok: (body: Record<string, unknown>) => void): Promise<number> => {
    setBusy(true);
    try {
      const { status, body } = await run();
      if (status === 200) ok(body);
      else setNote({ text: messageOf(body), error: true });
      return status;
    } catch {
      setNote({ text: NETWORK_MESSAGE, error: true });
      return 0;
    } finally {
      setBusy(false);
    }
  }, []);

  async function skip() {
    const current = playing.current?.videoId;
    if (!current) return;
    const status = await act(() => call("POST", "/api/owner/skip", { expectedVideoId: current }), (body) => {
      onPlaying(body as unknown as NowPlaying);
      setNote({ text: "Skipped." });
      reload();
    });
    if (status === 409) {
      setNote({ text: "That song had already moved on. Refreshed.", error: true });
      onRefresh();
    }
  }
  const done = (n: Note | null) => () => (setNote(n), reload());
  const move = (r: QueueRow, toIndex: number) => act(() => call("POST", "/api/owner/queue/move", { queueId: r.queueId, toIndex }), done(null));
  const unqueue = (r: QueueRow) => act(() => call("DELETE", "/api/owner/queue", { queueId: r.queueId }), done({ text: `Removed "${r.title}" from the queue.` }));
  const trash = (s: SongRow) => act(() => call("DELETE", "/api/owner/songs", { videoId: s.videoId }), done({ text: `Deleted "${s.title}".`, undo: s }));
  const restore = (s: { videoId: string; title: string }) => act(() => call("POST", "/api/owner/songs/restore", { videoId: s.videoId }), done({ text: `Restored "${s.title}".` }));
  const rows = state.kind === "ready" ? state.rows : [];

  return (
    <div className="owner-controls">
      <h2 id="controls-heading">Controls</h2>
      <button type="button" className="btn small" disabled={busy || !playing.current} onClick={() => void skip()}>
        Skip song
      </button>
      <div aria-live="polite" className="owner-status">
        {note && (
          <p className={note.error ? "owner-error" : "owner-done"}>
            {note.text}{" "}
            {note.undo && (
              <button type="button" className="link-btn" onClick={() => void restore(note.undo!)}>
                Undo
              </button>
            )}
          </p>
        )}
      </div>
      <div role="tablist" aria-label="Station lists" className="owner-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "tab on" : "tab"} onClick={() => (t.id === tab ? reload() : (reset(), setTab(t.id)))}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label}>
        {state.kind === "loading" && <p>Loading…</p>}
        {state.kind === "error" && <p className="owner-error" role="alert">{state.message}</p>}
        {state.kind === "ready" && rows.length === 0 && <p className="owner-empty">{EMPTY[tab]}</p>}
        {rows.length > 0 && (
          <ul className="owner-list" data-testid={`list-${tab}`}>
            {tab === "queue" && (rows as QueueRow[]).map((r, i) => (
              <li key={r.queueId}>
                <Meta title={r.title} sub={minutes(r.durationSec)} />
                <div className="row-actions">
                  <button type="button" className="btn small ghost" disabled={busy || i === 0} aria-label={`Move ${r.title} up`} onClick={() => void move(r, i - 1)}>Up</button>
                  <button type="button" className="btn small ghost" disabled={busy || i === rows.length - 1} aria-label={`Move ${r.title} down`} onClick={() => void move(r, i + 1)}>Down</button>
                  <button type="button" className="btn small ghost" disabled={busy} aria-label={`Remove ${r.title} from queue`} onClick={() => void unqueue(r)}>Remove</button>
                </div>
              </li>
            ))}
            {tab === "library" && (rows as SongRow[]).map((s) => (
              <li key={s.videoId}>
                <Meta title={s.title} sub={minutes(s.durationSec)} />
                <div className="row-actions"><button type="button" className="btn small ghost" disabled={busy} aria-label={`Delete ${s.title}`} onClick={() => void trash(s)}>Delete</button></div>
              </li>
            ))}
            {tab === "trash" && (rows as SongRow[]).map((s) => (
              <li key={s.videoId}>
                <Meta title={s.title} sub={minutes(s.durationSec)} />
                <div className="row-actions"><button type="button" className="btn small ghost" disabled={busy} aria-label={`Restore ${s.title}`} onClick={() => void restore(s)}>Restore</button></div>
              </li>
            ))}
            {tab === "log" && (rows as LogRow[]).map((r) => (
              <li key={r.id}>
                <Meta title={LABELS[r.what] ?? r.what} sub={`${logTitle(r)} · ${new Date(r.at).toLocaleString()}`} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
