# TTunes — vision (reshaped 2026-11-01)

Replaces the cloud version (M1 "On my phone, from the cloud", PR #11, closed unmerged). His words, 2026-11-01:

> A private web app or local/native app only where I can just drop a YouTube link, raw music/video files, or even type in the name of songs/artists to add songs to a playlist, and have it play whatever is on the playlist as long as I have it on. I don't care much for scaling it up. The core: tell the app or drop something in → app can play it or queue it to play later, and the library to pull from for an always-on playlist can be ever expanding (should feel like it).

## Intent
A music station that runs on his own computer. Adding a song takes one action. When the queue is empty, it keeps playing from everything he has ever added.

## Goals
- Add by: YouTube link, dropped audio/video file, or typed "artist – song" (search YouTube, **he picks or confirms the match**).
- Each add: play now, or queue next/last.
- Everything added lands in the library for good (stored on disk, not streamed).
- Queue empty → shuffle the library, never silence while the app is open.
- Runs on his Mac. Windows PC = a second install, later.

## Non-goals
- Hosting, accounts, passwords, cloud storage, other users, scaling.
- Playing while the app is closed.

## Later (nice to have, not M1)
- Phone on home wifi while the computer is on.
- Windows install.
- Mix in related tracks so the library "feels endless" beyond what he added.

## Done-gate (M1)
On his Mac he opens TTunes, pastes a YouTube link, drops an MP3, and types a song name and picks a match; all three play in order, and then it keeps playing from his library without him touching it.

## Decisions (2026-11-01)
- Mac first; Windows later is fine (his answer 1).
- Phone: not a priority, nice to have (answer 2).
- Typed search: show matches, he selects or confirms (answer 3).
- Builds on `main` (June local MVP: upload, shuffle, queue, delete) + branch `feat/youtube-ingest` (July: paste link → yt-dlp → confirm card → add). The cloud branch `m1-cloud-phone` is not reused, except its player screen if it's better.
- Personal use only; YouTube audio via yt-dlp stays on his disk.
