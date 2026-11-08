// Done check: a listener who never paused keeps hearing music when a song reports an embed error (101/150) right after YouTube's own PAUSED.
// YouTube emits PAUSED while it swaps a video; that must not be mistaken for the listener pausing (it would cue the skip target and sit silent).
// Run from station/ with a FRESH local database (npm run e2e:unplayable). Needs internet for YouTube.
import { execSync } from "node:child_process";
import pg from "pg";
import { chromium } from "playwright";
import { freePort, startDevServer } from "./devServer.mjs";

const DB_URL = process.env.DATABASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) throw new Error(`E2E FAIL: ${msg}`); console.log(`ok  ${msg}`); };
if (!DB_URL || !/^postgres:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(DB_URL) || /ttunes_station$/.test(DB_URL)) {
  throw new Error("set DATABASE_URL to a fresh local database (not the shared ttunes_station)");
}

execSync("npm run db:migrate && npm run db:seed", { stdio: "ignore" });
const db = new pg.Pool({ connectionString: DB_URL });
await db.query("truncate queue, station_state, play_history");
await db.query("insert into queue (video_id) values ('jNQXAC9IVRw'), ('dmzID8hbMIE'), ('APVeRctVWBM')");
await db.end();

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const server = await startDevServer(PORT);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Main frame only: on the first PAUSED that YouTube sends after Play, 50ms later deliver a synthetic embed error 150 from the player frame.
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__injected = false;
    window.addEventListener("message", (e) => {
      let d;
      try { d = JSON.parse(e.data); } catch { return; }
      if (!d || d.event !== "onStateChange" || d.info !== 2 || window.__injected) return;
      window.__injected = true;
      setTimeout(() => {
        const source = document.querySelector(".player-host iframe").contentWindow;
        window.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ event: "onError", info: 150, channel: "widget", id: d.id }), origin: "https://www.youtube.com", source }));
      }, 50);
    });
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.getByTestId("now-title").waitFor();
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForFunction(() => window.__ttunes && window.__ttunes.currentTime() > 0.5, null, { timeout: 30_000 });
  // Settle puts the player on live, so song 1 would end locally just before the server changes song, and a load from ENDED emits no PAUSED.
  // Seek the listener back 3s shortly before the change: the old video is still playing then, so YouTube emits its own PAUSED during the load.
  const { current, startedAt } = await (await fetch(`${BASE}api/now`)).json();
  const changeAt = startedAt + current.durationSec * 1000;
  while (Date.now() < changeAt - 6000) await sleep(250);
  await page.evaluate(() => window.__ttunes.seekTo(window.__ttunes.currentTime() - 3));
  await page.waitForFunction(() => window.__injected, null, { timeout: 30_000 });
  await sleep(8000);
  check(await page.locator("[role=status]").filter({ hasText: "can't be embedded" }).count() === 1, "the embed error was handled: skip notice shown");
  const frame = page.frames().find((f) => /youtube/.test(f.url()));
  const state = await frame.evaluate(() => { const v = document.querySelector("video"); return v ? { paused: v.paused, t: v.currentTime } : null; });
  check(state !== null && !state.paused, `a listener who never paused keeps hearing music after the error (video playing at ${state?.t.toFixed(1)}s)`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
}
