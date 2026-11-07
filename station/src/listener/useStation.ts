import { useCallback, useEffect, useRef, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";
import { clockOffset, hasEnded, nextFetchDelayMs, RECHECK_MS, STALE_RETRY_MS } from "./timing.ts";

export type StationView = { status: "loading" } | { status: "error" } | { status: "ready"; playing: NowPlaying };

async function fetchOffset(): Promise<number> {
  const sentAt = Date.now();
  const res = await fetch("/api/time", { cache: "no-store" });
  const receivedAt = Date.now();
  if (!res.ok) throw new Error(`time ${res.status}`);
  const { serverNow } = (await res.json()) as { serverNow: number };
  return clockOffset({ serverNow, sentAt, receivedAt });
}

async function fetchNow(): Promise<NowPlaying> {
  const res = await fetch("/api/now");
  if (!res.ok) throw new Error(`now ${res.status}`);
  return (await res.json()) as NowPlaying;
}

/** Follows the station: one clock sync on join, /api/now on join, at song end, and 30s after the last fetch. */
export function useStation() {
  const [view, setView] = useState<StationView>({ status: "loading" });
  const offset = useRef(0);
  const timer = useRef<number>(undefined);
  const serverTime = useCallback(() => Date.now() + offset.current, []);

  const refresh = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current);
    try {
      const playing = await fetchNow();
      setView({ status: "ready", playing });
      // A cached response can describe a song that already ended: ask again shortly.
      const stale = playing.current !== null && hasEnded(playing, serverTime());
      timer.current = window.setTimeout(refresh, stale ? STALE_RETRY_MS : nextFetchDelayMs(playing, serverTime()));
    } catch {
      setView((prev) => (prev.status === "ready" ? prev : { status: "error" }));
      timer.current = window.setTimeout(refresh, RECHECK_MS);
    }
  }, [serverTime]);

  useEffect(() => {
    let live = true;
    fetchOffset()
      .catch(() => 0) // no clock sync: fall back to the local clock rather than refuse to play
      .then((value) => {
        if (!live) return;
        offset.current = value;
        void refresh();
      });
    return () => {
      live = false;
      window.clearTimeout(timer.current);
    };
  }, [refresh]);

  return { view, serverTime, retry: refresh };
}
