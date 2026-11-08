// Done check for the Layout switch (Side / Stacked): 2 looks x 2 layouts x 3 screens, the switch itself, and the request + Play next flows in Stacked.
// Run from station/ with a FRESH local database:
//   docker compose exec -T db createdb -U ttunes <name>
//   DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<name> node test/e2e/stacked.e2e.mjs
// Optional: SHOTS_DIR=<dir> writes full-page screenshots of Stacked in both looks at 1280 and 375.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { SignJWT } from "jose";
import pg from "pg";
import { chromium } from "playwright";
import { freePort, startDevServer } from "./devServer.mjs";

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const DB_URL = process.env.DATABASE_URL;
const SHOTS = process.env.SHOTS_DIR;
const check = (ok, msg) => { if (!ok) throw new Error(`E2E FAIL: ${msg}`); console.log(`ok  ${msg}`); };
if (!DB_URL || !/^postgres:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(DB_URL) || /ttunes_station$/.test(DB_URL)) {
  throw new Error("set DATABASE_URL to a fresh local database (not the shared ttunes_station)");
}

// YouTube Data API is stubbed server-side: the test never calls the real one.
const catalog = {
  musicVid001: { title: "Neon Skyline (Official Audio)", duration: "PT3M42S" },
  musicVid002: { title: "Midnight Drive (Official Audio)", duration: "PT3M10S" },
};
const youtubeStub = createServer((req, res) => {
  const ids = (new URL(req.url, "http://x").searchParams.get("id") ?? "").split(",");
  const items = ids.filter((id) => catalog[id]).map((id) => ({ id, snippet: { title: catalog[id].title, categoryId: "10" }, contentDetails: { duration: catalog[id].duration }, status: { embeddable: true } }));
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ items }));
});
await new Promise((r) => youtubeStub.listen(0, "127.0.0.1", r));
const env = { ...process.env, DATABASE_URL: DB_URL, SESSION_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123", YOUTUBE_API_KEY: "stub", YOUTUBE_API_BASE_URL: `http://127.0.0.1:${youtubeStub.address().port}/youtube/v3` };
await new Promise((ok, bad) => spawn("npm", ["run", "db:migrate"], { env, stdio: "ignore" }).on("exit", (c) => (c === 0 ? ok() : bad(new Error("migrate failed")))));
const db = new pg.Pool({ connectionString: DB_URL });
await db.query("truncate queue, station_state, play_history, activity_log, songs, requests, request_attempts cascade");
await db.query("update settings set value = 'open' where key = 'request_mode'");
await db.query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Sunrise',300),('seedSong002','Golden Hour',300)");
const server = await startDevServer(PORT, env);
const browser = await chromium.launch();
const { rows: [{ session_version: ver }] } = await db.query("select session_version from auth_state where id = 1");
const ownerToken = await new SignJWT({ ver }).setProtectedHeader({ alg: "HS256" }).setSubject("10647431").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(env.SESSION_SECRET));
const errors = [];
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const openPage = async (viewport, { owner = false, saved = {}, ip } = {}) => {
  const context = await browser.newContext({ viewport, extraHTTPHeaders: ip ? { "x-forwarded-for": ip } : {} });
  if (owner) await context.addCookies([{ name: "ttunes_session", value: ownerToken, url: BASE, httpOnly: true }]);
  await context.route("https://i.ytimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(BASE);
  await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, { "ttunes.requestHintSeen": "0", ...saved });
  await page.reload();
  await page.getByTestId("now-title").waitFor();
  await page.waitForTimeout(300);
  return page;
};

