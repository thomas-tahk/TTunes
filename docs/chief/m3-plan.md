# M3 plan: requests (2026-11-07)

**What you get:** anyone on the station link can request a song with their name and an optional dedication. Music requests play for everyone without you lifting a finger. Anything else, game soundtracks included, waits for your one-tap approval. Everything shows up in a chat-style feed that everyone can see.

**Done-gate:** a listener requests a song with a dedication and it plays for everyone without you touching anything; you deny one with one tap; with the setting on *off*, the request box disappears.

Approved with M2 ("keep going until everything is ready for a pass/quality check, all Milestones included"). It follows the vision decisions of 2026-11-07.

## My calls (say so only if you disagree)
- **Play order:** requests play first, then your queue, then the shuffle.
- **How listeners request:** they paste a YouTube link or search. Listener searches get at most 60 of the 100 daily searches and 5 per hour each, so yours never run out.
- **Which requests wait for you:**
  - With the setting on *open*, Music-category requests (YouTube category 10) under 10 minutes play automatically.
  - Everything else waits for you: other categories, and anything 10 to 15 minutes long.
  - Over 15 minutes is refused for listeners.
  - With the setting on *approve first*, every request waits.
  - With it *off*, the request box is hidden and the server refuses requests.
- **Limits for each listener:**
  - Each listener can have one request waiting or queued at a time. They are identified by a signed cookie, with a hashed IP as a backstop.
  - Each listener can send 5 requests an hour.
  - A song already coming up is refused with "already coming up".
- **Text:** a name of 1 to 30 characters, and a dedication of up to 140 characters, both plain text. You can deny or remove any request.
- **Your library:** requests don't join it. Each played request has a **Keep** button that adds it.
- **Waiting requests:** they expire after 24 hours if you don't act.
- **Privacy:** IPs are stored only as salted hashes and deleted after 7 days.
- **Feed refresh:** the feed shows the last 30 requests. It reloads when someone joins, when the song changes, on the 30-second re-check, and right after a listener posts. It's cached for 10 seconds, so it stays on the free tiers.

## Tasks
| # | Task | Builder | Waits on | Done check |
|---|---|---|---|---|
| 1 | **Requests engine:** request and settings tables; posting a request by link; the music, length and setting rules; per-listener limits; requests play before your queue; status moves from waiting → queued → playing → played, or to denied or expired | backend | M2 | Tests: a Music request auto-queues and plays next; a Gaming request waits; *off* refuses; a second request from the same listener is refused; the hourly limit holds; a 20-minute request is refused |
| 2 | **Request box + feed:** a chat-style feed with name, song cover, title, dedication and a status chip; the request box with link or search; the mode chip in the feed header; the box hidden when *off* | frontend | 1 | Two browsers: one requests with a dedication and the other sees it in the feed and then hears it play; screenshots on phone and desktop |
| 3 | **Listener search:** search for requests with the daily and hourly budgets, reusing your search's ranking | backend | 1 | Tests: ranking matches your search; the listener budget runs out before yours; a plain message when it does |
| 4 | **Your moderation:** approve or deny with one tap in the feed, remove a queued request, Keep a played one, a waiting-count badge, and the three-way setting in settings, all logged | frontend | 2 | Signed in: deny one with one tap and it never plays; approve a Gaming one and it plays; switch to *off* and the listener's box disappears |
| 5 | **Go live + done-gate** on the live URL | qa | all | The done-gate passes on the live URL |
