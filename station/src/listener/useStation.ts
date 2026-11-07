import { useCallback, useEffect, useRef, useState } from "react";
import type { NowPlaying } from "../../lib/schedule.ts";
import { clockOffset, planNextFetch, RECHECK_MS, refetchOnResume } from "./timing.ts";

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

/** Follows the station: clock sync + one /api/now on join. While `listening` (playing, not paused) also at song end and 30s after the last fetch; pressing Play or unpausing refetches first. */
export function useStation(listening: boolean) {
  const [view, setView] = useState<StationView>({ status: "loading" });
  const offset = useRef(0);
  const timer = useRef<number>(undefined);
  const staleRetries = useRef(0);
  const fetched = useRef({ at: 0, dueAt: 0 }); // last response, and when its plan wants the next one
  const listeningRef = useRef(listening);
  listeningRef.current = listening;
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
      fetched.current = { at: Date.now(), dueAt: Date.now() + plan.delayMs };
      setView({ status: "ready", playing });
      if (listeningRef.current) timer.current = window.setTimeout(() => void refresh(), plan.delayMs);
    } catch {
      setView((prev) => (prev.status === "ready" ? prev : { status: "error" }));
      if (listeningRef.current) timer.current = window.setTimeout(() => void refresh(), RECHECK_MS);
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

  useEffect(() => {
    if (!listening) return window.clearTimeout(timer.current);
    // Play or unpause: rejoin live, then the timer resumes
    if (refetchOnResume(Date.now() - fetched.current.at)) void refresh();
    else timer.current = window.setTimeout(() => void refresh(), Math.max(0, fetched.current.dueAt - Date.now()));
  }, [listening, refresh]);

  return { view, serverTime, retry: refresh, show: (playing: NowPlaying) => refresh(playing) };
}
