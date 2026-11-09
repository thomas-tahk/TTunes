// Done check for the shared layout: player box and title box are the same in both looks.
// Run from station/ with a FRESH local database:
//   docker compose exec -T db createdb -U ttunes <name>
//   DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<name> node test/e2e/layout.e2e.mjs
// Optional: SHOTS_DIR=<dir/> (trailing slash) writes the before-Play screenshots.
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
    await tabOrder.mouse.click(1, 1); // Tab starts from the top of the page, not from where the last look left focus
    const stops = [];
    for (let i = 0; i < 5; i++) { // Settings, Play, request bar, tip close, owner sign-in: the five stops before focus wraps
      await tabOrder.keyboard.press("Tab");
      stops.push(await tabOrder.evaluate(() => { const e = document.activeElement; const r = e.getBoundingClientRect(); return { name: (e.getAttribute("aria-label") || e.textContent || e.className || e.tagName).trim().slice(0, 22), y: Math.round(r.top + window.scrollY) }; }));
    }
    const names = stops.map((s) => `${s.name}@${s.y}`).join(" > ");
    check(stops.every((s, i) => i === 0 || s.y >= stops[i - 1].y - 2), `phone ${look}: Tab follows top-to-bottom order (${names})`);
    check(/^settings$/i.test(stops[0].name), `phone ${look}: the first Tab stop is the Settings button`);
    check(stops.findIndex((s) => /^play/i.test(s.name)) < stops.findIndex((s) => /request a song/i.test(s.name)), `phone ${look}: Play comes before the request bar (it is on the first screen, #52)`);
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
      // With the menu closed the header is the Settings button (its own row on a phone): well inside the old two-row (short landscape) and three-row (tall phone) limits.
      check(head.height <= (h > 500 ? 180 : 150), `owner ${look} @${w}x${h} header is at most ${h > 500 ? "three" : "two"} rows (${Math.round(head.height)}px)`);
      check(head.height <= (w <= 480 ? 130 : 100), `owner ${look} @${w}x${h} header with the menu closed is ${w <= 480 ? "two rows" : "one row"} (${Math.round(head.height)}px)`);
      check(pl.y + pl.height <= h + 1, `owner ${look} @${w}x${h} player is on the first screen (bottom ${Math.round(pl.y + pl.height)} of ${h})`);
    }
  }
  // Before Play (#52): on a fresh load the whole Play button is on the first screen, in every look x layout, listener and owner.
  // Landscape phones (568x320, 667x375) are a known exception and are not asserted. The tip is on (fresh storage), the worst case.
  const readOrder = [".player-stage", ".play", ".titles", ".up-next", ".player-host"]; // the stage (frame included) leads the reading order; the host is the video area
  for (const who of ["listener", "owner"]) for (const layout of ["side", "stacked"]) for (const look of ["afterglow", "theset"]) {
    for (const [w, h] of [[1280, 800], [1366, 768], [1440, 900], [375, 812], [375, 667], [320, 568]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      if (who === "owner") await ctx.addCookies([{ name: "ttunes_session", value: ownerToken, url: BASE, httpOnly: true }]);
      await ctx.addInitScript(([l, k]) => { localStorage.setItem("ttunes.look", l); localStorage.setItem("ttunes.layout", k); }, [look, layout]);
      const p = await ctx.newPage();
      await p.goto(BASE);
      await p.getByTestId("now-title").waitFor();
      await p.waitForTimeout(400);
      const g = await p.evaluate((sels) => {
        const box = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y + scrollY, w: r.width, h: r.height }; };
        const host = document.querySelector(".player-host").getBoundingClientRect();
        const top = document.elementFromPoint(host.x + host.width / 2, host.y + host.height / 2);
        return { boxes: sels.map(box), uncovered: document.querySelector(".player-host").contains(top), noH: document.documentElement.scrollWidth <= innerWidth };
      }, readOrder);
      const play = g.boxes[1];
      const player = g.boxes[4];
      const ordered = g.boxes.slice(0, 4);
      const label = `${who} ${layout} ${look} @${w}x${h}`;
      if (process.env.SHOTS_DIR && who === "listener" && (w === 1280 || w === 320)) await p.screenshot({ path: `${process.env.SHOTS_DIR}preplay-${layout}-${look}-${w}x${h}.png` });
      check(play.y >= 0 && play.y + play.h <= h, `${label}: Play fully on the first screen (y ${Math.round(play.y)}-${Math.round(play.y + play.h)} of ${h})`);
      check(player.h >= 199.5 && (Math.abs(player.w / player.h - 16 / 9) < 0.03 || player.h <= 200.5) && g.uncovered && g.noH, `${label}: player ${Math.round(player.w)}x${Math.round(player.h)} 16:9 / >= 200px, uncovered, no horizontal scroll`);
      const inOrder = ordered.every((b, i) => i === 0 || b.y > ordered[i - 1].y + 2 || (Math.abs(b.y - ordered[i - 1].y) <= 2 && b.x > ordered[i - 1].x));
      check(inOrder, `${label}: player, Play, title, up next read in DOM order (${ordered.map((b) => `${Math.round(b.x)},${Math.round(b.y)}`).join(" > ")})`);
      await ctx.close();
    }
  }
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
  await db.end();
}
