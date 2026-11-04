# TTunes — YouTube Ingest (MVP)

Paste a YouTube link for a song → pull the audio → confirm it's actually the
song → file it into the library. Personal use only (see design spec §11).
Extends the north-star spec §6 ("YouTube/web extraction") with a concrete,
lean first cut.

## Goal

Get a real track into the library from a URL, fast, with enough of a check that
you don't accidentally file a 10-hour loop, a reaction video, or the wrong
version — **without** heavy fingerprinting infrastructure.

## Verification stance (the "match actual song material" ask)

Two cheap signals plus your own ears — no AcoustID/fingerprint in the MVP:

1. **Automatic warnings** (soft, never blocking):
   - Duration **> 12 min** → likely a loop / full album / compilation.
   - Title/uploader contains version/oddity words (`live`, `cover`, `remix`,
     `acoustic`, `sped up`, `nightcore`, `reaction`, `1 hour`, `full album`).
     Surfaced as "heads up, looks like a live version" — versions are a feature,
     so this warns, it doesn't wall.
2. **Preview-before-commit** — the confirm card plays the *actual extracted
   audio*. Three seconds with your ears is the real guarantee it's the song.

Nothing lands in the library until you hit **Add**.

## Flow

1. UI: paste URL into "Add from YouTube", hit Fetch.
2. `POST /api/ingest/youtube {url}` → server runs `yt-dlp -x --audio-format mp3`
   into a **staging** dir (not the library), reads the extracted file's real
   duration/bitrate/format via `music-metadata`, derives identity + warnings
   from yt-dlp's JSON. Returns a staged summary (incl. a `stagingId`).
3. Confirm card: editable **title/artist/album** (pre-filled), uploader +
   duration, any ⚠ warnings, a ▶ **Preview** button, and **Add** / **Discard**.
4. **Add** → `POST /api/ingest/youtube/:id/commit {title,artist,album}` → moves
   the staged file into storage + writes a Track (same landing as an upload).
   **Discard** → `DELETE /api/ingest/youtube/:id` → deletes the staged file.

## Identity parsing (from yt-dlp JSON)

Priority: (1) music fields `track`+`artist` if present → (2) `"<Artist> - Topic"`
auto-channel → uploader is the artist → (3) `"Artist - Song"` title split →
(4) fallback: whole title, uploader as artist. Titles are cleaned of
`(Official Video)`, `(Audio)`, `[Lyrics]`, etc. All fields are editable, so
parsing only needs to be a good default.

## Components

- **`server/metadata.ts`** — `readAudioMeta(path)` extracted from `index.ts` so
  upload and ingest share one audio-metadata reader (duration/bitrate/format).
- **`server/ingest.ts`** — `YouTubeIngest`: `stage(url)`, `get`, `stream`
  (preview), `discard`, `take` (commit hand-off). Owns the staging dir + an
  in-memory staged map. `yt-dlp` runs via `spawn` with a hard timeout and
  `--max-filesize`; only youtube.com / youtu.be / music.youtube.com URLs accepted.
- **`server/index.ts`** — three ingest routes + a staged-audio preview route;
  `PORT` becomes env-overridable (needed to run a second instance for testing).
- **`src/components/YouTubeAdd.tsx`** — URL input + confirm card. Preview uses a
  plain `<audio>` against the staged-audio route.
- **`src/api.ts`** — `ingestYouTube`, `commitIngest`, `discardIngest`,
  `stagedAudioUrl`.

## Deliberately deferred

AcoustID fingerprinting, batch/multi-link, a background job queue, album-art
fetch, staging cleanup-on-restart. All remain in the north-star spec.

## Legal

Personal use only. Extracting copyrighted commercial audio is against YouTube's
ToS; this tool doesn't distribute. Your call, made with eyes open.
