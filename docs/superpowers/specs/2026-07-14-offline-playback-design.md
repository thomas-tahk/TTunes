# TTunes — Offline Playback (PWA)

Make TTunes a cloud-hosted app that still plays your library with **no network**.
Personal, single-user. You can't *add* to the library offline — but browsing,
shuffle, queue, and playback all work.

## Goal & model

**Whole library, mirrored to the device automatically, bounded by a storage
budget.** No per-track download decisions. When the library fits under the
budget, everything is available offline; when it exceeds the budget, the app
keeps as much as fits (newest-first priority) and evicts the rest. New additions
download automatically next time you're online with room to spare.

This layer rides on the existing API contract (`/api/tracks`, `/audio/:id`), so
it behaves identically against today's local server and tomorrow's cloud
container — building it now is forward-compatible with the R2/Postgres deploy.

## Architecture

Two cooperating pieces, cleanly split:

- **The page (download manager)** *writes* audio into the Cache Storage. It lists
  tracks, computes a sync plan against a budget, fetches missing audio, and
  evicts what no longer fits. It owns all the bespoke logic.
- **The service worker** *reads* — it serves the app shell and cached audio when
  the network is unavailable, including **HTTP Range** responses sliced from the
  cached file so instant-seek playback still works offline.

Hand-rolled service worker (no `vite-plugin-pwa`) — zero dependency, Vite-8-safe,
and full control over range handling. Files live in `public/` and ship as-is.

```
Page (React)                          Service Worker (public/sw.js)
────────────                          ─────────────────────────────
useOfflineLibrary                     fetch handler:
  • plan sync (pure)                    • navigation  -> network-first, fallback index.html
  • fetch /audio/:id (full 200)         • /assets/*   -> cache-first (hashed, immutable)
  • caches.put(AUDIO_CACHE)             • /api/tracks -> network-first, fallback cache
  • caches.delete (evict)               • /audio/:id  -> cache-first + Range slicing (206)
  • navigator.storage.persist()
  • online/offline status
```

## Components

- **`src/offline/plan.ts`** — `planOfflineSync(tracks, cachedIds, budgetBytes)`
  → `{ keep, toDownload, toEvict }`. Pure, unit-tested. Greedy newest-first fill
  under budget; already-cached tracks in the keep-set aren't re-downloaded.
  `Number.POSITIVE_INFINITY` budget = "unlimited" (mirror everything).
- **`public/sw.js`** — install (skipWaiting) / activate (clients.claim + purge old
  cache versions) / fetch routing above. Range slicing reads the cached full
  response's `ArrayBuffer` and returns a 206 with `Content-Range`.
- **`src/offline/useOfflineLibrary.ts`** — hook exposing `{ isOffline,
  availableIds, status, usage, budgetBytes, setBudget }`. Auto-syncs when online
  and the track list changes; reads existing cached ids on mount; requests
  persistent storage once.
- **`src/components/OfflinePanel.tsx`** — compact status: online/offline pill,
  "X/Y tracks • used / budget", a progress bar while syncing, and a budget
  selector (1 / 2 / 5 GB / Unlimited).
- **`src/usePlayer.ts`** — the shuffle order is filtered to `availableIds` when
  offline, so the station only draws tracks actually on the device and never
  stalls on a missing file. Online, the pool is the whole library (unchanged).
- **`src/main.tsx`** — registers `/sw.js`.
- **`public/manifest.webmanifest` + icons** — installable PWA (standalone,
  charcoal/amber theme). **`index.html`** — manifest link + theme-color.

## Data flow

1. **Online load:** SW caches app shell + `/api/tracks`. `useOfflineLibrary`
   plans a sync and downloads missing audio into `AUDIO_CACHE` (up to budget),
   evicting anything no longer in the keep-set. Progress shown in the panel.
2. **Go offline:** navigation serves cached `index.html`; assets + `/api/tracks`
   come from cache so the library renders. Player restricts shuffle/queue to
   `availableIds`; `<audio>` requests hit the SW, which serves cached audio and
   slices Range responses for seeking.
3. **Back online:** new additions download automatically; a smaller budget evicts
   the overflow.

## Budget & eviction

Budget persisted in `localStorage` (default **2 GB**; "Unlimited" for desktop).
Priority is **newest-first** (`createdAt` desc) — simple and predictable; keeps
what you most recently added. No play-history tracking in this cut.

## Testing

- **Unit (Node):** `plan.ts` — fits-under-budget mirrors all; over-budget keeps
  newest set and marks the rest to evict; already-cached aren't re-downloaded;
  unlimited keeps everything; range-slice math (`sliceRange`) for the SW.
- **Build:** `tsc --noEmit` + `vite build` clean.
- **Browser (user-verified, with exact steps):** install prompt appears; after
  first online load DevTools → Application shows the SW active and `AUDIO_CACHE`
  populated; toggle DevTools "Offline" → reload → library renders and a track
  plays *and seeks*; new upload downloads on reconnect.

## Deliberately deferred

Play-history-weighted eviction, background periodic sync, per-track offline
indicators/controls, partial-file (streaming) caching, offline queue persistence
across reloads, and offline *editing* (adds are online-only by design).
