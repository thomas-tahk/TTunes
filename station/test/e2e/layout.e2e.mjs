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
  // Hint bubble: sits right above the request tab, points down at it, stays on screen, and never covers the title text or the player.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { const h = document.querySelector("h1"); h.className = "title-s"; h.textContent = "A very long song title that wraps onto several lines of the title panel (Remastered Deluxe Edition)"; }); // 100 characters: the longest title a real video has
  const apart = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  for (const look of ["afterglow", "theset"]) {
    for (const [w, h] of [[1000, 800], [1100, 800], [1240, 800], [1280, 800], [1440, 900], [1920, 1080]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate((l) => { document.documentElement.dataset.look = l; }, look);
      await page.waitForTimeout(300);
      const hint = await page.locator(".hint-bubble").boundingBox();
      const tab = await page.locator(".drawer-tab").boundingBox();
      check(!!hint, `@${w} ${look} hint bubble is shown`);
      check(hint.x >= 0 && hint.y >= 0 && hint.x + hint.width <= w && hint.y + hint.height <= h, `@${w} ${look} hint is inside the viewport`);
      check(hint.y + hint.height <= tab.y && tab.y - (hint.y + hint.height) <= 40, `@${w} ${look} hint sits directly above the tab (${Math.round(tab.y - hint.y - hint.height)}px gap)`);
      check(Math.abs(hint.x + hint.width - w) <= 12 && tab.x + tab.width >= w - 1, `@${w} ${look} hint is right-aligned with the tab`);
      for (const sel of [".titles .label", ".titles h1", ".player-host"]) {
        check(apart(hint, await page.locator(sel).first().boundingBox()), `@${w} ${look} hint clear of ${sel}`);
      }
    }
  }
  // Phone: Tab goes top to bottom, in the order things are drawn.
  const tabOrder = await (await browser.newContext({ viewport: { width: 375, height: 812 } })).newPage();
  await tabOrder.goto(BASE);
  await tabOrder.getByTestId("now-title").waitFor();
  for (const look of ["afterglow", "theset"]) {
    await tabOrder.evaluate((l) => { document.documentElement.dataset.look = l; document.activeElement?.blur(); window.scrollTo(0, 0); }, look);
    await tabOrder.waitForTimeout(300);
    const stops = [];
    for (let i = 0; i < 5; i++) { // Look switch, request bar, tip close, Play, owner sign-in: the five stops before focus wraps
      await tabOrder.keyboard.press("Tab");
      stops.push(await tabOrder.evaluate(() => { const e = document.activeElement; const r = e.getBoundingClientRect(); return { name: (e.getAttribute("aria-label") || e.textContent || e.className || e.tagName).trim().slice(0, 22), y: Math.round(r.top + window.scrollY) }; }));
    }
    const names = stops.map((s) => `${s.name}@${s.y}`).join(" > ");
    check(stops.every((s, i) => i === 0 || s.y >= stops[i - 1].y - 2), `phone ${look}: Tab follows top-to-bottom order (${names})`);
    check(stops.findIndex((s) => /request a song/i.test(s.name)) < stops.findIndex((s) => /^play/i.test(s.name)), `phone ${look}: request bar comes before Play`);
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
