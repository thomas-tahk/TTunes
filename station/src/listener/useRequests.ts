import { useCallback, useEffect, useState } from "react";
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

/**
 * Feed + the listener's own request. Reloads whenever `playing` changes identity: that is on join, on song change
 * and on the 30s re-check (useStation sets a new object each time), plus `reload()` right after a post. No timers here.
 */
export function useRequests(playing: NowPlaying | null) {
  const [feed, setFeed] = useState<FeedState>({ status: "loading" });
  const [mine, setMine] = useState<Mine | null>(null);

  const reload = useCallback(async () => {
    const [f, m] = await Promise.allSettled([
      getJson<{ mode: Mode; requests: FeedItem[] }>("/api/requests/feed"),
      getJson<{ request: Mine | null }>("/api/requests/mine", { cache: "no-store" }),
    ]);
    if (f.status === "fulfilled") setFeed({ status: "ready", mode: f.value.mode, requests: f.value.requests });
    else setFeed((prev) => (prev.status === "ready" ? prev : { status: "error" }));
    if (m.status === "fulfilled") setMine(m.value.request);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, playing]);

  return { feed, mine, reload };
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
