# TTunes — vision (reshaped 2026-11-07)

Two parts. **Part 1 (the Mac app) is built:** M1 was merged in [PR #18](https://github.com/thomas-tahk/TTunes/pull/18). **Part 2 (the hosted station) is the new work.**

His words, 2026-11-07:

> listen from anywhere, potentially, not just locally run on my mac. and yeah why not as a little portfolio piece too? … a live-request for anyone else and bit of a music library/playlist for myself that happens to be able to play to anyone else on the site and tuning in

## Intent
A personal radio station on a public URL. It plays his library by itself, from any browser. Anyone with the link can tune in and hear the same song at the same moment. Listeners can request songs, and requests play without him lifting a finger.

## Goals
- **He adds songs** by YouTube link or by typed search, picking the match. Anything goes for him, game soundtracks included (often filed under Gaming, not Music); over 15 minutes asks "add anyway?". Only he can add, signed in with GitHub (his account only).
- **The look:** a small, visible YouTube player (200×200 minimum) with a decorative visualizer around it. Search prefers "Artist – Topic" art tracks, so most songs show a still album cover.
- **Station never stops.** Requests play first, then his queue, then a shuffle of his library. No server streams anything: there is one shared schedule (which song started when), and every player seeks to the current offset.
- **One shared stream.** A listener can pause or mute their own player, and unpausing rejoins the station live. Only he can skip, reorder, delete, or override.
- **Requests (M3)** appear in a chat-style feed that everyone sees, with name, song, an optional dedication and a status. Music-category requests play by default with limits (one queued per listener); anything else, such as game soundtracks, waits for his approval; he can deny any one with one tap. A setting in his settings: open / approve first / off.
- **Portfolio-ready:** public repo, README, live URL anyone can open and use, plus a ~25s looping preview clip for the portfolio site.

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
- **M4 — Portfolio polish.** README, public repo, short preview clip (sync side by side + one-tap moderation). "Demo" itself = the live URL.

## Assumptions (researched 2026-11-07 — docs/chief/research/youtube.md, hosting.md)
- **Verified:** IFrame API starts at an offset (`start`/`seekTo`, keyframe-approximate) and reports end (state 0); embed-blocked = error 101/150, handled at play time too.
- **Verified:** `videos.list` (1 unit, API key only) gives duration + embeddable. Metadata may be cached ≤30 days (ToS III.E.4) → store video ID, refresh metadata.
- **Verified (wording fixed):** typed search has its own cap of 100 searches/day.
- **Verified:** Vercel Hobby + Neon free cover it, IF clients fetch the schedule once and compute the offset themselves (no per-second polling; DB touched on song change, plus a 30s re-check while playing). Hobby cron is daily-only → advance songs lazily on request.
- **Verified:** request limit = signed httpOnly cookie + IP backstop; admin = ~~passcode env var → signed session cookie, rate-limited login~~ (superseded 2026-11-07 by GitHub sign-in, see the log below).
- **Constraint (ToS III.I.5–9):** the video player stays visible and unmodified — no hidden, audio-only or background player, no ad interference.
- **Open:** muted-autoplay and background-tab behaviour (not documented — test in M2); whether Neon deletes long-idle free projects (keep an export).

## Later (his words 2026-11-07: "I may want to have exceptions down the line")
- Exceptions to the request filter (e.g. trusted listeners or channels that skip approval).

## Decisions
- 2026-11-07: M2 plan approved ("looks sound overall"); he asked to build all milestones (M2–M4) through to ready-for-check.
- 2026-11-07: filtering depends on who adds. His adds have no category filter (game soundtracks); listener requests outside the Music category wait for his approval.
- 2026-11-07: audio-only is out on the hosted station (the YouTube player must stay visible; serving the audio ourselves would be public redistribution). Album cover plus visualizer accepted. Audio-only stays in the Mac app.
- 2026-11-07: GitHub sign-in instead of a passcode; damage control = sign out everywhere, trash with undo, daily export, activity log.
- 2026-11-07: the request feed design (mockup in chat) and the three-way setting live in settings, with a status chip in the feed header.
- 2026-11-07: shared stream, not per-listener (his call, on my recommendation).
- 2026-11-07: requests are auto-accepted with limits; he can turn them off or override at any time.
- 2026-11-07: the request-line-only pitch was rejected. It's no use with a small audience, and he'd have to manage every request.
- 2026-11-01 (Part 1): Mac first; typed search shows matches and he picks; yt-dlp audio stays on his disk.
