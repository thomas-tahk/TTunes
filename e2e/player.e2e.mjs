// End-to-end check for issue #8: open TTunes on a phone-sized screen, log in, and one
// tap picks up the server station's track at its offset.
//
// Run with `npm run test:e2e` (builds first). Starts the real server with auth on,
// JSON repos and local-disk storage in a temp dir, serving the built front end itself
// (STATIC_DIR=dist, the production path), drives Chromium against it, tears down.
//
// Env:
//   E2E_SHOTS                 where screenshots go (default: a fresh temp dir). The committed
//                             milestone shots are refreshed with E2E_SHOTS=docs/milestones/m1-shots.
//   PLAYWRIGHT_CHROMIUM_PATH  a specific Chromium binary (otherwise Playwright's own).
//   E2E_VERBOSE               echo the server's stdout.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const BIN = (name) => join(ROOT, "node_modules/.bin", process.platform === "win32" ? `${name}.cmd` : name);
const PASSWORD = "e2e-owner-password";
const OFFSET = 7;
const TRACK_SEC = 20;
const TAP_TO_PLAY_MAX_MS = 1000;
/** Every check() below; a run that stops early or skips one fails even if nothing FAILed. */
const EXPECTED_CHECKS = 28;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const children = [];
function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  const log = (chunk) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${chunk}`);
  child.stdout.on("data", log);
  child.stderr.on("data", (c) => process.stderr.write(`[${name}] ${c}`));
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill();
    } catch {
      // already gone
    }
  }
}

async function waitFor(url, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

/**
 * A valid 16-bit mono PCM WAV of a sine tone, so music-metadata reads a real duration.
 * With `artist`, a RIFF LIST/INFO IART chunk carries it (music-metadata reads it as the artist).
 */
function sineWav(seconds, freq, { rate = 22_050, artist } = {}) {
  const samples = seconds * rate;
  const data = samples * 2;
  let info = Buffer.alloc(0);
  if (artist) {
    const text = Buffer.from(`${artist}\0`, "latin1");
    const padded = Buffer.alloc(text.length + (text.length % 2), 0);
    text.copy(padded);
    info = Buffer.alloc(12 + 8 + padded.length);
    info.write("LIST", 0);
    info.writeUInt32LE(4 + 8 + padded.length, 4);
    info.write("INFO", 8);
    info.write("IART", 12);
    info.writeUInt32LE(text.length, 16);
    padded.copy(info, 20);
  }
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + data + info.length, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(data, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), 44 + i * 2);
  }
  return Buffer.concat([buf, info]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bytes no browser can decode, served in place of a track to make it "broken" for one context. */
const GARBAGE = Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 7919 + 13) % 251));
const serveGarbage = (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: GARBAGE });

/** Console errors, minus the expected 401 from the pre-login session probe (and any `allow`ed). */
function watchConsole(page, errors, allow = () => false) {
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (msg.location().url.includes("/api/session")) return;
    if (allow(msg)) return;
    errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
}

/** Point the station at `trackId` (as a device that's on the station's current track would). */
async function setStation(page, web, trackId, offsetSec, playing = true) {
  const cur = (await stationNow(page, web)).nowPlaying?.track.id;
  const res = await page.request.put(`${web}/api/station/now-playing`, {
    data: { trackId, offsetSec, playing, ...(cur ? { fromTrackId: cur } : {}) },
  });
  if (!res.ok()) throw new Error(`PUT now-playing: ${res.status()} ${await res.text()}`);
  const view = await res.json();
  if (view.stale || view.nowPlaying?.track.id !== trackId) throw new Error(`station didn't take ${trackId}: ${JSON.stringify(view)}`);
  return view;
}

/** The main element is playing `id` (any id when omitted) with data to play. */
const waitPlaying = (page, id, timeout = 8_000) =>
  page.waitForFunction(
    (want) => {
      const a = document.querySelector('audio[data-role="main"]');
      return a && !a.paused && a.readyState >= 3 && (!want || a.getAttribute("src") === `/audio/${want}`);
    },
    id ?? null,
    { timeout },
  );