const geometry = (page) => page.evaluate(() => {
  const box = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r && { x: r.x, y: r.y + scrollY, w: r.width, h: r.height }; };
  const host = document.querySelector(".player-host").getBoundingClientRect();
  const topEl = document.elementFromPoint(host.x + host.width / 2, host.y + host.height / 2);
  return {
    layout: document.documentElement.dataset.layout,
    player: box(".player-host"), titles: box(".titles"), upNext: box(".up-next"), drawer: box(".drawer"), hint: box(".hint-bubble"),
    playerFirstScreenBottom: host.bottom,
    playerUncovered: !!topEl && document.querySelector(".player-host").contains(topEl),
    noHScroll: document.documentElement.scrollWidth <= innerWidth,
    tabButton: !!document.querySelector(".drawer-tab"),
    drawerPosition: document.querySelector(".drawer") && getComputedStyle(document.querySelector(".drawer")).position,
    inOrder: ["now-title", "next-title"].every((id) => !!document.querySelector(`[data-testid="${id}"]`)) &&
      !!(document.querySelector(".player-stage").compareDocumentPosition(document.querySelector(".titles")) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      !!(document.querySelector(".titles").compareDocumentPosition(document.querySelector(".up-next")) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      !!(document.querySelector(".up-next").compareDocumentPosition(document.querySelector(".drawer")) & Node.DOCUMENT_POSITION_FOLLOWING),
  };
});

const rules = async (page, label, { w, h }) => {
  const g = await geometry(page);
  const p = g.player;
  check(p.h >= 199.5, `${label}: player ${Math.round(p.w)}x${Math.round(p.h)} is at least 200px tall`);
  check(Math.abs(p.w / p.h - 16 / 9) < 0.03 || p.h <= 200.5, `${label}: player is 16:9`);
  check(g.playerUncovered, `${label}: nothing covers the player`);
  check(g.noHScroll, `${label}: no horizontal scroll`);
  if (g.layout === "stacked") {
    check(!g.tabButton && g.drawerPosition === "static", `${label}: no fixed tab, request section is in page flow`);
    check(g.drawer.y >= g.upNext.y + g.upNext.h - 1 && g.titles.y >= p.y + p.h - 1 && g.upNext.y >= g.titles.y + g.titles.h - 1, `${label}: visual order is player, now playing, up next, requests`);
    check(g.inOrder, `${label}: DOM order matches the visual order`);
    if (g.hint) check(g.hint.y + g.hint.h <= g.drawer.y + 14 && g.drawer.y - (g.hint.y + g.hint.h) < 40, `${label}: tip sits right above the request box`);
  } else check(g.tabButton, `${label}: Side still has its request tab`);
  if (h <= 375) check(g.playerFirstScreenBottom <= h + 1, `${label}: player is on the first screen (bottom ${Math.round(g.playerFirstScreenBottom)} of ${h})`);
};

try {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  // The matrix: 2 looks x 2 layouts x 3 screens, set the way a returning visitor has them (saved before load).
  for (const look of ["afterglow", "theset"]) for (const layout of ["side", "stacked"]) for (const [w, h] of [[1280, 800], [375, 812], [667, 375]]) {
    const page = await openPage({ width: w, height: h }, { saved: { "ttunes.look": look, "ttunes.layout": layout } });
    await rules(page, `${look}/${layout} @${w}x${h}`, { w, h });
    if (SHOTS && layout === "stacked" && w !== 667) await page.screenshot({ path: `${SHOTS}stacked-${look}-${w}.png`, fullPage: true });
    await page.context().close();
  }
  // Small landscape, listener and owner, both layouts: the two switches must not push the player off the first screen.
  for (const owner of [false, true]) for (const layout of ["side", "stacked"]) for (const look of ["afterglow", "theset"]) for (const [w, h] of [[667, 375], [568, 320]]) {
    const page = await openPage({ width: w, height: h }, { owner, saved: { "ttunes.look": look, "ttunes.layout": layout } });
    const g = await geometry(page);
    check(g.playerFirstScreenBottom <= h + 1 && g.player.h >= 199.5, `${owner ? "owner" : "listener"} ${look}/${layout} @${w}x${h}: player on first screen (bottom ${Math.round(g.playerFirstScreenBottom)} of ${h}, ${Math.round(g.player.h)}px tall)`);
    check(g.noHScroll, `${owner ? "owner" : "listener"} ${look}/${layout} @${w}x${h}: no horizontal scroll`);
    await page.context().close();
  }

  // The switch: default, click, survives reload, unknown value, keyboard.
  const page = await openPage({ width: 1280, height: 800 });
  check((await page.evaluate(() => document.documentElement.dataset.layout)) === "side", "default layout is Side");
  await page.getByRole("radio", { name: "Stacked" }).check({ force: true });
  check((await geometry(page)).layout === "stacked", "choosing Stacked switches the page");
  check((await page.evaluate(() => localStorage.getItem("ttunes.layout"))) === "stacked", "choice saved in localStorage");
  await page.reload();
  await page.getByTestId("now-title").waitFor();
  check((await page.getByRole("radio", { name: "Stacked" }).isChecked()) && (await geometry(page)).layout === "stacked", "Stacked survives reload");
  check((await page.evaluate(() => document.querySelector(".layout-switch label.on")?.textContent)) === "Stacked", "checked state is visible (label marked on)");
  await page.getByRole("radio", { name: "Stacked" }).focus();
  await page.keyboard.press("ArrowLeft");
  check((await geometry(page)).layout === "side" && (await page.getByRole("radio", { name: "Side" }).isChecked()), "ArrowLeft moves to Side");
  await page.keyboard.press("ArrowRight");
  check((await geometry(page)).layout === "stacked", "ArrowRight moves back to Stacked");
  await page.getByRole("radio", { name: "The Set" }).focus();
  await page.keyboard.press("ArrowLeft");
  check((await page.evaluate(() => document.documentElement.dataset.look)) === "afterglow" && (await geometry(page)).layout === "stacked", "Look switch still works and leaves the layout alone");
  await page.getByRole("radio", { name: "Stacked" }).focus();
  const labelRing = await page.evaluate(() => { const l = document.querySelector(".layout-switch label:focus-within"); return !!l; });
  check(labelRing, "focused layout option shows its ring on the label");
  await page.evaluate(() => localStorage.setItem("ttunes.layout", "sideways"));
  await page.reload();
  await page.getByTestId("now-title").waitFor();
  check((await geometry(page)).layout === "side" && (await page.getByRole("radio", { name: "Side" }).isChecked()), "unknown saved layout falls back to Side");
  await page.context().close();

  // Tab order in Stacked on a phone: top to bottom.
  const phone = await openPage({ width: 375, height: 812 }, { saved: { "ttunes.layout": "stacked" } });
  const stops = [];
  for (let i = 0; i < 12; i++) {
    await phone.keyboard.press("Tab");
    stops.push(await phone.evaluate(() => { const e = document.activeElement; const r = e.getBoundingClientRect(); return { name: (e.getAttribute("aria-label") || e.getAttribute("id") || e.textContent || e.tagName).trim().slice(0, 20), y: Math.round(r.top + scrollY) }; }));
  }
  const firstWrap = stops.findIndex((s, i) => i > 0 && s.y < stops[i - 1].y - 2);
  const walked = firstWrap < 0 ? stops : stops.slice(0, firstWrap);
  check(walked.length >= 8, `phone Stacked: Tab walks top to bottom through ${walked.length} stops before wrapping (${walked.map((s) => `${s.name}@${s.y}`).join(" > ")})`);
  await phone.context().close();

  // Stacked listener: link -> Look up -> Send request, all in the page (no drawer to open).
  const listener = await openPage({ width: 375, height: 812 }, { saved: { "ttunes.layout": "stacked" }, ip: "203.0.113.20" });
  check(await listener.getByRole("region", { name: "Tip" }).isVisible(), "Stacked: the one-time tip is shown");
  await listener.getByLabel("Your name").fill("Thomas");
  await listener.getByLabel("Song link").fill("https://youtu.be/musicVid001");
  await listener.getByRole("button", { name: "Look up" }).click();
  await listener.getByTestId("preview").waitFor();
  await listener.getByRole("button", { name: "Send request" }).click();
  await listener.getByTestId("mine").waitFor();
  check((await listener.getByTestId("mine").textContent()).includes("queued"), "Stacked listener request is queued");
  await listener.getByTestId("feed-row").first().waitFor();
  await listener.waitForFunction((t) => document.querySelector('[data-testid="next-title"]')?.textContent === t, catalog.musicVid001.title);
  check(true, "the request is Up next");
  check((await listener.getByTestId("feed-row").first().textContent()).includes("Neon Skyline"), "the request shows in the feed in the page");
  await listener.context().close();

  // Stacked owner: all owner tools are in the page, and Play next works.
  const owner = await openPage({ width: 1280, height: 800 }, { owner: true, saved: { "ttunes.layout": "stacked" } });
  check((await owner.getByText("Owner", { exact: true }).waitFor(), await owner.getByRole("tablist", { name: "Drawer sections" }).count()) === 0, "Stacked owner: no tabs, every section is in the page");
  check((await owner.locator(".drawer").getByRole("heading", { name: "Add song" }).isVisible()), "Stacked owner: Add song is in the page");
  await owner.getByLabel("YouTube link").fill("https://youtu.be/musicVid002");
  await owner.locator(".owner-form").getByRole("button", { name: "Look up" }).click();
  await owner.getByTestId("preview").waitFor();
  await owner.getByTestId("preview").getByRole("button", { name: "Play next" }).click();
  await owner.locator(".owner-done").waitFor();
  check((await owner.locator(".owner-done").textContent()).includes(`Added "${catalog.musicVid002.title}" as up next`), "Stacked owner: Play next added the song as up next");
  check((await db.query("select count(*)::int n from songs where video_id = 'musicVid002'")).rows[0].n === 1, "the song is in the library");
  await owner.context().close();

  check(errors.length === 0, `no console errors (${errors.join(" | ").slice(0, 200)})`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
  youtubeStub.close();
  await db.end();
}
