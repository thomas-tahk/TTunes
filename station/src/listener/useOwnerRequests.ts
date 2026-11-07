import { useCallback, useEffect, useRef, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";
import { call, messageOf, NETWORK_MESSAGE } from "./ownerFetch.ts";
import { createStaleGuard, doneNote, withAllWaiting } from "./ownerRequestsLogic.ts";
import type { FeedItem, Mode } from "./useRequests.ts";

export type Action = "approve" | "deny" | "remove" | "keep";
export interface Note {
  text: string;
  error?: boolean;
}
export type OwnerFeed = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; mode: Mode; waitingCount: number; requests: FeedItem[] };

/**
 * The owner's view of requests (uncached). Reloads on the same trigger as the public feed: `playing` changes identity on join,
 * song change and the 30s re-check. Actions update from their own reply, so there are no timers here.
 */
export function useOwnerRequests(enabled: boolean, playing: NowPlaying | null) {
  const [feed, setFeed] = useState<OwnerFeed>({ status: "loading" });
  const [note, setNote] = useState<Note | null>(null);
  const [kept, setKept] = useState<ReadonlySet<number>>(new Set());
  const [busyId, setBusyId] = useState<number | null>(null);
  const [changes, setChanges] = useState(0); // bumps on every owner action so the Activity and Library lists refetch

  const guard = useRef(createStaleGuard());
  const modeBusy = useRef(false);

  const load = useCallback(async () => {
    const fresh = guard.current.startLoad();
    try {
      const { status, body } = await call("GET", "/api/owner/requests");
      if (!fresh()) return; // an action finished meanwhile; its reply is newer than this list
      if (status !== 200) return setFeed((prev) => (prev.status === "ready" ? prev : { status: "error", message: messageOf(body) }));
      setFeed({ status: "ready", mode: body.mode as Mode, waitingCount: body.waitingCount as number, requests: withAllWaiting(body.requests as FeedItem[], (body.waiting as FeedItem[]) ?? []) });
    } catch {
      setFeed((prev) => (prev.status === "ready" ? prev : { status: "error", message: NETWORK_MESSAGE }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setNote(null); // a note belongs to the last action; a new load (song change, 30s re-check) retires it
    void load();
  }, [enabled, load, playing]);

  const patch = (request: FeedItem, waitingCount: number) =>
    setFeed((prev) => (prev.status === "ready" ? { ...prev, waitingCount, requests: prev.requests.map((r) => (r.id === request.id ? request : r)) } : prev));

  const moderate = useCallback(
    async (id: number, action: Action) => {
      setBusyId(id);
      setNote(null);
      guard.current.actionStarted();
      let gone = false;
      const before = feed.status === "ready" ? feed.requests.find((r) => r.id === id)?.status : undefined;
      try {
        const { status, body } = await call("POST", "/api/owner/requests/moderate", { id, action });
        if (status === 200 || status === 409) patch(body.request as FeedItem, body.waitingCount as number);
        if (status === 200) {
          if (action === "keep") setKept((k) => new Set(k).add(id));
          setNote({ text: body.alreadyInLibrary ? "That song was already in the library." : doneNote(action, before) });
        } else {
          setNote({ text: messageOf(body), error: true });
          gone = status === 404;
        }
        setChanges((n) => n + 1);
      } catch {
        setNote({ text: NETWORK_MESSAGE, error: true });
      } finally {
        guard.current.actionStarted();
        setBusyId(null);
      }
      if (gone) void load(); // after the guard bump, so this reload is not dropped as stale
    },
    [load, feed],
  );

  const setMode = useCallback(async (mode: Mode) => {
    if (modeBusy.current) return;
    modeBusy.current = true;
    setNote(null);
    guard.current.actionStarted();
    try {
      const { status, body } = await call("POST", "/api/owner/requests/mode", { mode });
      if (status !== 200) return setNote({ text: messageOf(body), error: true });
      setFeed((prev) => (prev.status === "ready" ? { ...prev, mode } : prev));
      setChanges((n) => n + 1);
    } catch {
      setNote({ text: NETWORK_MESSAGE, error: true });
    } finally {
      guard.current.actionStarted();
      modeBusy.current = false;
    }
  }, []);

  return { feed, note, kept, busyId, changes, moderate, setMode, reload: load };
}
