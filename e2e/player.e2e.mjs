// End-to-end check for issue #8: open TTunes on a phone-sized screen, log in, and one
// tap picks up the server station's track at its offset.
//
// Run with `npm run test:e2e` (builds first). Starts the real server with auth on,
// JSON repos and local-disk storage in a temp dir, serves the built front end with
// `vite preview` (proxying /api and /audio to that server), drives Chromium, tears down.
// Screenshots land in docs/milestones/m1-shots/.
//
// Env: PLAYWRIGHT_CHROMIUM_PATH to use a specific Chromium binary (otherwise Playwright's own).

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "docs/milestones/m1-shots");
const BIN = (name) => join(ROOT, "node_modules/.bin", process.platform === "win32" ? `${name}.cmd` : name);
const PASSWORD = "e2e-owner-password";
const OFFSET = 7;
const TAP_TO_PLAY_MAX_MS = 1000;

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

async function main() {
  const work = await mkdtemp(join(tmpdir(), "ttunes-e2e-"));
  await mkdir(SHOTS, { recursive: true });
  const apiPort = await freePort();
  const webPort = await freePort();
  const web = `http://127.0.0.1:${webPort}`;

  // Real server, auth on, JSON catalog + station and local-disk audio under the temp dir.
  const serverEnv = { ...process.env, PORT: String(apiPort), OWNER_PASSWORD: PASSWORD, SESSION_SECRET: "e2e-session-secret" };
  for (const k of ["DATABASE_URL", "S3_BUCKET", "NODE_ENV", "COOKIE_SECURE"]) delete serverEnv[k];
  start("server", BIN("tsx"), [join(ROOT, "server/index.ts")], { cwd: work, env: serverEnv });
  start("web", BIN("vite"), ["preview", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, TTUNES_API_TARGET: `http://127.0.0.1:${apiPort}` },
  });
  await waitFor(`http://127.0.0.1:${apiPort}/health`);
  await waitFor(web);

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
        multipart: { file: { name, mimeType: "audio/wav", buffer: sineWav(20, freq) } },
      });
      if (res.status() !== 201) throw new Error(`upload ${name}: ${res.status()} ${await res.text()}`);
      const track = await res.json();
      check(`upload ${name} reads a duration`, track.durationSec === 20, `durationSec=${track.durationSec}`);
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

    const m = await tapAndMeasure(page, () => playBtn.tap());
    check("audio src is the station's track", m.src === `/audio/${X}`, `src=${m.src}`);
    check(`currentTime >= offset ${OFFSET}`, m.currentTime >= OFFSET, `currentTime=${m.currentTime.toFixed(2)}`);
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
    // The phone left the station on upNext, ~1s in: the desktop picks that up.
    const dm = await tapAndMeasure(dpage, () => dbtn.click(), 0.5);
    check("desktop: one click picks up the station's track", !dm.paused && dm.src === `/audio/${upNextId}`, `src=${dm.src} currentTime=${dm.currentTime.toFixed(2)} tap->playing=${dm.tapToPlayingMs.toFixed(0)}ms`);
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
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  stopAll();
  process.exitCode = 1;
});