/** Arms timing hooks, taps the big play button, and waits until audio is really playing at >= OFFSET. */
async function tapAndMeasure(page, tap, minOffset = OFFSET) {
  await page.evaluate(() => {
    const audio = document.querySelector('audio[data-role="main"]');
    window.__e2e = { tapAt: null, playingAt: null };
    document.addEventListener("pointerdown", () => (window.__e2e.tapAt ??= performance.now()), { capture: true });
    document.addEventListener("click", () => (window.__e2e.tapAt ??= performance.now()), { capture: true });
    audio.addEventListener("playing", () => (window.__e2e.playingAt ??= performance.now()));
  });
  await tap();
  await page.waitForFunction(
    (offset) => {
      const a = document.querySelector('audio[data-role="main"]');
      return a && !a.paused && a.readyState >= 3 && a.currentTime >= offset;
    },
    minOffset,
    { timeout: 5_000 },
  );
  return page.evaluate(() => {
    const a = document.querySelector('audio[data-role="main"]');
    return {
      tapToPlayingMs: window.__e2e.playingAt - window.__e2e.tapAt,
      sinceTapMs: performance.now() - window.__e2e.tapAt,
      src: a.getAttribute("src"),
      currentTime: a.currentTime,
      paused: a.paused,
    };
  });
}

/** The station's position in its now-playing track as of now (GET /api/station computes it). */
async function stationNow(page, web) {
  const res = await page.request.get(`${web}/api/station`);
  if (!res.ok()) throw new Error(`GET /api/station: ${res.status()}`);
  return res.json();
}

const audioState = (page) =>
  page.evaluate(() => {
    const a = document.querySelector('audio[data-role="main"]');
    return { src: a.getAttribute("src"), t: a.currentTime, paused: a.paused, ended: a.ended };
  });

let SHOTS;

