// Done check for the song indicator (both looks): progress follows the player's currentTime, "On air" while playing,
// "Paused" and no motion while paused, no motion at all under prefers-reduced-motion.
// Run: DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<fresh> node test/e2e/indicator.e2e.mjs (from station/). Needs internet for YouTube.
// Optional SHOTS_DIR=<dir> saves screenshots of both looks, playing and paused, at 1280 and 375.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import pg from "pg";
import { chromium } from "playwright";
import { freePort, startDevServer } from "./devServer.mjs";

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const DB_URL = process.env.DATABASE_URL;
const SHOTS = process.env.SHOTS_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) throw new Error(`E2E FAIL: ${msg}`); console.log(`ok  ${msg}`); };

if (!DB_URL || !/^postgres:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(DB_URL) || /ttunes_station$/.test(DB_URL)) {
  throw new Error("set DATABASE_URL to a fresh local database (not the shared ttunes_station)");
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function resetStation() {
  execSync("npm run db:migrate && npm run db:seed", { stdio: "inherit" });
  const db = new pg.Pool({ connectionString: DB_URL });
  await db.query("truncate queue, station_state, play_history");
  await db.query("delete from songs where video_id not in ('ViGb-oiEYS0')"); // the 102s song: room for every leg
  await db.query("insert into queue (video_id) values ('ViGb-oiEYS0')");
  await db.end();
}

// Progress as a fraction of the bar (continuous), converted to seconds, against the player's own time.
const read = (page) => page.evaluate(() => {
  const ind = document.querySelector('[data-testid="song-indicator"]');
  const bar = ind.querySelector('[role="progressbar"]');
  const max = Number(bar.getAttribute("aria-valuemax"));
  const width = parseFloat(bar.firstElementChild.style.width) / 100;
  return { shown: width * max, player: window.__ttunes.currentTime(), marker: ind.querySelector(".marker").textContent.trim(), animations: ind.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length };
});

async function legs(look, browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((l) => localStorage.setItem("ttunes.look", l), look);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.getByTestId("now-title").waitFor();
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForFunction(() => window.__ttunes && window.__ttunes.currentTime() > 0.5, null, { timeout: 30_000 });
  const t0 = (await read(page)).player;
  await page.waitForFunction((from) => window.__ttunes.currentTime() > from + 2, t0, { timeout: 20_000 });
  await sleep(1000);

  const a = await read(page);
  check(a.marker === "On air", `${look}: playing shows "On air" (got "${a.marker}")`);
  check(Math.abs(a.shown - a.player) < 1, `${look}: progress ${a.shown.toFixed(1)}s follows player ${a.player.toFixed(1)}s (+-1s)`);
  check(a.animations > 0, `${look}: the on-air lamp has a calm animation while playing (${a.animations})`);
  await sleep(3000);
  const b = await read(page);
  check(Math.abs(b.shown - a.shown - 3) < 1 && Math.abs(b.shown - b.player) < 1, `${look}: progress advanced ${(b.shown - a.shown).toFixed(1)}s in 3s, still in line with player`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${look}-playing-1280.png` });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await sleep(300);
  check((await read(page)).animations === 0, `${look}: prefers-reduced-motion: no animation while playing`);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.evaluate(() => window.__ttunes.pause());
  await sleep(1500);
  const p1 = await read(page);
  await sleep(3000);
  const p2 = await read(page);
  check(p1.marker === "Paused" && p2.marker === "Paused", `${look}: paused shows "Paused"`);
  check(Math.abs(p2.shown - p1.shown) < 0.2, `${look}: progress does not move while paused (${p1.shown.toFixed(1)} -> ${p2.shown.toFixed(1)})`);
  check(p2.animations === 0, `${look}: no CSS animation running on the indicator while paused (getAnimations: ${p2.animations})`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${look}-paused-1280.png` });

  await page.evaluate(() => window.__ttunes.play());
  await page.waitForFunction(() => document.querySelector('[data-testid="song-indicator"] .marker').textContent.trim() === "On air", null, { timeout: 10_000 });
  check(true, `${look}: resume returns to "On air" (player controls still work)`);

  await page.setViewportSize({ width: 375, height: 800 });
  await sleep(1000);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= 375), `${look}: no horizontal scroll at 375px`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${look}-playing-375.png` });
  await page.evaluate(() => window.__ttunes.pause());
  await sleep(1500);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${look}-paused-375.png` });
  check(errors.length === 0, `${look}: no page errors ${errors.join("; ")}`);
  await ctx.close();
}

await resetStation();
const server = await startDevServer(PORT);
const browser = await chromium.launch();
try {
  for (const look of ["afterglow", "theset"]) await legs(look, browser);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
}
