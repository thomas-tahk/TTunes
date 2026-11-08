// Done check: a slow start (video bytes held 4s after Play) still ends up on the live position, because the first PLAYING seeks to live.
// Run from station/ with a FRESH local database (npm run e2e:slowstart). Needs internet for YouTube.
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
await db.query("insert into queue (video_id) values ('ViGb-oiEYS0')"); // 102s: no song change during the check
await db.end();

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const server = await startDevServer(PORT);
const browser = await chromium.launch();
let hold = false;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route(/googlevideo\.com/, async (route) => {
    while (hold) await sleep(200);
    await route.continue().catch(() => {});
  });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.getByTestId("now-title").waitFor();
  hold = true;
  setTimeout(() => { hold = false; }, 4000);
  await page.getByRole("button", { name: "Play" }).click();
  await sleep(10_000);
  const now = await (await fetch(`${BASE}api/now`)).json();
  const { serverNow } = await (await fetch(`${BASE}api/time`)).json();
  const expected = (serverNow - now.startedAt) / 1000;
  const t = await page.evaluate(() => window.__ttunes.currentTime());
  check(Math.abs(t - expected) < 2.5, `after a 4s slow start the player is live: player ${t.toFixed(1)}s vs server ${expected.toFixed(1)}s`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
}
