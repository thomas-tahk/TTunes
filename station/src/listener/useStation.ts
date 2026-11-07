import { useCallback, useEffect, useRef, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";
import { clockOffset, planNextFetch, RECHECK_MS } from "./timing.ts";

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
  const staleRetries = useRef(0);
  const serverTime = useCallback(() => Date.now() + offset.current, []);

  const remeasure = useCallback(async () => {
    offset.current = await fetchOffset().catch(() => offset.current);
  }, []);

  const refresh = useCallback(async (known?: NowPlaying): Promise<void> => {
    window.clearTimeout(timer.current);
    try {
      const playing = known ?? (await fetchNow()); // `known`: a response the page already holds (owner add), skipping the CDN-cached /api/now
      // Re-measures the clock first if the response looks ended, so the page never starts a song at its end.
      const plan = await planNextFetch(playing, { serverTime, remeasure }, staleRetries.current);
      staleRetries.current = plan.staleRetries;
      setView({ status: "ready", playing });
      timer.current = window.setTimeout(() => void refresh(), plan.delayMs);
    } catch {
      setView((prev) => (prev.status === "ready" ? prev : { status: "error" }));
      timer.current = window.setTimeout(() => void refresh(), RECHECK_MS);
    }
  }, [serverTime, remeasure]);

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

  return { view, serverTime, retry: refresh, show: (playing: NowPlaying) => refresh(playing) };
}
