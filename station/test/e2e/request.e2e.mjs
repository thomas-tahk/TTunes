// Done check for the request box + feed: two listener browsers, YouTube stubbed server-side, search stubbed in the browser.
// Run from station/ with a FRESH local database:
//   docker compose exec -T db createdb -U ttunes <name>
//   DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<name> node test/e2e/request.e2e.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import pg from "pg";
import { openDrawer, playerClearOfDrawer } from "./drawer.mjs";
import { freePort, startDevServer } from "./devServer.mjs";
import { chromium } from "playwright";

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const SHOTS = new URL("./screens/", import.meta.url).pathname;
const DB_URL = process.env.DATABASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) throw new Error(`E2E FAIL: ${msg}`); console.log(`ok  ${msg}`); };

if (!DB_URL || !/^postgres:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(DB_URL) || /ttunes_station$/.test(DB_URL)) {
  throw new Error("set DATABASE_URL to a fresh local database (not the shared ttunes_station)");
}

const catalog = {
  musicVid001: { title: "Neon Skyline (Official Audio)", duration: "PT3M42S", category: "10" },
  musicVid002: { title: "Midnight Drive (Official Audio)", duration: "PT3M10S", category: "10" },
  musicVid003: { title: "Sunrise Drive (Official Audio)", duration: "PT3M5S", category: "10" },
};
const youtubeStub = createServer((req, res) => {
  const ids = (new URL(req.url, "http://x").searchParams.get("id") ?? "").split(",");
  const items = ids.filter((id) => catalog[id]).map((id) => ({
    id,
    snippet: { title: catalog[id].title, categoryId: catalog[id].category },
    contentDetails: { duration: catalog[id].duration },
    status: { embeddable: true },
  }));
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ items }));
});
await new Promise((r) => youtubeStub.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${youtubeStub.address().port}/youtube/v3`;

const env = { ...process.env, DATABASE_URL: DB_URL, SESSION_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123", YOUTUBE_API_KEY: "stub", YOUTUBE_API_BASE_URL: stubUrl };
const run = (cmd) => new Promise((ok, bad) => spawn("npm", ["run", cmd], { env, stdio: "ignore" }).on("exit", (c) => (c === 0 ? ok() : bad(new Error(`${cmd} failed`)))));
await run("db:migrate");
const db = new pg.Pool({ connectionString: DB_URL });
await db.query("truncate queue, station_state, play_history, activity_log, songs, requests, request_attempts cascade");
await db.query("update settings set value = 'open' where key = 'request_mode'");
await db.query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Seed Song One',300),('seedSong002','Seed Song Two',300)");

const server = await startDevServer(PORT, env);

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const DEDICATION = "For Mom, happy birthday! <b>not bold</b>";
const TYPED_DEDICATION = "For Mom,\nhappy birthday! <b>not bold</b>"; // Enter in the box becomes a space
const browser = await chromium.launch();
const errors = [];
const open = async (viewport, ip) => {
  const context = await browser.newContext({ viewport, extraHTTPHeaders: ip ? { "x-forwarded-for": ip } : {} });
  await context.route("https://i.ytimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(BASE);
  await page.getByTestId("next-title").waitFor();
  await openDrawer(page);
  return page;
};
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const playerClear = async (page, label) => {
  const { frame, ok } = await playerClearOfDrawer(page);
  check(ok, `${label}: player ${frame.width}x${frame.height} >= 200x200 and the drawer covers none of it`);
  check(await noScroll(page), `${label}: no horizontal scroll`);
};
const shot = async (page, name) => {
  for (const [tag, w, h] of [["desktop-1280", 1280, 900], ["phone-375", 375, 812]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(300);
    await page.screenshot({ path: `${SHOTS}request-${name}-${tag}.png`, fullPage: true });
    console.log(`screenshot ${SHOTS}request-${name}-${tag}.png`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
};

try {
  mkdirSync(SHOTS, { recursive: true });
  const a = await open({ width: 1280, height: 900 });
  const b = await open({ width: 1280, height: 900 }, "203.0.113.9"); // another network, like a second listener

  // Empty feed + open chip.
  await a.getByText("No requests yet. Be the first.").waitFor();
  check((await a.getByTestId("mode-chip").textContent()) === "Open", "mode chip says Open");
  await shot(a, "empty");

  // Counter, name memory, post by link.
  await a.getByLabel("Your name").fill("Thomas");
  await a.getByLabel("Dedication (optional)").fill(TYPED_DEDICATION);
  check((await a.getByTestId("counter").textContent()) === `${TYPED_DEDICATION.length}/140`, "dedication counter is live");
  check((await a.getByRole("button", { name: "Send request" }).count()) === 0, "no Send request until a song is looked up");
  check(await a.getByRole("button", { name: "Look up" }).isDisabled(), "Look up is disabled with an empty link");
  await a.getByLabel("Song link").fill("https://youtu.be/musicVid001");
  await a.getByRole("button", { name: "Look up" }).click();
  await a.getByTestId("preview").waitFor();
  check((await a.getByTestId("preview").locator(".song-card-head strong").textContent()) === catalog.musicVid001.title, "pasted link expands the same card with the title");
  check((await a.getByTestId("song-length").textContent()).includes("3:42"), "listener's link card shows the length");
  check(await a.getByRole("button", { name: "Send request" }).evaluate((el) => el === document.activeElement), "focus moved to Send request in the link card");
  await shot(a, "filled");
  // The feed is CDN-cached: freeze it at "empty" and the poster must still see their own row.
  await a.route("**/api/requests/feed", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: "open", requests: [] }) }));
  await a.getByRole("button", { name: "Send request" }).click();
  await a.getByTestId("mine").waitFor();
  await a.getByTestId("feed-row").first().waitFor();
  check(await a.getByTestId("feed-row").count() === 1, "frozen (stale) feed: the poster still sees their own row");
  check(await a.evaluate(() => document.activeElement?.getAttribute("data-testid")) === "mine", "focus moved to the notice after sending");
  await a.unroute("**/api/requests/feed");
  check((await a.getByTestId("mine").textContent()).includes("queued"), "A sees its request as queued");
  check((await a.getByLabel("Your name").count()) === 0, "box shows one-at-a-time notice instead of the form");
  const row = a.getByTestId("feed-row").first();
  check((await row.textContent()).includes(DEDICATION), "A's feed row shows the dedication as plain text");
  check((await row.locator("b").count()) === 0, "HTML in the dedication was not rendered");
  check((await row.textContent()).includes("Coming up"), "feed chip says Coming up");
  await shot(a, "posted");
  check(await a.evaluate(() => localStorage.getItem("ttunes_listener_name")) === "Thomas", "name remembered in localStorage");

  // B joins fresh: sees it in the feed, can still request (its own slot).
  await b.reload();
  await openDrawer(b);
  await b.getByTestId("feed-row").first().waitFor();
  const bText = await b.getByTestId("feed-row").first().textContent();
  check(bText.includes("Thomas") && bText.includes("Neon Skyline") && bText.includes(DEDICATION), "B sees name, title and dedication in the feed");
  check((await b.getByLabel("Your name").count()) === 1, "B still has its own request box");
  check((await b.getByTestId("next-title").textContent()) === catalog.musicVid001.title, "B sees the request as Up next");

  // Song ends: the request becomes now playing for both.
  await db.query("update station_state set started_at_ms = started_at_ms - 400000");
  await b.reload();
  await openDrawer(b);
  await b.waitForFunction((t) => document.querySelector('[data-testid="now-title"]')?.textContent === t, catalog.musicVid001.title);
  check(true, "B hears the request: it is now playing");
  check((await b.getByTestId("feed-row").first().textContent()).includes("Playing now"), "feed chip says Playing now");
  await a.reload();
  await openDrawer(a);
  await a.waitForFunction((t) => document.querySelector('[data-testid="now-title"]')?.textContent === t, catalog.musicVid001.title);
  check(true, "A hears its own request playing too");
  await playerClear(b, "desktop");
  await b.setViewportSize({ width: 375, height: 812 });
  await playerClear(b, "phone");
  await shot(b, "playing");

  // Search path (listener search is stubbed in the browser; it is built in a parallel task).
  await b.route("**/api/requests/search?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [{ videoId: "musicVid001", title: "Neon Skyline (Official Audio)", channelTitle: "Neon", durationSec: 222, thumbnail: "https://i.ytimg.com/vi/musicVid001/hqdefault.jpg" }] }) }));
  await b.setViewportSize({ width: 1280, height: 900 });
  check((await b.getByLabel("Your name").inputValue()) === "", "B has no remembered name (separate browser)");
  await b.getByRole("button", { name: "Search by name" }).click();
  await b.getByLabel("Song or artist to find").fill("neon");
  await b.getByRole("button", { name: "Find", exact: true }).click();
  await b.getByTestId("search-results").waitFor();
  check((await b.getByRole("button", { name: "Send request" }).count()) === 0, "no Send request until a result is opened");
  const head = b.getByRole("button", { name: /Neon Skyline/ });
  check((await head.getAttribute("aria-expanded")) === "false", "result starts collapsed");
  await head.focus();
  await b.keyboard.press("Enter");
  check((await head.getAttribute("aria-expanded")) === "true", "Enter expands the result in place");
  check((await b.getByTestId("song-length").textContent()).includes("3:42"), "expanded card shows the length");
  check(await b.getByRole("button", { name: "Send request" }).evaluate((el) => el === document.activeElement), "focus moved to Send request");
  await shot(b, "search");
  // No name yet: the error shows inside the open card, in view at 375px, and focus does not fall to the page body.
  await b.setViewportSize({ width: 375, height: 812 });
  await sleep(300);
  await b.getByRole("button", { name: "Send request" }).click();
  const nameError = b.getByRole("alert").filter({ hasText: "Type your name first" });
  await nameError.waitFor();
  await sleep(200);
  check(await nameError.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }), "375px: the missing-name error is inside the viewport, in the card");
  check(await b.evaluate(() => document.activeElement?.tagName !== "BODY"), "focus stays on a control after the error");
  await b.setViewportSize({ width: 1280, height: 900 });

  // Refusal text from the server is shown (already coming up / playing).
  await b.getByLabel("Your name").fill("Bea");
  await b.getByRole("button", { name: "Send request" }).click();
  await b.getByRole("alert").filter({ hasText: /./ }).first().waitFor();
  check(await b.getByRole("button", { name: "Send request" }).evaluate((el) => el === document.activeElement), "after a refusal focus is still on the Send request button, next to the message in the card");
  check((await b.getByRole("alert").first().textContent()).length > 5, "server refusal text is shown, not swallowed");
  await shot(b, "refused");

  // Third listener: search, tap a result, Send request from the expanded card -> it shows in the feed.
  const dana = await open({ width: 1280, height: 900 }, "203.0.113.88");
  const neonTwo = { videoId: "musicVid003", title: "Sunrise Drive (Official Audio)", channelTitle: "Night", durationSec: 190, thumbnail: "https://i.ytimg.com/vi/musicVid003/hqdefault.jpg" };
  await dana.route("**/api/requests/search?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [neonTwo, { ...neonTwo, videoId: "musicVid001", title: "Other Result" }] }) }));
  await dana.getByLabel("Your name").fill("Dana");
  await dana.getByRole("button", { name: "Search by name" }).click();
  await dana.getByLabel("Song or artist to find").fill("sunrise");
  await dana.getByRole("button", { name: "Find", exact: true }).click();
  await dana.getByTestId("search-results").waitFor();
  await dana.getByRole("button", { name: /Other Result/ }).click();
  await dana.getByRole("button", { name: /Sunrise Drive/ }).click();
  check((await dana.getByTestId("song-card").locator(".song-card-body").count()) === 1, "only one card is open at a time");
  await shot(dana, "card");
  await dana.getByRole("button", { name: "Send request" }).click();
  await dana.getByTestId("mine").waitFor();
  await dana.getByTestId("feed-row").filter({ hasText: "Sunrise Drive" }).first().waitFor();
  check(true, "listener's Send request from the card shows in the feed");

  // Full list: 30 rows must keep their height and the list must scroll, not squash.
  await db.query(`insert into requests (video_id, title, duration_sec, name, dedication, status, listener_id)
    select 'seedFill' || g, 'A fairly long song title number ' || g || ' by somebody', 200, 'Listener ' || g, 'Dedication ' || g || ' with some words so it wraps onto more lines on a phone', 'played', 'fill' || g
    from generate_series(1, 30) g`);
  for (const [w, h] of [[375, 812], [1280, 900]]) {
    await b.setViewportSize({ width: w, height: h });
    await b.reload();
    await openDrawer(b);
    await b.getByTestId("feed-row").first().waitFor();
    const m = await b.evaluate(() => {
      const list = document.querySelector('[data-testid="feed"]');
      const rows = [...list.querySelectorAll('[data-testid="feed-row"]')];
      const overlap = rows.some((r) => { const c = r.querySelector(".chip").getBoundingClientRect(), d = r.querySelector(".feed-dedication")?.getBoundingClientRect(); return d && c.top < d.bottom && c.bottom > d.top && c.left < d.right && c.right > d.left; });
      return { n: rows.length, min: Math.min(...rows.map((r) => r.getBoundingClientRect().height)), scrolls: list.scrollHeight > list.clientHeight + 10, overlap };
    });
    check(m.n === 30 && m.min > 40, `${w}px: 30 rows, shortest is ${Math.round(m.min)}px (> 40)`);
    check(m.scrolls, `${w}px: full feed scrolls inside its box`);
    check(!m.overlap, `${w}px: status chip does not overlap the dedication`);
    await shot(b, `full-${w}`);
  }
  await b.setViewportSize({ width: 1280, height: 900 });

  // Approve mode + frozen feed: a denied request is hidden from the feed, so our own row must not stay behind.
  await db.query("update settings set value = 'approve' where key = 'request_mode'");
  const c = await open({ width: 1280, height: 900 }, "203.0.113.77");
  await c.route("**/api/requests/feed", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: "approve", requests: [] }) }));
  await c.reload();
  await openDrawer(c);
  await c.getByTestId("mode-chip").waitFor();
  check((await c.locator(".request-box .hint").textContent()).includes("Every request waits for approval."), "approve mode hint says every request waits");
  await c.getByLabel("Your name").fill("Cleo");
  await c.getByLabel("Dedication (optional)").fill("line one\t\tline two");
  await c.getByLabel("Song link").fill("https://youtu.be/musicVid002");
  await c.getByRole("button", { name: "Look up" }).click();
  await c.getByTestId("preview").waitFor();
  await c.getByRole("button", { name: "Send request" }).click();
  await c.getByTestId("mine").waitFor();
  await c.getByTestId("feed-row").first().waitFor();
  check((await c.getByTestId("feed-row").first().textContent()).includes("Waiting for approval"), "C sees its own waiting row on a frozen feed");
  const { rows: [cleo] } = await db.query("select dedication from requests where name = 'Cleo'");
  check(cleo.dedication === "line one line two", "tabs in the dedication collapse to one space");
  await db.query("update requests set status = 'denied' where name = 'Cleo'");
  await c.getByLabel("Your name").waitFor({ timeout: 45000 }); // the 30s re-check re-reads mine
  check((await c.getByTestId("feed-row").count()) === 0, "denied request: the stale row is gone and the form is back");
  await c.close();

  // Mode off hides the box.
  await db.query("update settings set value = 'off' where key = 'request_mode'");
  await b.reload();
  await openDrawer(b);
  await b.getByTestId("mode-chip").waitFor();
  check((await b.getByTestId("mode-chip").textContent()) === "Requests off", "mode chip says Requests off");
  check((await b.getByRole("heading", { name: "Request a song" }).count()) === 0, "request box is hidden when off");
  await shot(b, "off");

  // Feed load failure is an error, not "nothing here".
  await b.route("**/api/requests/feed", (route) => route.fulfill({ status: 500, body: "{}" }));
  await b.reload();
  await openDrawer(b);
  await b.getByRole("alert").filter({ hasText: "didn't load" }).waitFor();
  check(true, "feed failure shows an error with Try again");

  const real = errors.filter((e) => !/favicon|youtube|googlevideo|google|ERR_BLOCKED|Failed to load resource|compute-pressure|Permissions policy/i.test(e));
  check(real.length === 0, `no app console errors ${real.join(" | ")}`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
  youtubeStub.close();
  await db.end();
}
