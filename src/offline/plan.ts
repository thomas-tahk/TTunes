import type { Track } from "../types.ts";

export interface SyncPlan {
  keep: string[]; // track ids that should live on the device
  toDownload: string[]; // in keep but not yet cached — fetch these
  toEvict: string[]; // cached but no longer kept (over budget or deleted) — remove these
}

// Decide which of the library's tracks are mirrored to the device. Newest-first
// greedy fill under the byte budget (design spec: predictable, keeps recent adds).
// Already-cached tracks that stay in the keep-set are left in place, not re-fetched.
export function planOfflineSync(tracks: Track[], cachedIds: Iterable<string>, budgetBytes: number): SyncPlan {
  const cached = new Set(cachedIds);
  const byNewest = [...tracks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const keep: string[] = [];
  let used = 0;
  for (const track of byNewest) {
    const size = track.sizeBytes || 0;
    if (used + size <= budgetBytes) {
      keep.push(track.id);
      used += size;
    }
  }

  const keepSet = new Set(keep);
  return {
    keep,
    toDownload: keep.filter((id) => !cached.has(id)),
    toEvict: [...cached].filter((id) => !keepSet.has(id)),
  };
}
