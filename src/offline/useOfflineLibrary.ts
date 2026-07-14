import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "../types.ts";
import { audioUrl } from "../api.ts";
import { planOfflineSync } from "./plan.ts";

const AUDIO_CACHE = "ttunes-audio-v1"; // MUST match public/sw.js
const BUDGET_KEY = "ttunes.offline.budgetBytes";
const GB = 1024 ** 3;
export const DEFAULT_BUDGET_BYTES = 2 * GB;
export const UNLIMITED = Number.POSITIVE_INFINITY;

export type SyncStatus = "idle" | "syncing";

export interface OfflineLibrary {
  isOffline: boolean;
  availableIds: Set<string>;
  status: SyncStatus;
  progress: { done: number; total: number };
  usedBytes: number | null;
  budgetBytes: number;
  persisted: boolean;
  setBudget: (bytes: number) => void;
}

const hasCaches = typeof caches !== "undefined";

function loadBudget(): number {
  const raw = localStorage.getItem(BUDGET_KEY);
  if (raw === "Infinity") return UNLIMITED;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_BYTES;
}

async function cachedAudioIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!hasCaches) return ids;
  const cache = await caches.open(AUDIO_CACHE);
  for (const req of await cache.keys()) {
    const match = /\/audio\/([^/?]+)/.exec(new URL(req.url).pathname);
    if (match) ids.add(match[1]);
  }
  return ids;
}

// Mirrors the library onto the device (design spec: whole library, budget-bounded).
// The page writes audio into the cache; the service worker serves it back offline.
export function useOfflineLibrary(tracks: Track[]): OfflineLibrary {
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [availableIds, setAvailableIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [usedBytes, setUsedBytes] = useState<number | null>(null);
  const [budgetBytes, setBudgetBytes] = useState<number>(() => loadBudget());
  const [persisted, setPersisted] = useState(false);
  const syncingRef = useRef(false);

  const refreshUsage = useCallback(async () => {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      setUsedBytes(est.usage ?? 0);
    }
  }, []);

  useEffect(() => {
    const goOnline = () => setIsOffline(false);
    const goOffline = () => setIsOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // One-time: request persistent storage, load what's already cached.
  useEffect(() => {
    void (async () => {
      let ok = false;
      if (navigator.storage?.persisted) ok = await navigator.storage.persisted();
      if (!ok && navigator.storage?.persist) ok = await navigator.storage.persist();
      setPersisted(ok);
      setAvailableIds(await cachedAudioIds());
      await refreshUsage();
    })();
  }, [refreshUsage]);

  const sync = useCallback(async () => {
    if (syncingRef.current || !navigator.onLine || !hasCaches || !tracks.length) return;
    syncingRef.current = true;
    setStatus("syncing");
    try {
      const cache = await caches.open(AUDIO_CACHE);
      const cached = await cachedAudioIds();
      const plan = planOfflineSync(tracks, cached, budgetBytes);

      for (const id of plan.toEvict) {
        await cache.delete(audioUrl(id));
        cached.delete(id);
      }
      setProgress({ done: 0, total: plan.toDownload.length });
      let done = 0;
      for (const id of plan.toDownload) {
        try {
          const res = await fetch(audioUrl(id));
          if (res.ok) {
            await cache.put(audioUrl(id), res);
            cached.add(id);
          }
        } catch {
          // leave uncached; a later sync retries
        }
        setProgress({ done: ++done, total: plan.toDownload.length });
      }
      setAvailableIds(new Set(cached));
      await refreshUsage();
    } finally {
      setStatus("idle");
      syncingRef.current = false;
    }
  }, [tracks, budgetBytes, refreshUsage]);

  // Auto-mirror whenever online and the library or budget changes.
  useEffect(() => {
    void sync();
  }, [sync]);

  const setBudget = useCallback((bytes: number) => {
    localStorage.setItem(BUDGET_KEY, bytes === UNLIMITED ? "Infinity" : String(bytes));
    setBudgetBytes(bytes);
  }, []);

  return { isOffline, availableIds, status, progress, usedBytes, budgetBytes, persisted, setBudget };
}
