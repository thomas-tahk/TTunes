// Done check for the second look, "The Set", and the header switch between it and Afterglow.
// Run from station/ with a FRESH local database:
//   docker compose exec -T db createdb -U ttunes <name>
//   DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<name> node test/e2e/theset.e2e.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { SignJWT } from "jose";
import pg from "pg";
import { chromium } from "playwright";
import { freePort, startDevServer } from "./devServer.mjs";
import { openDrawer, playerClearOfDrawer, playerInViewport } from "./drawer.mjs";

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const SHOTS = new URL("./screens/", import.meta.url).pathname;
const SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
const DB_URL = process.env.DATABASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) throw new Error(`E2E FAIL: ${msg}`); console.log(`ok  ${msg}`); };
if (!DB_URL || !/^postgres:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(DB_URL) || /ttunes_station$/.test(DB_URL)) {
  throw new Error("set DATABASE_URL to a fresh local database (not the shared ttunes_station)");
}

// Local stand-in for the YouTube Data API: the test never calls the real one.
const catalog = { searchVid01: { title: "Searched Sunrise", duration: "PT2M30S", category: "10" }, searchVid02: { title: "September", duration: "PT3M35S", category: "10" } };
const youtubeStub = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  const url = new URL(req.url, "http://x");
  if (url.pathname.endsWith("/search")) return res.end(JSON.stringify({ items: Object.keys(catalog).map((id) => ({ id: { videoId: id }, snippet: { thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } } } })) }));
  const ids = url.searchParams.get("id").split(",").filter((id) => catalog[id]);
  res.end(JSON.stringify({ items: ids.map((id) => ({ id, snippet: { title: catalog[id].title, categoryId: catalog[id].category }, contentDetails: { duration: catalog[id].duration }, status: { embeddable: true } })) }));
});
await new Promise((r) => youtubeStub.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${youtubeStub.address().port}/youtube/v3`;

const env = { ...process.env, DATABASE_URL: DB_URL, SESSION_SECRET: SECRET, YOUTUBE_API_KEY: "stub", YOUTUBE_API_BASE_URL: stubUrl };
const run = (cmd) => new Promise((ok, bad) => spawn("npm", ["run", cmd], { env, stdio: "ignore" }).on("exit", (c) => (c === 0 ? ok() : bad(new Error(`${cmd} failed`)))));
await run("db:migrate");
const db = new pg.Pool({ connectionString: DB_URL });
await db.query("truncate queue, station_state, play_history, activity_log, songs, requests, request_attempts cascade");
await db.query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Strawberry Letter 23',300),('seedSong002','Ain''t No Mountain High Enough',300),('seedSong003','Golden Hour',200)");
await db.query(`insert into requests (video_id, title, duration_sec, name, dedication, status, listener_id, queued_at) values
  ('seedSong003','Golden Hour',200,'3rd floor','for whoever fixed the coffee machine','queued','l1',now()),
  ('seedSong002','Ain''t No Mountain High Enough',300,'night shift','to stay awake till 6','waiting','l2',null)`);
const server = await startDevServer(PORT, env);
const { rows: [{ session_version: ver }] } = await db.query("select session_version from auth_state where id = 1");
const token = await new SignJWT({ ver }).setProtectedHeader({ alg: "HS256" }).setSubject("10647431").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));

const browser = await chromium.launch();
const errors = [];
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function open({ viewport, owner = false, init }) {
  const context = await browser.newContext({ viewport });
  if (owner) await context.addCookies([{ name: "ttunes_session", value: token, url: BASE, httpOnly: true }]);
  await context.route("https://i.ytimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return page;
}
const look = (page) => page.evaluate(() => document.documentElement.dataset.look);
const saved = (page) => page.evaluate(() => localStorage.getItem("ttunes.look"));
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const shot = async (page, name, w, h, fullPage = false) => {
  await page.setViewportSize({ width: w, height: h });
  await sleep(500);
  await page.screenshot({ path: `${SHOTS}theset-${name}.png`, fullPage });
  console.log(`screenshot ${SHOTS}theset-${name}.png`);
};
const luminance = ([r, g, b]) => [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const rgb = (css) => css.match(/[\d.]+/g).slice(0, 3).map(Number);

try {
  mkdirSync(SHOTS, { recursive: true });

  // 1. Default is Afterglow; the switch is in the header with a clear label.
  const page = await open({ viewport: { width: 1280, height: 800 }, init: () => {
    new MutationObserver(() => { (window.__looks ??= []).push(document.documentElement.dataset.look); }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-look"] });
  } });
  await page.goto(BASE);
  await page.getByTestId("now-title").waitFor();
  check((await look(page)) === "afterglow", "default look is Afterglow");
  check((await saved(page)) === null, "nothing is saved until the visitor chooses");
  const group = page.getByRole("group", { name: "Look" });
  check((await page.locator("header").getByRole("group", { name: "Look" }).count()) === 1, "the Look switch is a labelled group in the header");
  check((await group.getByRole("radio").count()) === 2 && await group.getByRole("radio", { name: "Afterglow" }).isChecked(), "two radios, Afterglow checked");
  const wordmarkFont = () => page.locator(".wordmark").evaluate((el) => getComputedStyle(el).fontFamily);
  check(/Anton/.test(await wordmarkFont()), "Afterglow styles apply (Anton wordmark)");

  // 2. Switch to The Set; persists across reload, applied before first paint.
  await group.getByRole("radio", { name: "The Set" }).check();
  check((await look(page)) === "theset" && (await saved(page)) === "theset", "choosing The Set applies it and saves it");
  check(/Bungee/.test(await wordmarkFont()) && !/Anton/.test(await wordmarkFont()), "only The Set styles apply (Bungee Shade wordmark)");
  await page.reload();
  await page.getByTestId("now-title").waitFor();
  check((await look(page)) === "theset", "reload: still The Set");
  check((await page.evaluate(() => window.__looks[0])) === "theset", "the saved look is on <html> before the app starts (no flash)");
  check(await page.getByRole("radio", { name: "The Set" }).isChecked(), "reload: the switch shows The Set");

  // 3. The Set looks (screenshots), contrast, and the player rules.
  await sleep(400);
  const dismissTip = page.getByRole("button", { name: "Close tip" });
  await shot(page, "listener-1280", 1280, 800);
  await shot(page, "listener-375", 375, 812, true);
  check(await noScroll(page), "The Set listener: no horizontal scroll at 375px");
  await page.setViewportSize({ width: 1280, height: 800 });
  const pairs = await page.evaluate(() => {
    const solid = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\(.*, 0\)|transparent/.test(c)) return c; } return "rgb(255,255,255)"; };
    const pick = [[".wordmark"], [".on-air"], [".titles .label"], ["h1"], [".look-switch legend"], [".look-switch label.on"], [".look-switch label:not(.on)"], [".signin"], [".request-line", "rgb(255, 201, 77)"], [".up-next b", "rgb(255, 201, 77)"], [".up-next .label", "rgb(255, 201, 77)"], [".play"]];
    return pick.map(([sel, bg]) => { const el = document.querySelector(sel); const cs = getComputedStyle(el); return { sel, fg: cs.color, bg: bg ?? (sel === ".play" ? "rgb(255, 201, 77)" : sel === ".look-switch legend" || sel === ".signin" || sel === ".wordmark" ? getComputedStyle(document.querySelector(".shell")).backgroundColor : solid(el)) }; });
  });
  for (const { sel, fg, bg } of pairs) { const r = ratio(rgb(fg), rgb(bg)); check(r >= 4.5, `contrast ${sel} ${r.toFixed(1)}:1 >= 4.5`); }

  // 4. Player + overlap + no-scroll on every width, both states of the drawer.
  const fixedOverlap = () => page.evaluate(async () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    let bad = null;
    for (let y = 0; y <= max; y += 8) {
      window.scrollTo(0, y);
      const host = document.querySelector(".player-host").getBoundingClientRect();
      for (const el of document.querySelectorAll(".drawer-tab, .hint-bubble, .drawer")) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && getComputedStyle(el).position === "fixed" && r.left < host.right && host.left < r.right && r.top < host.bottom && host.top < r.bottom) bad = bad ?? `${el.className} at scroll ${y}`;
      }
    }
    window.scrollTo(0, 0);
    return bad;
  });
  for (const [w, h] of [[320, 700], [375, 812], [600, 800], [768, 1024], [999, 800], [1000, 800], [1100, 800], [1280, 800], [1920, 1080], [667, 375], [900, 720], [1280, 600]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(250);
    const host = await page.locator(".player-host").boundingBox();
    const wide = host.width >= 356;
    check(host.height >= 200 && (!wide || Math.abs(host.width / host.height - 16 / 9) < 0.03), `@${w}x${h}: player ${Math.round(host.width)}x${Math.round(host.height)} is >= 200 tall${wide ? " and 16:9" : " (200px minimum wins)"}`);
    check(host.x >= -0.5 && host.x + host.width <= w + 0.5, `@${w}x${h}: player fully inside the viewport width`);
    if (w <= 1280) check(await noScroll(page), `@${w}x${h}: no horizontal scroll`);
  }
  for (const [w, h] of [[900, 720], [667, 375], [375, 812], [320, 640], [1100, 700], [1280, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const openIt of [false, true]) {
      const tab = page.locator(".drawer-tab");
      if (((await tab.getAttribute("aria-expanded")) === "true") !== openIt) await tab.click();
      await sleep(400);
      const bad = await fixedOverlap();
      check(bad === null, `@${w}x${h} drawer ${openIt ? "open" : "closed"}: nothing fixed overlaps the player at any scroll (8px steps)${bad ? " " + bad : ""}`);
      if (openIt) check((await playerClearOfDrawer(page)).ok, `@${w}x${h} drawer open: player >= 200 tall and clear of the drawer`);
      if (w <= 1280) check(await noScroll(page), `@${w}x${h} drawer ${openIt ? "open" : "closed"}: no horizontal scroll`);
    }
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Request a song", exact: true }).click();
  await page.getByRole("heading", { name: "Queue & requests" }).waitFor();
  await page.getByTestId("feed-row").first().waitFor();
  check((await page.getByTestId("feed-row").count()) === 2, "both request slips render in the drawer");
  await shot(page, "listener-drawer-1280", 1280, 800);
  await shot(page, "listener-drawer-375", 375, 812, true);
  await page.keyboard.press("Escape");

  // 5. Storage blocked: falls back to Afterglow without errors, and the switch still works for the visit.
  const blocked = await open({ viewport: { width: 1280, height: 800 }, init: () => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
  } });
  await blocked.goto(BASE);
  await blocked.getByTestId("now-title").waitFor();
  check((await look(blocked)) === "afterglow", "storage throws: default Afterglow");
  await blocked.getByRole("radio", { name: "The Set" }).check();
  check((await look(blocked)) === "theset", "storage throws: switching still works for this visit");

  // 6. Owner in The Set: drawer, expand a search card, Play next.
  const owner = await open({ viewport: { width: 1280, height: 800 }, owner: true, init: () => { if (localStorage.getItem("ttunes.look") === null) localStorage.setItem("ttunes.look", "theset"); } });
  await owner.goto(BASE);
  await owner.getByTestId("now-title").waitFor();
  check((await look(owner)) === "theset" && (await owner.getByRole("group", { name: "Look" }).count()) === 1, "owner sees the Look switch, in The Set");
  await openDrawer(owner, "Add song");
  await owner.getByRole("heading", { name: "Add song" }).waitFor();
  await owner.getByLabel("Search YouTube").fill("sunrise");
  await owner.getByRole("button", { name: "Search", exact: true }).click();
  const sunrise = owner.getByRole("button", { name: /^Searched Sunrise/ });
  await sunrise.waitFor();
  await sunrise.click();
  await owner.getByRole("button", { name: "Play next" }).waitFor();
  check((await sunrise.getAttribute("aria-expanded")) === "true", "owner: search card expands in place");
  check((await playerClearOfDrawer(owner)).ok, "owner drawer + open card @1280: player clear");
  await shot(owner, "owner-1280", 1280, 900);
  await shot(owner, "owner-375", 375, 812, true);
  check(await noScroll(owner), "owner card open @375: no horizontal scroll");
  await owner.setViewportSize({ width: 1280, height: 900 });
  await owner.getByRole("button", { name: "Play next" }).click();
  await owner.waitForFunction(() => document.querySelector('[data-testid="next-title"]').textContent === "Searched Sunrise");
  check(true, "owner: Play next in The Set shows the song as Up next");
  for (const tab of ["Requests", "Owner tools"]) {
    await openDrawer(owner, tab);
    check((await playerClearOfDrawer(owner)).ok && await noScroll(owner), `owner "${tab}" tab: player clear, no horizontal scroll`);
  }

  // 7. Switch back: Afterglow, saved, survives reload.
  await owner.getByRole("radio", { name: "Afterglow" }).check();
  check((await look(owner)) === "afterglow" && (await saved(owner)) === "afterglow", "switching back applies and saves Afterglow");
  await owner.reload();
  await owner.getByTestId("now-title").waitFor();
  check((await look(owner)) === "afterglow" && await owner.getByRole("radio", { name: "Afterglow" }).isChecked(), "reload: still Afterglow");
  check(/Anton/.test(await owner.locator(".wordmark").evaluate((el) => getComputedStyle(el).fontFamily)), "Afterglow styles back in force");
  const switchSize = await owner.locator(".look-switch label").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  check(switchSize.every((h) => h >= 44), "Afterglow: switch targets >= 44px tall");

  const real = errors.filter((e) => !/favicon|youtube|googlevideo|google|ERR_BLOCKED|Failed to load resource|compute-pressure|Permissions policy|blocked/i.test(e));
  check(real.length === 0, `no app console errors ${real.join(" | ")}`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
  youtubeStub.close();
  await db.end();
}
