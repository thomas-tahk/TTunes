# TTunes — Decisions Log (WIP)

> **Status:** Brainstorming in progress. This is a running log of decisions made
> so far, not a final design spec. A formal design doc + implementation plan come
> once the open questions below are resolved.

_Last updated: 2026-06-24_

## What TTunes is

A personal, always-on music station — a "personal radio channel." You curate
your own catalog, it shuffles and plays 24/7-feeling, and an AI helps you find
and file specific tracks on request. Reactive, not a recommendation engine.

## Decisions made

1. **Separate project.** TTunes is its own repo (`~/Projects/TTunes`), unrelated
   to knowflow.

2. **Music source = own cloud library (Path A).** Audio lives in cloud object
   storage that you own/control — not on a local machine, and not dependent on
   anyone else's platform, catalog, or subscription.
   - Tradeoff accepted: you acquire tracks over time and pay to host them
     (~$15–25 / TB / month at scale).

3. **AI = librarian + acquisition helper (personal use).** The AI finds *what
   exists*, identifies it, and files/tags it correctly. Multiple ways music gets
   in:
   - **Drag-drop** files you already have.
   - **Bulk dumps** — a folder of hundreds at once (first-class path; expected to
     dominate early seeding). AI batch-tags; only stops to ask on strong grouping
     matches.
   - **AI buy-link pointers** — AI confirms a track exists and points you to a
     legit source (Bandcamp/iTunes/etc.) to acquire it.
   - **YouTube/web extraction (acquisition source, personal use only).** AI
     extracts the audio **once**, stores it in *your* cloud library; playback is
     always from your storage, never live-pulled. NOT for redistribution.
   - If the AI **can't find** something: say so, offer a best-guess next step,
     don't overthink it.
   - **Ruled out:** live-pull/streaming from YouTube at playback time (fragile,
     link-rot, platform dependency).
   - Legal note: YouTube extraction of commercial copyrighted music is
     infringement/ToS violation; acceptable risk profile assumes **private,
     single-listener, no redistribution**. Best kept to free/CC/public-domain/
     self-owned content. Risk compounds if broadcast is ever enabled.

4. **No recommendation engine.** AI is reactive — it answers your requests. It
   does not push proactive suggestions.

5. **Catalog model — track-centric with user-confirmed grouping.**
   - The atomic unit is a **Track (recording)**; **artist is first-class** on it,
     not a sub-detail of an abstract composition. A track has: title, artist(s),
     a **version-type** (`studio` / `live` / `remaster` / `acoustic` / `cover` …),
     plus audio + art.
   - **No abstract "composition/Work" entity.** Grouping is an optional,
     **user-confirmed relationship**: tracks can cluster into a "versions" group
     with one marked **primary**. Nothing auto-merges by title or composition.
   - **AI suggests, user decides.** On add, if a track is a *strong* match for an
     existing one, the AI offers a yes/no "group under X, or stand alone?".
     - Prompt fires **only on a strong match** (near-exact title + corroboration:
       same artist, or AI-verified same composition). Far-fetched/loose matches
       **file as standalone silently** — no prompt. Default when unsure = stand
       alone. Never interrupt on a hunch.
   - **Transformative covers stand alone** by design — their own artist makes them
     distinct; they're their own entry, not folded under the original.
   - **Same-title-unrelated songs never collide** — grouping requires the user's
     yes, and artist disambiguates.
   - **Shuffle draws one entry per group (the primary) + every ungrouped track.**
     So studio+live of the same song collapse to one slot (no version spam), while
     a standalone cover appears in its own right.
   - Browsing is **artist-first**; "show other versions of this" is a secondary
     peek into a group.
   - Common case (only one version owned): grouping machinery is invisible.

6. **Playback model — "build for one, designed for a few":**
   - **Phase 1:** a *personal continuous player*. Nothing plays while you're
     away, but opening TTunes instantly starts playback (resume or fresh
     shuffle), so it *feels* always-on.
   - **Design constraint locked now:** model "what's playing" as **server-side
     station state** (a queue + a position/timeline), not ad-hoc client-side
     playback. Solo, you're the only reader and have full control
     (pause/skip/request/rewind).
   - **Broadcast-for-friends = deferred / out of scope.** TTunes is a pure
     personal, single-listener player for now. The server-side station-state is
     kept *only* because it cleanly powers the personal "instant resume / 24/7
     feel" — not to serve other listeners. (If broadcast is ever revived, the
     state model is already shaped for a synced-timeline approach rather than
     Icecast-style streaming.)

7. **Everything the AI does is editable — the user is always the editor.**
   Every auto-tag, version-type, grouping, primary pick, and metadata field is
   correctable any time (not just at add-time): re-tag, split/merge groups,
   promote a different primary, fix a bad fingerprint guess. AI proposes; user
   overrides.

8. **Out of scope (confirmed):** music videos, psychedelic/audio
   visualizations; broadcast/multi-listener (deferred, see #6).

9. **Nice-to-have, not mandatory:** album art / artist images.

10. **Performance is a hard requirement.** Instant playback, no buffer spinners
    between tracks (prefetch the next track before the current ends), UI never
    blocks. This constrains storage (must be CDN-backed, fast range requests) and
    the player (prefetch-ahead). "Wait around to load/buffer" = failure.

11. **Audio quality — "good enough, consistent"; zero audio-engineering.** No EQ,
    DSP, sound-adjustment knobs, or mastering — all out of scope.
    - Honest bound: quality is *sourcing-limited* (garbage in, garbage out). The
      app plays files faithfully and does NOT enhance; a low-bitrate rip stays
      low-bitrate. Consistency is a sourcing discipline, not an app feature.
    - The app *does* provide **passive quality visibility**: a small bitrate/
      format badge + quiet marker on noticeably-low files, so the user can choose
      to re-acquire. Ignorable, no nagging.

12. **Sub-playlists — unified "current shuffle pool" model.** The station always
    plays *a pool*; the user can point it at any of:
    - **Whole library** (default).
    - **Smart/filtered channel** — narrow by tags on the fly or save the filter
      (e.g. "jazz", "all live", "90s"). Zero maintenance; rides on AI tagging.
    - **Curated playlist** — hand-built named list. Manual upkeep.
    Any pool shuffles via the same primary-per-group + standalones rule. No new
    machinery — just swap which pool is active.

## Open questions (not yet decided)

- **Cloud storage provider** — R2 vs S3 vs Supabase Storage, etc. (NEXT — technical)
- **Tech stack** — frontend, backend, DB for catalog + station state. (NEXT — technical)
- **AI request UX** — surface/affordance for "find me X" (mostly settled in #3). (minor)

## Next step

Resolve open questions (likely starting with the metadata/catalog model and the
upload flow), then produce a formal design doc and implementation plan.
