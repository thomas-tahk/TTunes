# TTunes — Design Spec

_Date: 2026-06-30 · Status: design, pending user review_

> Source of decisions: `docs/brainstorm/2026-06-24-ttunes-decisions.md`. This spec
> consolidates those decisions into an implementation-ready design.

## 1. Overview

TTunes is a **personal, always-on music station** — a "personal radio channel"
for a single listener. The user owns and curates a music library hosted in cloud
storage; TTunes shuffles it 24/7-feeling, plays specific tracks on request, and
uses an AI **librarian** to help find, tag, and file music. It is explicitly
**not** a recommendation engine and **not** a content-subscription service — the
user owns the files and the app.

## 2. Goals

- Open TTunes on any device → music is *instantly* playing (resume or fresh
  shuffle). Feels always-on without a broadcast server.
- Own a growing personal catalog in cloud storage; no dependence on a streaming
  platform's catalog, rules, or subscription.
- AI helps **find, identify, tag, and file** tracks reactively (on request) —
  never pushes suggestions.
- Distinguish versions/covers of the same song, with the user always in control.
- Instant playback, no buffering. Snappy UI.
- Cheap now (~free early), and **portable** — designed to lift-and-shift to
  self-hosting later with no rewrite.

## 3. Non-Goals (out of scope)

- Recommendation engine / proactive suggestions.
- Music videos; psychedelic/audio visualizations.
- Audio engineering: EQ, DSP, sound-adjustment, mastering.
- Broadcast / multi-listener sync (deferred; state model kept compatible).
- Trash/recycle-bin or "soft ban" features.

## 4. Core Domain Model

**Track (recording)** — the atomic, playable unit. Artist is first-class.
- Fields: `title`, `artist(s)`, `version_type` (`studio` | `live` | `remaster`
  | `acoustic` | `cover` | …), `album?`, `year?`, `art?`, audio pointer
  (R2 object key), `bitrate`/`format` (for the quality badge), timestamps.

**Version group** — an *optional, user-confirmed* cluster of tracks that are "the
same song," with exactly one **primary**.
- No abstract "composition/Work" entity. Grouping is a relationship, never an
  automatic merge. Membership requires the user's yes.
- A transformative cover simply stays ungrouped (its own artist distinguishes it).

**Pool** — what the station shuffles. One of:
- Whole library (default).
- **Smart/filtered channel** — a saved or ad-hoc tag filter (e.g. `genre=jazz`,
  `version_type=live`, `decade=90s`). Zero maintenance; rides on tags.
- **Curated playlist** — a hand-built ordered/named list.

**Station state** (server-side) — `active_pool`, `manual_queue` (≤ ~6 tracks),
`now_playing` (track + start timestamp/offset). This is the spine of the
"instant resume / 24/7 feel" and is intentionally shaped so a future broadcast
mode could publish it to read-only listeners.

**Editability invariant:** every AI-produced value (tags, `version_type`,
grouping, primary, metadata) is user-editable at any time.

## 5. Playback & Shuffle

- **Shuffle rule:** draw **one entry per version-group (its primary) + every
  ungrouped track** from the active pool. No version spam; standalone covers
  appear in their own right.
- **Manual queue** sits on top of the shuffle: plays before shuffle resumes;
  empties → fall back to shuffling the active pool (never silent).
- **Requests:**
  - *Play now* — interrupt, play immediately.
  - *Play next / add to queue* — append to manual queue (cap ~6, tunable).
  - Larger batches → switch the active pool to a playlist, not queue-spam.
- **Performance (hard requirement):** playback starts instantly; the **next
  track is prefetched before the current ends** (no inter-track buffer). UI never
  blocks. Storage must be CDN-backed with fast range requests.

## 6. Library: Add / Acquire / Remove

**Add paths** (all land audio in R2 + a Track row in Postgres):
1. **Drag-drop** a file you already have.
2. **Bulk dump** — a folder of hundreds at once (first-class; dominant early).
   Batch-tagged; only pauses to ask on *strong* grouping matches.
3. **AI buy-link pointer** — AI confirms a track exists, points to a legit source
   (Bandcamp/iTunes/…); user acquires, then it files instantly.
4. **YouTube/web extraction** (personal use only) — AI extracts audio **once**
   into R2; playback always from storage, never live-pulled.

