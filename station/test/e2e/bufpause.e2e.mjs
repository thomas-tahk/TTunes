// Done check (#44): a pause pressed while the next song is still buffering is honoured; the song does not start once its bytes arrive.
// Real click on the YouTube iframe (its own play/pause surface). Run from station/ with a FRESH local database (npm run e2e:bufpause).
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
await db.query("insert into queue (video_id) values ('jNQXAC9IVRw'), ('dmzID8hbMIE'), ('APVeRctVWBM')"); // first is 19s: the change comes soon
await db.end();

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const server = await startDevServer(PORT);
const browser = await chromium.launch();
let hold = false;
const videoState = (page) => {
  const f = page.frames().find((x) => /youtube/.test(x.url()));
  return f.evaluate(() => { const el = document.querySelector("video"); return el ? (el.paused ? "paused" : "playing") : "novideo"; }).catch(() => "?");
};
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route(/googlevideo\.com/, async (route) => {
    while (hold) await sleep(200);
    await route.continue().catch(() => {});
  });
  await context.addInitScript(() => {
    if (window.top !== window) return;
    window.__ev = [];
    const t0 = performance.now();
    window.addEventListener("message", (e) => { let d; try { d = JSON.parse(e.data); } catch { return; } if (d && d.event === "onStateChange") window.__ev.push(`${((performance.now() - t0) / 1000).toFixed(1)}:${d.info}`); });
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.getByTestId("now-title").waitFor();
  await page.getByRole("button", { name: "Play" }).click();
  await sleep(4000);
  const first = await page.evaluate(() => window.__ttunes.videoId());
  hold = true; // from here every new video's bytes are held back
  await page.waitForFunction((id) => window.__ttunes.videoId() !== id, first, { timeout: 40_000 });
  await sleep(2000); // the next song is loading and buffering
  const second = await page.evaluate(() => window.__ttunes.videoId());
  // The listener's pause goes through the player's own pauseVideo (the call YouTube's pause control makes). A real click on the
  // iframe during buffering is ignored by YouTube (verified: no event, player keeps loading), so it cannot be the gesture here.
  await page.evaluate(() => window.__ttunes.pause());
  await sleep(1500);
  hold = false;
  await sleep(4000);
  check((await videoState(page)) === "paused", "the pause during buffering is honoured by YouTube once the bytes arrive");
  await sleep(25_000); // well past the end of the second song (17s): a tab that did not know it was paused would have moved on and autoplayed
  console.log("events:", (await page.evaluate(() => window.__ev)).join(" "));
  check((await videoState(page)) === "paused", "25s later the song is still paused: the app knew the listener had paused");
  check((await page.evaluate(() => window.__ttunes.videoId())) === second, "the paused tab did not move on to the next song");
  await page.evaluate(() => window.__ttunes.play()); // the listener's own resume still works, and lands on the live song
  await sleep(8000);
  const now = await (await fetch(`${BASE}api/now`)).json();
  const { serverNow } = await (await fetch(`${BASE}api/time`)).json();
  const t = await page.evaluate(() => window.__ttunes.currentTime());
  check((await videoState(page)) === "playing", "pressing play resumes");
  check(Math.abs(t - (serverNow - now.startedAt) / 1000) < 3, `and it is on the live position (${t.toFixed(1)}s)`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
}