async function main() {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("dist/ not built: run `npm run test:e2e` (it builds first)");
  const work = await mkdtemp(join(tmpdir(), "ttunes-e2e-"));
  SHOTS = process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : await mkdtemp(join(tmpdir(), "ttunes-e2e-shots-"));
  await mkdir(SHOTS, { recursive: true });
  const port = await freePort();
  const web = `http://127.0.0.1:${port}`;

  // Real server, auth on, JSON catalog + station and local-disk audio under the temp dir,
  // serving the built front end like production does.
  const serverEnv = {
    ...process.env,
    PORT: String(port),
    OWNER_PASSWORD: PASSWORD,
    SESSION_SECRET: "e2e-session-secret",
    STATIC_DIR: DIST,
  };
  for (const k of ["DATABASE_URL", "S3_BUCKET", "NODE_ENV", "COOKIE_SECURE"]) delete serverEnv[k];
  start("server", BIN("tsx"), [join(ROOT, "server/index.ts")], { cwd: work, env: serverEnv });
  await waitFor(`${web}/health`);

  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  const consoleErrors = [];
  try {
    // ---- phone ----
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await phone.newPage();
    watchConsole(page, consoleErrors);
    const audioRequests = [];
    page.on("request", (req) => {
      const m = /\/audio\/([^/?#]+)/.exec(new URL(req.url()).pathname);
      if (m) audioRequests.push(m[1]);
    });

    // Log in through the login screen.
    await page.goto(web);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock" }).tap();
    await page.getByText("Your station is empty").waitFor();
    check("empty library shows the uploader prompt and no play button", (await page.locator(".hero__play").count()) === 0);
    await page.screenshot({ path: join(SHOTS, "empty-390x844.png") });

    // Seed the station through the API (the page's session cookie authenticates these).
    const ids = [];
    const longName = "Beta Tone (an extraordinarily long extended-remix-version-title that has to wrap on a phone).wav";
    // Alpha has a long artist: the player bar must ellipsize it and keep the time on screen.
    const longArtist = "The Extraordinarily Long-Named Philharmonic Orchestra and Choir of Somewhere Far Away";
    for (const [name, freq, artist] of [["Alpha Tone.wav", 440, longArtist], [longName, 554]]) {
      const res = await page.request.post(`${web}/api/tracks`, {
        multipart: { file: { name, mimeType: "audio/wav", buffer: sineWav(TRACK_SEC, freq, { artist }) } },
      });
      if (res.status() !== 201) throw new Error(`upload ${name}: ${res.status()} ${await res.text()}`);
      const track = await res.json();
      check(`upload ${name} reads a duration`, track.durationSec === TRACK_SEC, `durationSec=${track.durationSec}`);
      ids.push(track.id);
    }
    const X = ids[0];
    const put = await page.request.put(`${web}/api/station/now-playing`, {
      data: { trackId: X, offsetSec: OFFSET, playing: true },
    });
    if (!put.ok()) throw new Error(`PUT now-playing: ${put.status()} ${await put.text()}`);

    // Open the player page and tap once.
    await page.goto(web);
    const playBtn = page.locator(".hero__play");
    await playBtn.waitFor();
    await page.waitForFunction(() => document.querySelector('audio[data-role="main"]')?.getAttribute("src"));
    await page.screenshot({ path: join(SHOTS, "tap-to-play-390x844.png") });

    // The "pick up at m:ss" hint follows the station while it plays.
    const hint = page.locator(".hero__hint");
    const hint1 = await hint.textContent();
    await page.waitForTimeout(2100);
    const hint2 = await hint.textContent();
    const secs = (s) => {
      const m = /(\d+):(\d\d)/.exec(s ?? "");
      return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
    };
    check("tap hint ticks forward while the station plays", secs(hint2) > secs(hint1), `"${hint1}" -> "${hint2}"`);

    // Where the station is right before the tap: the player must start at least there.
    const before = await stationNow(page, web);
    const liveOffset = before.nowPlaying.offsetSec;
    const m = await tapAndMeasure(page, () => playBtn.tap(), liveOffset);
    check("audio src is the station's track", m.src === `/audio/${X}`, `src=${m.src}`);
    check(
      "currentTime >= the station's live offset",
      m.currentTime >= liveOffset,
      `currentTime=${m.currentTime.toFixed(2)} live offset=${liveOffset.toFixed(2)}`,
    );
    check(
      `tap to playing within ${TAP_TO_PLAY_MAX_MS}ms`,
      m.tapToPlayingMs <= TAP_TO_PLAY_MAX_MS,
      `tap->playing=${m.tapToPlayingMs.toFixed(0)}ms, tap->asserted=${m.sinceTapMs.toFixed(0)}ms`,
    );
    const t1 = await page.evaluate(() => document.querySelector('audio[data-role="main"]').currentTime);
    await page.waitForTimeout(1000);
    const after = await page.evaluate(() => {
      const a = document.querySelector('audio[data-role="main"]');
      return { t: a.currentTime, paused: a.paused };
    });
    check("audio is playing and advancing", !after.paused && after.t > t1 + 0.5, `${t1.toFixed(2)}s -> ${after.t.toFixed(2)}s over 1s`);

    const widths = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    check("no horizontal scroll at 390", widths.scrollWidth <= widths.innerWidth, `scrollWidth=${widths.scrollWidth} innerWidth=${widths.innerWidth}`);

    const station = await (await page.request.get(`${web}/api/station`)).json();
    const upNextId = station.upNext?.id;
    const prefetchSrc = await page.evaluate(() => document.querySelector('audio[data-role="prefetch"]')?.getAttribute("src"));
    check(
      "next track is prefetched",
      !!upNextId && (audioRequests.includes(upNextId) || prefetchSrc === `/audio/${upNextId}`),
      `upNext=${upNextId} prefetch src=${prefetchSrc} requested=${audioRequests.includes(upNextId)}`,
    );
    check("station reports the track playing", station.nowPlaying?.track.id === X && station.nowPlaying.playing === true);

    const targets = await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .filter((b) => b.offsetParent !== null)
        .map((b) => ({ label: b.getAttribute("aria-label") ?? b.textContent, w: b.offsetWidth, h: b.offsetHeight }))
        .filter((b) => b.w < 44 || b.h < 44),
    );
    check("all visible buttons are at least 44x44", targets.length === 0, targets.map((t) => `${t.label} ${t.w}x${t.h}`).join(", "));

    await page.screenshot({ path: join(SHOTS, "playing-390x844.png") });

    const bar = await page.evaluate(() => {
      const box = (sel) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
      };
      return {
        artist: document.querySelector(".playerbar__artist")?.textContent,
        time: box(".playerbar__time"),
        vw: document.documentElement.clientWidth,
        vh: window.innerHeight,
      };
    });
    check(
      "player bar time stays on screen at 390 with a long artist",
      bar.artist === longArtist &&
        !!bar.time &&
        bar.time.left >= 0 &&
        bar.time.right <= bar.vw &&
        bar.time.top >= 0 &&
        bar.time.bottom <= bar.vh,
      `artist="${bar.artist?.slice(0, 24)}…" time box x ${bar.time?.left.toFixed(0)}..${bar.time?.right.toFixed(0)} of ${bar.vw}`,
    );

    // Let the track run out: the player moves to upNext and tells the station (POST /next {fromTrackId}).
    await page.evaluate(() => {
      document.querySelector('audio[data-role="main"]').currentTime = 19;
    });
    await page.waitForFunction(
      (id) => {
        const a = document.querySelector('audio[data-role="main"]');
        return a.getAttribute("src") === `/audio/${id}` && !a.paused && a.currentTime > 0;
      },
      upNextId,
      { timeout: 5_000 },
    );
    await page.waitForTimeout(300);
    const advanced = await (await page.request.get(`${web}/api/station`)).json();
    check(
      "on ended, the next track plays and the station follows",
      advanced.nowPlaying?.track.id === upNextId && advanced.nowPlaying.playing,
      `station now=${advanced.nowPlaying?.track.id}`,
    );

    // The station moves on while this device still has the last seconds of its track
    // (as after a buffering stall): the device finishes them, then joins the station.
    const B = upNextId;
    const moveTo = advanced.upNext?.id ?? X;
    const moved = await page.request.put(`${web}/api/station/now-playing`, {
      data: { trackId: moveTo, offsetSec: 0, playing: true, fromTrackId: B },
    });
    if (!moved.ok()) throw new Error(`PUT now-playing (move on): ${moved.status()} ${await moved.text()}`);
    // Seeking near the end makes the page report its (now stale) position and adopt the answer.
    const reported = page.waitForResponse((r) => r.url().endsWith("/api/station/now-playing") && r.request().method() === "PUT");
    await page.evaluate((t) => {
      document.querySelector('audio[data-role="main"]').currentTime = t;
    }, TRACK_SEC - 3.5);
    const staleAnswer = await (await reported).json();
    await page.waitForTimeout(800);
    const tail = await audioState(page);
    check(
      "station moves on near the end: the device finishes its track first",
      staleAnswer.stale === true &&
        staleAnswer.nowPlaying?.track.id === moveTo &&
        tail.src === `/audio/${B}` &&
        !tail.paused &&
        tail.t >= TRACK_SEC - 3,
      `answer stale=${staleAnswer.stale} now=${staleAnswer.nowPlaying?.track.id}; local src=${tail.src} t=${tail.t.toFixed(2)}`,
    );
    await page.waitForFunction(
      (id) => {
        const a = document.querySelector('audio[data-role="main"]');
        return a.getAttribute("src") === `/audio/${id}` && !a.paused && a.currentTime > 0;
      },
      moveTo,
      { timeout: 8_000 },
    );
    const joined = await audioState(page);
    check(
      "...then joins the station's track on ended",
      joined.src === `/audio/${moveTo}` && !joined.paused,
      `src=${joined.src} t=${joined.t.toFixed(2)}`,
    );

    // Same again, but the listener pauses during those last seconds: the device must stay
    // paused (on either track), not start the station's next one by itself.
    const P = moveTo;
    const pauseTo = (await stationNow(page, web)).upNext?.id;
    const moved2 = await page.request.put(`${web}/api/station/now-playing`, {
      data: { trackId: pauseTo, offsetSec: 0, playing: true, fromTrackId: P },
    });
    if (!moved2.ok()) throw new Error(`PUT now-playing (move on 2): ${moved2.status()} ${await moved2.text()}`);
    const reported2 = page.waitForResponse((r) => r.url().endsWith("/api/station/now-playing") && r.request().method() === "PUT");
    await page.evaluate((t) => {
      document.querySelector('audio[data-role="main"]').currentTime = t;
    }, TRACK_SEC - 3.5);
    await reported2;
    await page.waitForTimeout(300);
    const deferred2 = await audioState(page);
    await page.evaluate(() => document.querySelector('audio[data-role="main"]').pause());
    await page.waitForTimeout(800);
    const paused1 = await audioState(page);
    await page.waitForTimeout(5000); // past the local track's end + the deferral deadline
    const paused2 = await audioState(page);
    check(
      "pause during the finish-the-tail window stays paused",
      deferred2.src === `/audio/${P}` && paused1.paused && paused2.paused,
      `before pause src=${deferred2.src}; +0.8s src=${paused1.src} paused=${paused1.paused}; +5.8s src=${paused2.src} paused=${paused2.paused}`,
    );
    await phone.close();

    // ---- desktop ----
    // A session cookie for the later contexts: log in once more via the API in a scratch context.
    const session = await (async () => {
      const c = await browser.newContext();
      await c.request.post(`${web}/api/login`, { data: { password: PASSWORD } });
      const s = await c.storageState();
      await c.close();
      return s;
    })();
    const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: session };
    const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: session });
    const dpage = await desk.newPage();
    watchConsole(dpage, consoleErrors);
    await dpage.goto(web);
    const dbtn = dpage.locator(".hero__play");
    await dbtn.waitFor();
    // The phone left the station a few seconds into its latest track: the desktop picks that up.
    const dStation = await stationNow(dpage, web);
    const dTrack = dStation.nowPlaying?.track.id;
    const dm = await tapAndMeasure(dpage, () => dbtn.click(), dStation.nowPlaying?.offsetSec ?? 0);
    check(
      "desktop: one click picks up the station's track at its live offset",
      !dm.paused && dm.src === `/audio/${dTrack}` && dm.currentTime >= dStation.nowPlaying.offsetSec,
      `src=${dm.src} currentTime=${dm.currentTime.toFixed(2)} live offset=${dStation.nowPlaying?.offsetSec.toFixed(2)} tap->playing=${dm.tapToPlayingMs.toFixed(0)}ms`,
    );
    const dw = await dpage.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    check("no horizontal scroll at 1280", dw.scrollWidth <= dw.innerWidth, `scrollWidth=${dw.scrollWidth} innerWidth=${dw.innerWidth}`);
    await dpage.screenshot({ path: join(SHOTS, "playing-1280x800.png") });
    await desk.close();

    const [A, Bt] = ids; // Alpha, Beta (the long title)

    // ---- play now right after opening, before the first track's metadata arrives ----
    // The station sits 12s into Alpha; audio is slow; Beta's play-now must start Beta at 0,
    // not at Alpha's pending 12s.
    {
      const ctx = await browser.newContext(PHONE);
      const p = await ctx.newPage();
      watchConsole(p, consoleErrors);
      await p.route("**/audio/**", async (route) => {
        await sleep(1500);
        await route.continue().catch(() => {}); // the request may be gone (src changed)
      });
      await setStation(p, web, A, 12, true);
      await p.goto(web);
      await p.waitForFunction((id) => document.querySelector('audio[data-role="main"]')?.getAttribute("src") === `/audio/${id}`, A);
      const meta = await p.evaluate(() => document.querySelector('audio[data-role="main"]').readyState);
      await p.evaluate(() => {
        const a = document.querySelector('audio[data-role="main"]');
        window.__firstPlaying = null;
        a.addEventListener("playing", () => (window.__firstPlaying ??= { src: a.getAttribute("src"), t: a.currentTime }));
      });
      await p.locator(".row", { hasText: "Beta Tone" }).locator(".row__play").tap();
      await waitPlaying(p, Bt);
      await sleep(300);
      const s = await p.evaluate(() => ({ first: window.__firstPlaying, t: document.querySelector('audio[data-role="main"]').currentTime }));
      check(
        "play now tapped right after opening starts the new track at 0",
        meta === 0 && s.first?.src === `/audio/${Bt}` && s.first.t < 1 && s.t < 2,
        `readyState at tap=${meta}; first playing src=${s.first?.src} at ${s.first?.t.toFixed(2)}s; +0.3s at ${s.t.toFixed(2)}s`,
      );
      await ctx.close();
    }

    // ---- a paused tab that sat around while the station moved on, then Play ----
    {
      const ctx = await browser.newContext(PHONE);
      const p = await ctx.newPage();
      watchConsole(p, consoleErrors);
      await setStation(p, web, A, 1, true);
      await p.goto(web);
      await p.locator(".hero__play").waitFor();
      await p.locator(".hero__play").tap();
      await waitPlaying(p, A);
      const playPause = p.locator(".playerbar__controls .ctrl--primary");
      await playPause.tap(); // pause at ~1-2s; the station records it
      await sleep(5600); // the tab's view of the station is now stale
      const pausedAt = (await audioState(p)).t;
      await setStation(p, web, A, 11, true); // another device played on to 0:11
      await playPause.tap();
      await sleep(900);
      const same = await audioState(p);
      const st1 = (await stationNow(p, web)).nowPlaying;
      check(
        "stale paused tab: Play joins the station's position on the same track",
        !same.paused && same.src === `/audio/${A}` && same.t >= 10.5 && st1.track.id === A && st1.offsetSec >= 10.5,
        `paused at ${pausedAt.toFixed(2)}s; after Play local t=${same.t.toFixed(2)}s, station ${st1.track.id === A ? "A" : st1.track.id} at ${st1.offsetSec.toFixed(2)}s`,
      );

      await playPause.tap();
      await sleep(5600);
      await setStation(p, web, Bt, 4, true); // another device moved to Beta
      await playPause.tap();
      await waitPlaying(p, Bt, 5_000).catch(() => {});
      await sleep(300);
      const other = await audioState(p);
      const st2 = (await stationNow(p, web)).nowPlaying;
      check(
        "stale paused tab: Play swaps to the station's other track",
        !other.paused && other.src === `/audio/${Bt}` && other.t >= 3.5 && st2.track.id === Bt,
        `local src=${other.src} t=${other.t.toFixed(2)}s; station ${st2.track.id === Bt ? "B" : st2.track.id} at ${st2.offsetSec.toFixed(2)}s`,
      );
      await ctx.close();
    }

    // ---- a track this browser can't decode (served as garbage to this context only) ----
    {
      const ctx = await browser.newContext(PHONE);
      const p = await ctx.newPage();
      const zRes = await p.request.post(`${web}/api/tracks`, {
        multipart: { file: { name: "Zeta Tone.wav", mimeType: "audio/wav", buffer: sineWav(TRACK_SEC, 660) } },
      });
      if (zRes.status() !== 201) throw new Error(`upload Zeta: ${zRes.status()}`);
      const Z = (await zRes.json()).id;
      // The mocked 415 below logs a "Failed to load resource" error; that one is expected.
      watchConsole(p, consoleErrors, (msg) => msg.location().url.includes("/api/tracks") && msg.text().includes("415"));
      await p.route(`**/audio/${Z}`, serveGarbage);

      // Cold open on it: the station moves past it, the card offers a playable track, nothing plays.
      await setStation(p, web, Z, 0, true);
      await p.goto(web);
      const notice = p.locator(".playerbar__notice");
      await notice.filter({ hasText: "Couldn't play Zeta Tone — skipping." }).waitFor({ timeout: 6_000 });
      await p.waitForFunction((z) => {
        const t = document.querySelector(".hero__title")?.textContent;
        return t && t !== "Zeta Tone";
      }, Z);
      await sleep(300);
      const cold = await audioState(p);
      const coldStation = (await stationNow(p, web)).nowPlaying;
      const heroTitle = await p.locator(".hero__title").textContent();
      await p.screenshot({ path: join(SHOTS, "bad-track-skip-390x844.png") });
      check(
        "cold open on an unplayable track: notice, station skips it, no autoplay",
        coldStation.track.id !== Z && cold.src === `/audio/${coldStation.track.id}` && cold.paused && heroTitle === coldStation.track.title,
        `station now ${coldStation.track.title}; card "${heroTitle}"; local paused=${cold.paused}`,
      );

      // While listening: play-now on it skips to the next track and keeps playing.
      await p.locator(".hero__play").tap();
      await waitPlaying(p);
      await p.locator(".row", { hasText: "Zeta Tone" }).locator(".row__play").tap();
      await notice.filter({ hasText: "Couldn't play Zeta Tone — skipping." }).waitFor({ timeout: 6_000 });
      await p.waitForFunction((z) => {
        const a = document.querySelector('audio[data-role="main"]');
        return !a.paused && a.readyState >= 3 && a.getAttribute("src") !== `/audio/${z}`;
      }, Z, { timeout: 8_000 });
      await sleep(500);
      const live = await audioState(p);
      const liveStation = (await stationNow(p, web)).nowPlaying;
      check(
        "listening, an unplayable track is skipped and playback carries on",
        !live.paused && live.src === `/audio/${liveStation.track.id}` && liveStation.track.id !== Z && liveStation.playing,
        `now ${live.src} t=${live.t.toFixed(2)}s; station on ${liveStation.track.title} playing=${liveStation.playing}`,
      );

      // A failed upload says so, with the server's reason, and stays up (the server's 415 is mocked here).
      await p.route("**/api/tracks", async (route) => {
        const body = route.request().postDataBuffer()?.toString("latin1") ?? "";
        if (route.request().method() === "POST" && body.includes('filename="bad-notes.txt"')) {
          await route.fulfill({ status: 415, contentType: "application/json", body: JSON.stringify({ error: "not a playable audio file" }) });
        } else await route.continue();
      });
      await p.locator(".uploader input").setInputFiles([
        { name: "Gamma Tone.wav", mimeType: "audio/wav", buffer: sineWav(TRACK_SEC, 330) },
        { name: "bad-notes.txt", mimeType: "text/plain", buffer: Buffer.from("not music") },
      ]);
      const upErr = p.locator(".upload-error");
      await upErr.waitFor({ timeout: 8_000 });
      await sleep(4500); // longer than any transient notice
      const upText = (await upErr.textContent())?.replace("✕", "").trim();
      const upVisible = await upErr.isVisible();
      await p.locator(".row", { hasText: "Gamma Tone" }).waitFor({ timeout: 5_000 });
      await p.screenshot({ path: join(SHOTS, "upload-failed-390x844.png") });
      await upErr.getByRole("button", { name: "Dismiss" }).tap();
      const dismissed = (await upErr.count()) === 0;
      check(
        "a failed upload stays on screen with the server's reason until dismissed",
        upVisible && upText === "Couldn't add 1 of 2: bad-notes.txt (not a playable audio file)" && dismissed,
        `"${upText}" visible after 4.5s=${upVisible}, gone after dismiss=${dismissed}`,
      );

      // Queue full on touch: the buttons and Up next say so (no hover needed).
      const cap = (await stationNow(p, web)).queueCap;
      const firstQueue = p.locator(".row__queue").first();
      for (let i = 0; i < cap; i++) {
        const answered = p.waitForResponse((r) => r.url().endsWith("/api/station/queue") && r.request().method() === "POST");
        await firstQueue.tap();
        await answered;
      }
      await p.locator(".upnext__full").waitFor({ timeout: 3_000 });
      const qButtons = await p.evaluate(() =>
        [...document.querySelectorAll(".row__queue")].map((b) => ({ text: b.textContent, disabled: b.disabled, h: b.offsetHeight, w: b.offsetWidth })),
      );
      const fullLine = await p.locator(".upnext__full").textContent();
      // The "full" line at the top, the library's "Queue full" buttons under it.
      await p.locator(".upnext__full").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await p.screenshot({ path: join(SHOTS, "queue-full-390x844.png") });
      check(
        "queue full is visible without hover, buttons stay 44px",
        fullLine === "Queue is full — remove one to add more." &&
          qButtons.length > 0 &&
          qButtons.every((b) => b.text === "Queue full" && b.disabled && b.h >= 44 && b.w >= 44),
        `"${fullLine}"; buttons ${[...new Set(qButtons.map((b) => `${b.text} ${b.w}x${b.h}`))].join(", ")}`,
      );
      // Leave the queue empty for anything after this.
      for (let i = 0; i < cap; i++) {
        const view = await stationNow(p, web);
        if (!view.queue.length) break;
        await p.request.delete(`${web}/api/station/queue/0?trackId=${view.queue[0].id}`);
      }
      await ctx.close();
    }

    // ---- every track unplayable: the skip stops after a few in a row instead of spinning ----
    {
      const ctx = await browser.newContext(PHONE);
      const p = await ctx.newPage();
      watchConsole(p, consoleErrors);
      await p.route("**/audio/**", serveGarbage);
      let nexts = 0;
      p.on("request", (r) => {
        if (r.url().endsWith("/api/station/next") && r.method() === "POST") nexts++;
      });
      await p.goto(web);
      const stopNotice = p.locator(".playerbar__notice", { hasText: "in a row" });
      await stopNotice.waitFor({ timeout: 15_000 });
      const atStop = nexts;
      await sleep(3000);
      const stopText = await stopNotice.textContent().catch(() => null);
      check(
        "every track unplayable: stops skipping after 5 in a row, with a notice that stays",
        atStop === 4 && nexts === 4 && stopText === "Couldn't play 5 tracks in a row, so playback stopped. Tap Next to try again.",
        `next requests at stop=${atStop}, 3s later=${nexts}; notice "${stopText}"`,
      );
      await ctx.close();
    }

    check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  } finally {
    await browser.close();
    stopAll();
    await rm(work, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (expected ${EXPECTED_CHECKS}). Screenshots: ${SHOTS}`);
  if (failed.length) process.exitCode = 1;
  if (results.length !== EXPECTED_CHECKS) {
    console.error(`FAIL  ran ${results.length} checks, expected ${EXPECTED_CHECKS}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  console.error(`\n${results.filter((r) => r.ok).length}/${EXPECTED_CHECKS} checks passed before the run stopped. Screenshots: ${SHOTS}`);
  stopAll();
  process.exitCode = 1;
});
