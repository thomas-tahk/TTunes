# TTunes — vision (reshaped 2026-11-07)

Two parts. **Part 1 (the Mac app) is built:** M1 was merged in [PR #18](https://github.com/thomas-tahk/TTunes/pull/18). **Part 2 (the hosted station) is the new work.**

His words, 2026-11-07:

> listen from anywhere, potentially, not just locally run on my mac. and yeah why not as a little portfolio piece too? … a live-request for anyone else and bit of a music library/playlist for myself that happens to be able to play to anyone else on the site and tuning in

## Intent
A personal radio station on a public URL. It plays his library by itself, from any browser. Anyone with the link can tune in and hear the same song at the same moment. Listeners can request songs, and requests play without him lifting a finger.

## Goals
- **He adds songs** by YouTube link or by typed search, picking the match. Only he can add; he logs in to do it.
- **Station never stops.** Requests play first, then his queue, then a shuffle of his library. No server streams anything: there is one shared schedule (which song started when), and every player seeks to the current offset.
- **One shared stream.** A listener can pause or mute their own player, and unpausing rejoins the station live. Only he can skip, reorder, delete, or override.
- **Requests** are auto-accepted, with limits: one queued request per listener and a length cap. He can turn requests off at any time and delete or override any one.
- **Portfolio-ready:** public repo, README, demo video.

## Non-goals
- Per-listener playback (everyone controls their own player). That would just be a playlist page.
- Hosting audio files. Songs play only through YouTube's embedded player, and dropped files stay in the Mac app.
- Listener accounts.
- Merging the Mac app into the hosted one. The Mac app stays as it is.

## Known limits (accepted 2026-11-07)
- Every listener clicks Play once per visit, because browsers block autoplay.
- On a phone, playback usually stops when the screen locks. Desktop background tabs keep playing.
- Videos that block embedding are refused when added.
- YouTube may play ads. That is out of our control.

## Milestones
- **M2 — Hosted station.** Done-gate: at work he opens the URL, clicks Play and hears his station, adds a song, and a friend on the same link hears the same song at the same point.
- **M3 — Requests.** Done-gate: a listener requests a song and it plays to everyone without him touching anything; he turns requests off and the request box disappears.
- **M4 — Portfolio polish.** README, demo video, public repo.

## Assumptions (for Research)
- **Assumption:** the YouTube IFrame Player API can start a video at an offset and report when it ends, reliably enough to keep listeners within a few seconds of each other.
- **Assumption:** each song's length and whether it can be embedded can be read when it's added (YouTube Data API v3 `videos.list`: `contentDetails.duration`, `status.embeddable`).
- **Assumption:** typed search fits inside the Data API free quota (a search costs 100 units; the quota is 10,000 a day, so about 100 searches a day).
- **Assumption:** hosting on Vercel plus a small Postgres (Neon) costs $0 and never pauses in a way listeners would notice. Not Supabase's free tier.
- **Assumption:** the "one queued request per listener" limit can work without accounts, using a browser cookie or IP. That's good enough for friends and family, not abuse-proof.

## Decisions
- 2026-11-07: shared stream, not per-listener (his call, on my recommendation).
- 2026-11-07: requests are auto-accepted with limits; he can turn them off or override at any time.
- 2026-11-07: the request-line-only pitch was rejected. It's no use with a small audience, and he'd have to manage every request.
- 2026-11-01 (Part 1): Mac first; typed search shows matches and he picks; yt-dlp audio stays on his disk.
