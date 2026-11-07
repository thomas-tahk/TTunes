# M2 plan: hosted station (revised 2026-11-07)

**What you get:** a public URL that plays your station from any browser. Everyone on the link hears the same song at the same second. The page shows a small album-cover player with a visualizer around it. Only you can add songs or control the station, signed in with your GitHub account.

**Done-gate:** at work you open the URL, click Play and hear your station; you add a song; a friend on the same link hears the same song at the same point.

## All milestones
| # | Milestone | Done-gate |
|---|---|---|
| M1 ✅ | Mac app ([PR #18](https://github.com/thomas-tahk/TTunes/pull/18)) | done |
| **M2** | **Hosted station** (this plan) | above |
| M3 | Requests: a chat-style feed with dedications, each request playing by default, and a three-way setting (open / approve first / off) | A listener requests a song with a dedication and it plays for everyone without you touching anything. You deny one with one tap. With the setting on *off*, the request box disappears. |
| M4 | Portfolio polish | Public repo, README and demo video. |

## Agreed with you
- **The look:** a small YouTube player (the minimum 200×200) with a decorative visualizer around it. Search prefers "Artist – Topic" art-track uploads, so most songs show a still album cover. YouTube's rules don't allow hiding or covering the player, and the visualizer can't follow the actual audio, because the browser won't let our page read it.
- **What you can add:** anything, including game soundtracks, which YouTube often files under Gaming or Entertainment. You see the thumbnail and title before you confirm. Search lists Music-category and art-track results first. Anything over 15 minutes asks "add anyway?" instead of being refused. *(The Music-category filter is only for listener requests in M3: non-music requests wait for your approval.)*
- **Login:** Sign in with GitHub, allowed for your account only. There's no passcode to leak, and your GitHub two-factor covers it.
- **Never silent:** your queue plays first, then the whole library in shuffled order, reshuffling forever. No song repeats within a round, and a round never ends and starts on the same song.

## How it's built (my calls — say so only if you disagree)
- **Same repo, new `station/` folder.** It uses Vite + React with Vercel Functions for the API, a Neon Postgres database, and `jose` for signed session cookies. The Mac app stays untouched.
- **The "what plays next" rules are reused from the Mac app** (`src/station.ts`). They move to a shared file so both apps use them.
- **One shared schedule.** The database holds which song started when. Each listener's page loads the schedule once and works out the right second to play. It asks again only when the song ends. The next listener to ask after a song ends moves the station on, and that is guarded so it happens only once. *(This keeps it on the free tiers; see [hosting research](research/hosting.md).)*
- **Damage control** if someone ever got into your account: one switch signs every session out, deletes go to a trash with undo, there's a daily library export, and an activity log records every change.
- **Song details are refreshed at least every 30 days** (a YouTube rule; see [YouTube research](research/youtube.md)).
- **Not in M2:** importing your Mac library. The Mac app never saved which YouTube video each song came from.

## Tasks (each one is built by an agent and checked before it merges)
| # | Task | Builder | Waits on | Done check |
|---|---|---|---|---|
| 1 | **Station skeleton:** `station/` app, database tables, shared "what plays next" rules, and the endpoint that returns *now playing + server time*, moving on when a song ends | backend | — | Tests with a fake clock: after a song ends the next one is returned; 10 simultaneous requests move it on only once; your queue plays before the shuffle; a new round doesn't start with the song that just ended |
| 2 | **Listener page:** a Play button, a 200×200 player with the visualizer around it, joins at the right second, follows song changes, skips videos that can't be embedded (errors 101/150) | frontend | 1 | Two automated browsers on a seeded station stay within 3 seconds of each other across a song change; the page only asks the server when a song changes; the player is never smaller than 200×200 or covered |
| 3 | **Your login:** Sign in with GitHub, allowed for your account only; every owner action checks the session; a "sign out everywhere" switch | backend | 1 | Tests: any other GitHub account is refused; owner actions are refused without a session; after sign-out-everywhere, old sessions are refused |
| 4 | **Add by YouTube link:** paste a link → shows the title, length and thumbnail → refuses embed-blocked videos; over 15 minutes asks "add anyway?" → choose *play next* or *add to queue* (every song also joins the library) | frontend | 2, 3 | Signed in: paste a link and it shows up as next, including a Gaming-category soundtrack; a 2-hour video asks before adding; an embed-blocked link is refused with a plain message (stubbed YouTube responses) |
| 5 | **Add by typed search:** type "artist – song" or a game title and see all matches, with art tracks and Music category listed first, pick one, same add choices; says plainly when the 100-searches-a-day limit is hit | frontend | 4 | Signed in: search, pick, and it's queued; a Topic upload ranks above a music video for the same song; a quota error shows the message (stubbed) |
| 6 | **Your controls:** skip (for everyone), reorder or remove from the queue, delete from the library into a trash with undo, and an activity log of every change | frontend | 4 | Click skip and both listener browsers move on together; a deleted song leaves the library and queue and comes back with undo; each action appears in the log |
| 7 | **Upkeep:** a daily job refreshes song details older than 25 days and drops songs that can no longer be embedded; a daily library export, plus an export download for you | backend | 1 | Test: a stale song gets refreshed and a no-longer-embeddable one is removed; export returns the whole library |
| 8 | **Go live + done-gate:** deploy to Vercel, then run the done-gate on the live URL. Also test whether playback continues in a background tab (Chrome, Edge, Safari), which YouTube doesn't document | qa | all | The done-gate passes on the live URL; background-tab results written to the milestone report |

Tasks 2 and 3 run in parallel after 1, and 5, 6 and 7 run in parallel after 4.

## What you'll need to do (once, before task 8)
One setup task for you, with exact steps in its own `needs-you` item when task 8 needs it:
1. Create a YouTube Data API key in Google Cloud (free).
2. Create a free Neon database.
3. Create a GitHub OAuth app, which is how "Sign in with GitHub" works.
4. Import the repo into Vercel and paste the values in.