**AI filing:** on add, AI identifies the track (embedded tags → fingerprint via
AcoustID/MusicBrainz → filename), applies tags, and — only on a **strong match**
(near-exact title + corroboration) — offers "group under X, or stand alone?".
Weak/far-fetched matches file as standalone **silently**. Can't identify → files
with best guess, all editable.

**Remove vs. Delete (distinct):**
- **Remove** — take a track out of a playlist/pool; keep it in the library.
- **Delete** — purge from the entire library **and** R2 (stop paying). One confirm
  dialog. No trash, no recovery.

**Audio quality:** played faithfully, no enhancement (quality is sourcing-bound).
Passive **quality badge** (bitrate/format) + quiet marker on low-bitrate files.
No adjustment, no nagging.

## 7. Architecture

Single **portable TypeScript container** (React front-end + Node back-end),
plus managed data services. The container serves the UI, signs storage URLs,
owns station-state, calls AI + music APIs, and runs background jobs in-process.

```
┌─────────────────────────────────────────────┐
│  TTunes container (React + Node, TypeScript)  │
│  • UI (player, library, add, edit)            │
│  • API (station-state, catalog CRUD, add flow)│
│  • Background jobs: extraction, batch-tagging  │
└───────┬───────────────┬───────────────┬───────┘
        │ S3 API         │ SQL           │ HTTPS
   ┌────▼─────┐    ┌─────▼──────┐   ┌────▼──────────────────┐
   │Cloudflare│    │  Postgres  │   │ Claude · MusicBrainz/  │
   │   R2     │    │ (managed)  │   │ AcoustID · yt-dlp      │
   │ (audio)  │    │ (metadata) │   │ (librarian/acquire)    │
   └──────────┘    └────────────┘   └───────────────────────┘
```

**Components:**
- **Web UI (React):** player + prefetch, library (artist-first browse), pools/
  playlists, add/upload, metadata editor, quality badges.
- **API layer (Node):** station-state machine, catalog CRUD, pool/queue logic,
  signed-URL issuance for R2 playback, add-flow orchestration.
- **Background jobs (in-process):** YouTube/web extraction (yt-dlp), bulk
  fingerprint + tag, art fetch. Long-running work that doesn't fit serverless —
  motivates the single always-on container over serverless.
- **Storage abstraction:** all audio I/O behind a thin **S3-compatible**
  interface, so R2 → self-hosted MinIO/local disk is a config swap.
- **AI librarian:** Claude for reasoning (identify/tag/group), AcoustID +
  MusicBrainz for fingerprinting/metadata, yt-dlp for extraction.

## 8. Key Data Flows

**Play (cold open):** UI asks API for station-state → gets `now_playing` (or
starts a fresh shuffle of the active pool) → requests a signed R2 URL → streams +
seeks → prefetches the next track's URL before the current ends.

**Add (single):** file/URL → API → (extract if URL) → store in R2 → fingerprint
+ tag via AI/MusicBrainz → strong-match? prompt group/standalone : file silently
→ Track row written → appears in library.

**Add (bulk):** folder → queued batch job → per-file store+identify+tag → collect
strong-match prompts for the user to resolve in one pass → rows written.

**Request:** user asks for track/version → resolve to a Track → *play now*
(swap `now_playing`) or *queue* (append to `manual_queue`, cap enforced).

## 9. Cost & Portability

- **Own everything.** Not a content subscription; stop paying a host and the
  library is still yours (exportable from R2).
- **~Free early:** R2 10GB free, DB free tier; only the always-on host is ~$0–5/mo.
  Scales gently (~1k songs ≈ 10GB; ~100k ≈ 1TB). R2 zero-egress keeps streaming
  cost near-flat.
- **Portability-first:** S3-compatible storage behind an abstraction, plain
  Postgres (no proprietary features), portable container. Cloud is a *temporary*
  host; the same artifact runs on a home server/Pi/NAS later.

## 10. Open Questions (for planning / implementation)

- Exact table shapes (tracks, artists, groups, playlists, tags) + station-state
  representation.
- AI request UX surface (command box vs. inline).
- Concrete host choice (Railway vs. Fly vs. Render) + CI.
- Manual-queue cap final value (~6).

## 11. Legal Note

YouTube/web extraction of commercial copyrighted music is infringement / ToS
violation. Acceptable-risk profile assumes **private, single-listener, no
redistribution**; best kept to free/CC/public-domain/self-owned content. Risk
compounds if broadcast is ever enabled — hence broadcast stays out of scope.
