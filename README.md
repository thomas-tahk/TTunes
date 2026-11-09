# TTunes

A personal radio station for one person's music library, on a public URL. It plays by itself, everyone who tunes in joins the same song at the same live spot, and listeners can request songs with a short dedication. There is also a Mac app that runs the same idea locally, with uploads.

![Two listener screens (laptop and phone) on the same song in the Afterglow look, with the request feed showing a dedication](docs/preview/ttunes-preview.png)

**Live station:** https://t-tunes-navy.vercel.app

## Two parts

| | Hosted station (`station/`) | Mac app (repo root) |
|---|---|---|
| For | Anyone with the link | The owner, on their own Mac |
| Music | YouTube, through YouTube's embedded player | YouTube links, dropped files, typed search |
| Needs | Vercel + Neon Postgres | Node, yt-dlp, ffmpeg |

### Hosted station features
- One shared schedule: press Play and you join the current song at the live spot, from any browser. After that, pause and seek are yours; the player rejoins live only when the next song starts (or after a reload and Play).
- A **Settings** menu in the header (gear button; the choices are remembered per browser): **Look** (**Afterglow**, the default, with colours washed from the song's thumbnail, or **The Set**), **Layout** (**Side**: requests in a drawer on the right; **Stacked**: one column, everything in page flow) and, in Afterglow only, **Panel**, the colour of the request drawer and its tab: Dark tinted (default), Neutral black, Frosted, Cream or Yellow.
- Play sits right under or beside the player, so before you press it, the whole Play button is on the first screen (phones from 320x568 up and laptop screens from 1280x800; short landscape phones may need a scroll).
- Visible 16:9 YouTube player with a calm indicator under it (song progress line plus an on air / paused / buffering marker, read from the player itself); "Now playing" and "Up next" ("Anyone can request a song." sits under Up next).
- Never stops: requests first, then the owner's queue, then a shuffle of the library.
- Listener requests (the "Request a song" tab opens the drawer; the tab takes the Panel colour, Dark tinted by default): paste a link and look it up, or search by name; tap a result and it expands in place with a preview and a Send request button. Optional dedication; requests show in a public chat-style feed. A one-time hint points first-time visitors to the tab. With requests set to *open*, music under 10 minutes plays without the owner touching anything; other requests up to 15 minutes wait for approval; longer ones are refused. Each listener has one request lined up at a time and 5 an hour. The owner can switch requests to *approve first* or *off*, and deny or remove any one.
- Owner (signed in with GitHub, one account only, via "Owner sign-in (station owner only)" in the footer): add by link or search, skip, reorder, delete with undo, trash, activity log, library export, request mode open / approve first / off.

- **Listener age filter:** a listener's request for a video YouTube marks age-restricted is refused when they look it up, and listener search asks YouTube for strict SafeSearch. A request that is already queued is checked again just before it plays and is skipped if it turns out to be age-restricted. Limits, stated plainly:
  - It trusts YouTube's `ytRating` age-restricted flag and nothing else.
  - If YouTube's check fails or takes longer than 2 seconds, the song plays.
  - Explicit lyrics are not detected.
  - The owner's own songs are not checked.
  - Listener search uses strict SafeSearch, which also hides some harmless videos.
  - A request can show as Up next and then be skipped if it turns out to be age-restricted.

### Mac app features
- Add by YouTube link, drag-and-drop audio files, or typed song name (pick the match).
- Plays the queue, then shuffles everything ever added.
- Audio stays on your disk; it can be audio-only.

## How the station works
- There is one shared schedule in Postgres: which song started at what time.
- Nothing is streamed from the server. Each browser fetches the schedule and starts its own YouTube player at the live offset when you press Play or the song changes. It does not keep correcting afterwards, so a listener's pause and seek stay put.
- Songs advance lazily when someone asks, so there is no always-on server (Vercel functions + Neon, free tiers).
- The YouTube player stays visible and unmodified, as YouTube's terms require; there is no audio-only mode on the hosted station.
- Requests are limited by a signed cookie plus an IP backstop. Owner sign-in is GitHub OAuth with a signed session cookie.

## Run the hosted station locally
Needs Node 22, Docker, and for real YouTube data a YouTube Data API key.

```
cd station
npm ci
npm run db:up        # Postgres in Docker on port 55432
npm run db:migrate
npm run db:seed      # sample songs, local only
npm run dev
```

Open the address Vite prints. Environment variables (values never go in the repo):
- **Local:** `SESSION_SECRET` (any 32+ characters) and `YOUTUBE_API_KEY`. Leave `DATABASE_URL` unset so it uses the Docker database.
- **Deploy only** (set in Vercel): `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `CRON_SECRET`, optionally `IP_HASH_SALT`.

The owner is one GitHub account, set by `OWNER_GITHUB_ID` in `station/lib/auth.ts`; change it to your own GitHub user id to sign in. More in [station/README.md](station/README.md).

Tests: `npm test`, `npm run typecheck` and `npm run build` (in `station/`; the build catches CSS that dev mode silently ignores). Browser end-to-end checks, each on its own fresh database (15): sync, addlink, controls, moderation, request, afterglow, theset, settings, stacked, layout, indicator, playback, pausedowner, unplayable, slowstart (commands in [station/README.md](station/README.md)). Regenerate the preview image: `npm run preview` (needs Docker running via `npm run db:up`, Playwright's Chromium via `npx playwright install chromium`, and internet for the YouTube embed).

## Run the Mac app
Install steps for a new Mac are in [docs/INSTALL.md](docs/INSTALL.md): `brew install node yt-dlp ffmpeg`, clone, double-click `Start TTunes.command`. For development:

```
npm ci
npm run dev
```

## Known limits
- Every listener clicks Play once per visit, because browsers block autoplay.
- On a phone, playback usually stops when the screen locks. Desktop background tabs keep playing.
- Videos that block embedding are refused when added.
- YouTube may play ads; that is out of our control.
- A listener sees the owner's skip up to about 30 seconds late (kept to stay within free tiers).
- A listener who paused or sought away stays there; the player rejoins live only when the next song starts (or after a reload and Play).

Plans and decisions: [docs/chief/vision.md](docs/chief/vision.md).
