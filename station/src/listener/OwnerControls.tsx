import { useEffect, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";
import { LibraryList, LogList, QueueList, TrashList, type LogRow, type QueueRow, type SongRow } from "./OwnerLists.tsx";
import { call, messageOf, NETWORK_MESSAGE, restoreNote, type Reply } from "./ownerFetch.ts";

type Tab = "queue" | "library" | "trash" | "log";
type Rows = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; rows: unknown[] };
type Note = { text: string; undo?: SongRow; error?: boolean };

const TABS: { id: Tab; label: string; path: string; key: string }[] = [
  { id: "queue", label: "Queue", path: "/api/owner/queue", key: "queue" },
  { id: "library", label: "Library", path: "/api/owner/library", key: "songs" },
  { id: "trash", label: "Trash", path: "/api/owner/trash", key: "songs" },
  { id: "log", label: "Activity", path: "/api/owner/log?limit=50", key: "entries" },
];
const EMPTY: Record<Tab, string> = {
  queue: "Nothing queued. The station is shuffling the library.",
  library: "The library is empty.",
  trash: "Trash is empty.",
  log: "No activity yet.",
};

/** Fetches the open tab's list; refetches when the tab, `refreshKey` (adds, skips, now/next changes) or a local reload changes. */
function useRows(tab: Tab, refreshKey: string) {
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
  }, [tab, version, refreshKey]);
  return { state, reload: () => setVersion((v) => v + 1), reset: () => setState({ kind: "loading" }) };
}

interface Props {
  playing: NowPlaying | null;
  changes: number;
  onPlaying: (p: NowPlaying) => void;
}

export function OwnerControls({ playing, changes, onPlaying }: Props) {
  const [tab, setTab] = useState<Tab>("queue");
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const { state, reload, reset } = useRows(tab, `${playing?.current?.videoId}|${playing?.next?.videoId}|${changes}`);

  const apply = (body: Record<string, unknown>) => body.playing && onPlaying(body.playing as NowPlaying);
  async function act(run: () => Promise<Reply>, ok: Note | null | ((body: Record<string, unknown>) => Note), on409?: string) {
    setBusy(true);
    try {
      const { status, body } = await run();
      if (status === 200 || (status === 409 && on409)) apply(body);
      if (status === 200) setNote(typeof ok === "function" ? ok(body) : ok);
      else setNote({ text: status === 409 && on409 ? on409 : messageOf(body), error: true });
      reload();
    } catch {
      setNote({ text: NETWORK_MESSAGE, error: true });
    } finally {
      setBusy(false);
    }
  }

  const current = playing?.current?.videoId;
  // /api/owner/skip answers with the bare NowPlaying on 200 (the others wrap it as {playing}), so wrap it for apply().
  const skipCall = async (): Promise<Reply> => {
    const reply = await call("POST", "/api/owner/skip", { expectedVideoId: current });
    return reply.status === 200 ? { status: 200, body: { playing: reply.body } } : reply;
  };
  const skip = () => act(skipCall, { text: "Skipped." }, "That song had already moved on. Refreshed.");
  const move = (r: QueueRow, toIndex: number) => act(() => call("POST", "/api/owner/queue/move", { queueId: r.queueId, toIndex }), null);
  const unqueue = (r: QueueRow) => act(() => call("DELETE", "/api/owner/queue", { queueId: r.queueId }), { text: `Removed "${r.title}" from the queue.` });
  const trash = (s: SongRow) => act(() => call("DELETE", "/api/owner/songs", { videoId: s.videoId }), { text: `Deleted "${s.title}".`, undo: s });
  const restore = (s: SongRow) => act(() => call("POST", "/api/owner/songs/restore", { videoId: s.videoId }), (body) => ({ text: restoreNote(s.title, body) }));
  const rows = state.kind === "ready" ? state.rows : [];

  return (
    <div className="owner-controls">
      <h2 id="controls-heading">Controls</h2>
      <button type="button" className="btn small" disabled={busy || !current} onClick={() => void skip()}>
        Skip song
      </button>
      <div aria-live="polite" className="owner-status">
        {note && (
          <p className={note.error ? "owner-error" : "owner-done"}>
            {note.text}{" "}
            {note.undo && (
              <button type="button" className="link-btn" disabled={busy} onClick={() => void restore(note.undo!)}>
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
        {rows.length > 0 && tab === "queue" && <QueueList rows={rows as QueueRow[]} busy={busy} onMove={(r, i) => void move(r, i)} onRemove={(r) => void unqueue(r)} />}
        {rows.length > 0 && tab === "library" && <LibraryList rows={rows as SongRow[]} busy={busy} onAct={(s) => void trash(s)} />}
        {rows.length > 0 && tab === "trash" && <TrashList rows={rows as SongRow[]} busy={busy} onAct={(s) => void restore(s)} />}
        {rows.length > 0 && tab === "log" && <LogList rows={rows as LogRow[]} />}
      </div>
    </div>
  );
}
