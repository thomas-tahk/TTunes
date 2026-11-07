# M2 plan: hosted station

**What you get:** a public URL that plays your station from any browser. Everyone on the link hears the same song at the same second. Only you can add songs or control the station, after logging in with a passcode.

**Done-gate:** at work you open the URL, click Play and hear your station; you add a song; a friend on the same link hears the same song at the same point.

## All milestones
| # | Milestone | Done-gate |
|---|---|---|
| M1 ✅ | Mac app ([PR #18](https://github.com/thomas-tahk/TTunes/pull/18)) | done |
| **M2** | **Hosted station** (this plan) | above |
| M3 | Requests | A listener requests a song and it plays for everyone without you touching anything. You turn requests off and the request box disappears. |
| M4 | Portfolio polish | Public repo, README and demo video. |

## How it's built (my calls — say so only if you disagree)
- **Same repo, new `station/` folder.** It uses Vite + React (like the Mac app) with Vercel Functions for the API, a Neon Postgres database, and `jose` for signed login cookies. The Mac app stays untouched.
- **The "what plays next" rules are reused from the Mac app** (`src/station.ts`: your queue first, then a shuffle of the whole library). They move to a shared file so both apps use them.
- **One shared schedule.** The database holds which song started when. Each listener's page loads the schedule once and works out the right second to play. It asks again only when the song ends. Nothing on the server runs between songs: the next listener to ask after a song ends moves the station on, and that is guarded so it happens only once. *(This is what keeps it on the free tiers; see [hosting research](research/hosting.md).)*
- **YouTube rules ([research](research/youtube.md)):** the video stays visible, with no audio-only or hidden player and nothing that blocks ads. Song details are refreshed at least every 30 days.
- **Not in M2:** importing your Mac library. The Mac app keeps the downloaded audio but not which YouTube video it came from, so there's nothing to import from. You re-add songs on the hosted station.

## Tasks (each one is built by an agent and checked before it merges)
| # | Task | Builder | Waits on | Done check |
|---|---|---|---|---|
| 1 | **Station skeleton:** `station/` app, database tables, shared "what plays next" rules, and the endpoint that returns *now playing + server time*, moving on when a song ends | backend | — | Tests with a fake clock: after a song ends the next one is returned; 10 simultaneous requests move it on only once; your queue plays before the shuffle |
| 2 | **Listener page:** a Play button, joins at the right second, moves to the next song when one ends, skips videos that can't be embedded (errors 101/150) | frontend | 1 | Two automated browsers on a seeded station stay within 3 seconds of each other across a song change; the page only asks the server when a song changes |
| 3 | **Your login:** passcode → signed cookie; every owner action checks it; repeated wrong guesses get slowed down | backend | 1 | Tests: wrong passcode refused; owner actions refused without the cookie; 6th wrong try in a minute blocked |
| 4 | **Add by YouTube link:** paste a link → fetches title and length → refuses videos that can't be embedded → choose *play next* or *add to queue* (every song also joins the library) | frontend | 2, 3 | Logged in: paste a link and it shows up as next. An embed-blocked link is refused with a plain message (tested with a stubbed YouTube response) |
| 5 | **Add by typed search:** type "artist – song", pick from the matches, same add choices; says plainly when the 100-searches-a-day limit is hit | frontend | 4 | Logged in: search, pick, and it's queued; a quota error shows the message (stubbed) |
| 6 | **Your controls:** skip (for everyone), reorder or remove from the queue, delete from the library | frontend | 4 | Click skip and both listener browsers move on together; delete removes the song from library and queue |
| 7 | **Upkeep:** a daily job refreshes song details older than 25 days and drops songs that can no longer be embedded; library export as a JSON download for you | backend | 1 | Test: a stale song gets refreshed and a no-longer-embeddable one is removed; export returns the whole library |
| 8 | **Go live + done-gate:** deploy to Vercel, then run the done-gate on the live URL. Also test whether playback continues in a background tab (Chrome, Edge, Safari), which YouTube doesn't document | qa | all | The done-gate passes on the live URL; background-tab results written to the milestone report |

Tasks 2 and 3 run in parallel after 1, and 5, 6 and 7 run in parallel after 4.

## What you'll need to do (once, before task 8)
One setup task for you, with exact steps in its own `needs-you` item when task 8 needs it:
1. Create a YouTube Data API key in Google Cloud. It's free, with no card needed for this API.
2. Create a free Neon database.
3. Import the repo into Vercel and paste three values: the API key, the database URL and a passcode you choose.
