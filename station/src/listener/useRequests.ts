import { useCallback, useEffect, useRef, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";

export type Mode = "open" | "approve" | "off";
export type RequestStatus = "waiting" | "queued" | "playing" | "played" | "expired";
export interface FeedItem {
  id: number;
  name: string;
  dedication: string | null;
  videoId: string;
  title: string;
  durationSec: number;
  thumbnail: string;
  status: RequestStatus;
  createdAt: string;
}
export interface Mine {
  id: number;
  videoId: string;
  title: string;
  thumbnail: string;
  status: string;
  createdAt: string;
}
export type FeedState = { status: "loading" } | { status: "error" } | { status: "ready"; mode: Mode; requests: FeedItem[] };

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return (await res.json()) as T;
}

/** The POST /api/requests 201 body's `request`. */
export interface PostedRequest {
  id: number;
  name: string;
  dedication: string | null;
  videoId: string;
  title: string;
  durationSec: number;
  thumbnail: string;
  status: RequestStatus;
}
const POSTED_TTL_MS = 15_000;
const ACTIVE = new Set(["waiting", "queued", "playing"]);

/**
 * Feed + the listener's own request. The feed reloads whenever `playing` changes identity: on join, on song change
 * and on the 30s re-check (useStation sets a new object each time). `mine` is fetched on join, after a post, and on
 * each of those reloads (song change or 30s re-check) only while the listener has an active request, so approval or
 * denial shows up. While `mine` is null it is not polled. No timers here.
 */
export function useRequests(playing: NowPlaying | null) {
  const [feed, setFeed] = useState<FeedState>({ status: "loading" });
  const [mine, setMine] = useState<Mine | null>(null);
  const mineRef = useRef<Mine | null>(null);
  const joined = useRef(false);
  const justPosted = useRef<{ item: FeedItem; at: number }[]>([]); // the feed is CDN-cached: keep our own posts on top until the feed lists them

  const loadFeed = useCallback(async () => {
    try {
      const f = await getJson<{ mode: Mode; requests: FeedItem[] }>("/api/requests/feed");
      const listed = new Set(f.requests.map((r) => r.id));
      justPosted.current = justPosted.current.filter((r) => !listed.has(r.item.id) && Date.now() - r.at < POSTED_TTL_MS);
      setFeed({ status: "ready", mode: f.mode, requests: [...justPosted.current.map((r) => r.item), ...f.requests] });
    } catch {
      setFeed((prev) => (prev.status === "ready" ? prev : { status: "error" }));
    }
  }, []);

  /** Our optimistic rows are only real while `mine` says so: a denied request is hidden from the feed and would stay forever. */
  const dropStalePosts = useCallback((mineId: number | undefined) => {
    const gone = justPosted.current.filter((r) => r.item.id !== mineId || Date.now() - r.at >= POSTED_TTL_MS).map((r) => r.item.id);
    if (gone.length === 0) return;
    justPosted.current = justPosted.current.filter((r) => !gone.includes(r.item.id));
    setFeed((prev) => (prev.status === "ready" ? { ...prev, requests: prev.requests.filter((r) => !gone.includes(r.id)) } : prev));
  }, []);

  const loadMine = useCallback(async () => {
    try {
      const m = await getJson<{ request: Mine | null }>("/api/requests/mine", { cache: "no-store" });
      mineRef.current = m.request;
      setMine(m.request);
      dropStalePosts(m.request?.id);
    } catch {
      /* keep what we had */
    }
  }, [dropStalePosts]);

  /** After a post (201 passes its `request`; a refusal passes nothing): show it at once, then re-read feed and `mine`. */
  const afterPost = useCallback(
    async (posted?: PostedRequest) => {
      if (posted) {
        const item: FeedItem = { ...posted, createdAt: new Date().toISOString() };
        justPosted.current = [{ item, at: Date.now() }, ...justPosted.current];
        setFeed((prev) => (prev.status === "ready" ? { ...prev, requests: [item, ...prev.requests.filter((r) => r.id !== item.id)] } : prev));
      }
      await Promise.all([loadFeed(), loadMine()]);
    },
    [loadFeed, loadMine],
  );

  useEffect(() => {
    void loadFeed();
    const first = !joined.current;
    joined.current = true;
    if (first || (mineRef.current && ACTIVE.has(mineRef.current.status))) void loadMine();
  }, [loadFeed, loadMine, playing]);

  return { feed, mine, afterPost, reloadFeed: loadFeed };
}

const KEY = "ttunes_listener_name";
export const savedName = (): string => {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};
export const saveName = (name: string): void => {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    /* private mode: just don't remember */
  }
};
