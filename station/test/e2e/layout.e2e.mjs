// Done check for the shared layout: player box and title box are the same in both looks.
// Run from station/ with a FRESH local database:
//   docker compose exec -T db createdb -U ttunes <name>
//   DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<name> node test/e2e/layout.e2e.mjs
import { spawn } from "node:child_process";
import { SignJWT } from "jose";
import pg from "pg";
import { chromium } from "playwright";
import { freePort, startDevServer } from "./devServer.mjs";

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const DB_URL = process.env.DATABASE_URL;
const check = (ok, msg) => { if (!ok) throw new Error(`E2E FAIL: ${msg}`); console.log(`ok  ${msg}`); };
if (!DB_URL || !/^postgres:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(DB_URL) || /ttunes_station$/.test(DB_URL)) {
  throw new Error("set DATABASE_URL to a fresh local database (not the shared ttunes_station)");
}
// No YouTube Data API: the seeded songs are all this test needs.
const env = { ...process.env, DATABASE_URL: DB_URL, SESSION_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123", YOUTUBE_API_KEY: "stub", YOUTUBE_API_BASE_URL: "http://127.0.0.1:1/youtube/v3" };
await new Promise((ok, bad) => spawn("npm", ["run", "db:migrate"], { env, stdio: "ignore" }).on("exit", (c) => (c === 0 ? ok() : bad(new Error("migrate failed")))));
const db = new pg.Pool({ connectionString: DB_URL });
await db.query("truncate queue, station_state, play_history, activity_log, songs, requests, request_attempts cascade");
// A one-line title: how many lines a long title wraps to depends on the font, so it can not be compared between looks.
await db.query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Sunrise',300),('seedSong002','Golden Hour',300)");
const server = await startDevServer(PORT, env);
const browser = await chromium.launch();
const { rows: [{ session_version: ver }] } = await db.query("select session_version from auth_state where id = 1");
const ownerToken = await new SignJWT({ ver }).setProtectedHeader({ alg: "HS256" }).setSubject("10647431").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(env.SESSION_SECRET));

const boxes = async (page, look) => {
  await page.evaluate((l) => { document.documentElement.dataset.look = l; }, look);
  await page.waitForTimeout(400); // let fonts settle
  const get = (sel) => page.locator(sel).first().boundingBox();
  return { player: await get(".player-host"), title: await get(".titles") };
};
const within = (a, b) => ["x", "y", "width", "height"].every((k) => Math.abs(a[k] - b[k]) <= 2);
const fmt = (b) => ["x", "y", "width", "height"].map((k) => Math.round(b[k])).join(",");

try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE);
  await page.getByTestId("now-title").waitFor();
  await page.waitForTimeout(500);
  for (const [w, h] of [[1280, 800], [375, 812], [900, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    const a = await boxes(page, "afterglow");
    const s = await boxes(page, "theset");
    check(within(a.player, s.player), `@${w}x${h} player box matches (afterglow ${fmt(a.player)} / theset ${fmt(s.player)})`);
    check(within(a.title, s.title), `@${w}x${h} title box matches (afterglow ${fmt(a.title)} / theset ${fmt(s.title)})`);
  }
  // Hint bubble never sits on the title text (wide sizes, long title in the smallest title class).
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { const h = document.querySelector("h1"); h.className = "title-s"; h.textContent = "A very long song title that wraps onto several lines of the title panel ".repeat(3); });
  for (const look of ["afterglow", "theset"]) {
    for (const w of [1000, 1100, 1240, 1280]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.evaluate((l) => { document.documentElement.dataset.look = l; }, look);
      await page.waitForTimeout(300);
      const hint = await page.locator(".hint-bubble").boundingBox();
      check(!!hint, `@${w} ${look} hint bubble is shown`);
      for (const sel of [".titles .label", ".titles h1"]) {
        const t = await page.locator(sel).first().boundingBox();
        const apart = hint.x + hint.width <= t.x || t.x + t.width <= hint.x || hint.y + hint.height <= t.y || t.y + t.height <= hint.y;
        check(apart, `@${w} ${look} hint clear of ${sel}`);
      }
    }
  }
  // Owner on a small landscape screen: the header stays two rows, so the player is on the first screen.
  const owner = await (await browser.newContext()).newPage();
  await owner.context().addCookies([{ name: "ttunes_session", value: ownerToken, url: BASE, httpOnly: true }]);
  await owner.goto(BASE);
  await owner.getByTestId("now-title").waitFor();
  for (const look of ["afterglow", "theset"]) {
    await owner.evaluate((l) => { document.documentElement.dataset.look = l; }, look);
    for (const [w, h] of [[640, 360], [568, 320], [375, 812]]) {
      await owner.setViewportSize({ width: w, height: h });
      await owner.waitForTimeout(300);
      const head = await owner.locator("header").boundingBox();
      const pl = await owner.locator(".player-host").boundingBox();
      check(head.height <= 150, `owner ${look} @${w}x${h} header is at most two rows (${Math.round(head.height)}px)`);
      check(pl.y + pl.height <= h + 1, `owner ${look} @${w}x${h} player is on the first screen (bottom ${Math.round(pl.y + pl.height)} of ${h})`);
    }
  }
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
  await db.end();
}
