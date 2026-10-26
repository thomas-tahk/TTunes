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
const EXPECTED_CHECKS = 18;

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

/** A valid 16-bit mono PCM WAV of a sine tone, so music-metadata reads a real duration. */
function sineWav(seconds, freq, rate = 22_050) {
  const samples = seconds * rate;
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + data, 4);
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
  return buf;
}

/** Console errors, minus the expected 401 from the pre-login session probe. */
function watchConsole(page, errors) {
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (msg.location().url.includes("/api/session")) return;
    errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
}

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
    for (const [name, freq] of [["Alpha Tone.wav", 440], [longName, 554]]) {
      const res = await page.request.post(`${web}/api/tracks`, {
        multipart: { file: { name, mimeType: "audio/wav", buffer: sineWav(TRACK_SEC, freq) } },
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
    await phone.close();

    // ---- desktop ----
    const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await (async () => {
      // reuse the session cookie: log in once more via the API in a scratch context
      const c = await browser.newContext();
      await c.request.post(`${web}/api/login`, { data: { password: PASSWORD } });
      const s = await c.storageState();
      await c.close();
      return s;
    })() });
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
