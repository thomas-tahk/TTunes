// Done check for loose playback: sync to live only on Play and on a new song; the listener's pause and seek are never undone.
// Run: npm run e2e:playback (from station/). Needs Docker for Postgres and internet for YouTube.
import { execSync } from "node:child_process";
import pg from "pg";
import { chromium } from "playwright";
import { freePort, startDevServer } from "./devServer.mjs";

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const DB_URL = process.env.DATABASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) throw new Error(`E2E FAIL: ${msg}`); console.log(`ok  ${msg}`); };

if (!DB_URL || !/^postgres:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(DB_URL) || /ttunes_station$/.test(DB_URL)) {
  throw new Error("set DATABASE_URL to a fresh local database (not the shared ttunes_station)");
}

async function resetStation() {
  execSync("npm run db:up && npm run db:migrate && npm run db:seed", { stdio: "inherit" });
  const db = new pg.Pool({ connectionString: DB_URL });
  await db.query("truncate queue, station_state, play_history");
  // Two songs: a 102s one first (room for the pause and seek legs), then a 17s one, so the next song is a different video.
  await db.query("delete from songs where video_id not in ('ViGb-oiEYS0', 'dmzID8hbMIE')");
  await db.query("insert into queue (video_id) values ('ViGb-oiEYS0'), ('dmzID8hbMIE')");
  await db.end();
}

const snap = (page) => page.evaluate(() => ({ id: window.__ttunes.videoId(), t: window.__ttunes.currentTime() }));
const serverLive = async () => {
  const now = await (await fetch(`${BASE}api/now`)).json();
  const { serverNow } = await (await fetch(`${BASE}api/time`)).json();
  return { id: now.current.videoId, startedAt: now.startedAt, sec: (serverNow - now.startedAt) / 1000 };
};

await resetStation();
const server = await startDevServer(PORT);
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(BASE);
  await page.getByTestId("now-title").waitFor();
  await sleep(20_000); // the station is ~20s into the song before Play, so "live" is far from 0 and a never-syncing build fails the check below
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForFunction(() => window.__ttunes && window.__ttunes.currentTime() > 0.5, null, { timeout: 30_000 });
  const startId = (await snap(page)).id;
  check(startId === "ViGb-oiEYS0", "the long song plays first");
  const live = await serverLive();
  const first = await snap(page);
  check(Math.abs(first.t - live.sec) < 2.5, `after Play: at the live position (player ${first.t.toFixed(1)}s, server ${live.sec.toFixed(1)}s)`);

  await page.evaluate(() => window.__ttunes.pause());
  await sleep(1000);
  const pausedAt = (await snap(page)).t;
  await sleep(5000);
  await page.evaluate(() => window.__ttunes.play());
  await sleep(3000);
  const resumed = (await snap(page)).t;
  const liveNow = (await serverLive()).sec;
  check(resumed >= pausedAt && resumed < pausedAt + 5, `resume continues from the pause: paused ${pausedAt.toFixed(1)}s, now ${resumed.toFixed(1)}s`);
  check(liveNow - resumed > 4, `resume is not live: live ${liveNow.toFixed(1)}s vs player ${resumed.toFixed(1)}s`);

  await page.waitForFunction(() => window.__ttunes.currentTime() > 35, null, { timeout: 60_000 });
  const before = (await snap(page)).t;
  await page.evaluate(() => window.__ttunes.seekTo(window.__ttunes.currentTime() - 30));
  await sleep(10_000);
  const after = await snap(page);
  const liveAfter = (await serverLive()).sec;
  check(after.id === startId && after.t < before - 30 + 14, `seek back 30s stays for 10s: ${before.toFixed(1)}s -> ${after.t.toFixed(1)}s`);
  check(liveAfter - after.t > 25, `still behind live: live ${liveAfter.toFixed(1)}s vs player ${after.t.toFixed(1)}s`);

  const firstStart = (await serverLive()).startedAt;
  while ((await serverLive()).startedAt === firstStart) await sleep(1000); // the song ends on the server
  await sleep(6000);
  const next = await snap(page);
  const nextLive = await serverLive();
  check(next.id === "dmzID8hbMIE" && next.id === nextLive.id && Math.abs(next.t - nextLive.sec) < 3, `next song (a different video) starts live for a listener who seeked back: player ${next.t.toFixed(1)}s vs server ${nextLive.sec.toFixed(1)}s`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
}
