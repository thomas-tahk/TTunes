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

3. **AI = librarian, not smuggler (type B).** The AI finds *what exists*
   (e.g. "is there a jazzy cover of Creep, and who did it?"), identifies it, and
   files/tags it correctly. You supply the actual audio. The AI does **not**
   autonomously fetch arbitrary audio bytes, and TTunes does **not** pull live
   from YouTube/web.

4. **No recommendation engine.** AI is reactive — it answers your requests. It
   does not push proactive suggestions.

5. **Versions/covers are first-class.** Distinguishing the studio cut vs. live
   vs. cover is a core requirement, served by your own control over tagging.

6. **Playback model — "build for one, designed for a few":**
   - **Phase 1:** a *personal continuous player*. Nothing plays while you're
     away, but opening TTunes instantly starts playback (resume or fresh
     shuffle), so it *feels* always-on.
   - **Design constraint locked now:** model "what's playing" as **server-side
     station state** (a queue + a position/timeline), not ad-hoc client-side
     playback. Solo, you're the only reader and have full control
     (pause/skip/request/rewind).
   - **Later (broadcast-for-friends):** let a few friends/family tune in as
     **read-only** listeners who sync to your station timeline. Achieved with a
     synced-timeline trick (server publishes "what's playing + offset" as JSON;
     each browser streams the file directly from cloud storage and seeks to the
     offset) — **not** Icecast-style audio-streaming infrastructure.
   - Legal note: streaming your owned files to others is redistribution/public
     performance, legally distinct from personal listening. Low practical risk
     at family scale; flip-on decision deferred.

7. **Out of scope (confirmed):** music videos, psychedelic/audio
   visualizations.

8. **Nice-to-have, not mandatory:** album art / artist images.

## Open questions (not yet decided)

- **Sub-playlists** — user is unsure if needed. (TBD)
- **AI request flow** — exact UX of "find me X" → identify → file. (TBD)
- **Acquisition/upload flow** — how owned audio gets into cloud storage. (TBD)
- **Cloud storage provider** — R2 vs S3 vs Supabase Storage, etc. (TBD)
- **Tech stack** — frontend, backend, DB for catalog/metadata + station state. (TBD)
- **Metadata model** — how tracks, versions/covers, and tags are structured. (TBD)

## Next step

Resolve open questions (likely starting with the metadata/catalog model and the
upload flow), then produce a formal design doc and implementation plan.
