// Done check for a paused listener whose tab keeps polling (an owner tab): later songs are cued, never autoplayed; Play then starts live.
// Run from station/ with a FRESH local database:
//   docker compose exec -T db createdb -U ttunes <name>
//   DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<name> node test/e2e/pausedowner.e2e.mjs   (npm run e2e:paused)
// Needs internet for YouTube.
import { spawn } from "node:child_process";
import { SignJWT } from "jose";
import pg from "pg";
import { chromium } from "playwright";
import { freePort, startDevServer } from "./devServer.mjs";

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
const OWNER_ID = 10647431;
const DB_URL = process.env.DATABASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) throw new Error(`E2E FAIL: ${msg}`); console.log(`ok  ${msg}`); };

if (!DB_URL || !/^postgres:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(DB_URL) || /ttunes_station$/.test(DB_URL)) {
  throw new Error("set DATABASE_URL to a fresh local database (not the shared ttunes_station)");
}

const env = { ...process.env, DATABASE_URL: DB_URL, SESSION_SECRET: SECRET };
await new Promise((ok, bad) => spawn("npm", ["run", "db:migrate"], { env, stdio: "ignore" }).on("exit", (c) => (c === 0 ? ok() : bad(new Error("db:migrate failed")))));
const db = new pg.Pool({ connectionString: DB_URL });
await db.query("truncate queue, station_state, play_history, activity_log, songs cascade");
// Three short songs: two song changes fit in about a minute.
await db.query("insert into songs (video_id, title, duration_sec) values ('jNQXAC9IVRw','Me at the zoo',19),('dmzID8hbMIE','Cool Intro',17),('APVeRctVWBM','Taps',55)");
const { rows: [{ session_version: ver }] } = await db.query("select session_version from auth_state where id = 1");
const token = await new SignJWT({ ver }).setProtectedHeader({ alg: "HS256" }).setSubject(String(OWNER_ID)).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));

const server = await startDevServer(PORT, env);
const browser = await chromium.launch();
const startedAt = async () => (await (await fetch(`${BASE}api/now`)).json()).startedAt;
const videoPaused = (page) => page.frames().find((f) => /youtube/.test(f.url())).evaluate(() => document.querySelector("video").paused);
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: "ttunes_session", value: token, url: BASE, httpOnly: true }]);
  const page = await context.newPage();
  await page.goto(BASE);
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForFunction(() => window.__ttunes && window.__ttunes.currentTime() > 0.5, null, { timeout: 30_000 });
  await page.evaluate(() => window.__ttunes.pause());
  await sleep(1500);
  check(await videoPaused(page), "the listener paused");

  let last = await startedAt();
  for (let change = 1; change <= 2; change++) {
    while ((await startedAt()) === last) await sleep(1000);
    last = await startedAt();
    await sleep(8000); // the owner tab's poll hears the change; a cue is not a play
    check(await videoPaused(page), `song change ${change}: the paused listener's player is still paused`);
  }

  await page.evaluate(() => window.__ttunes.play());
  await sleep(4000);
  const now = await (await fetch(`${BASE}api/now`)).json();
  const { serverNow } = await (await fetch(`${BASE}api/time`)).json();
  const expected = (serverNow - now.startedAt) / 1000;
  const snap = await page.evaluate(() => ({ id: window.__ttunes.videoId(), t: window.__ttunes.currentTime() }));
  check(snap.id === now.current.videoId && Math.abs(snap.t - expected) < 2.5, `Play after the cues starts live: player ${snap.t.toFixed(1)}s vs server ${expected.toFixed(1)}s`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
  await db.end();
}
