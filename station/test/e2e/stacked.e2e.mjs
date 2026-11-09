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
import { openSettings } from "./drawer.mjs";

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const DB_URL = process.env.DATABASE_URL;
const SHOTS = process.env.SHOTS_DIR;
const check = (ok, msg) => {
  if (!ok && process.env.KEEP_GOING) return void console.log(`FAIL ${msg}`); // KEEP_GOING=1 lists every failure instead of stopping at the first
  if (!ok) throw new Error(`E2E FAIL: ${msg}`);
  console.log(`ok  ${msg}`);
};
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

const rules = async (page, label, { h, layout }) => {
  const g = await geometry(page);
  check(g.layout === layout, `${label}: the page is really in the ${layout} layout`);
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

// A focused switch option's ring (box + outline offset + width) must not touch any other option's box or a legend.
const ringsClear = async (page, label) => {
  const bad = await page.evaluate(() => {
    const bad = [];
    const others = [...document.querySelectorAll(".look-switch label, .look-switch legend")];
    for (const input of document.querySelectorAll(".look-switch input")) {
      const label = input.closest("label");
      input.focus();
      const cs = getComputedStyle(label);
      const grow = cs.outlineStyle === "none" ? 0 : (parseFloat(cs.outlineWidth) || 0) + (parseFloat(cs.outlineOffset) || 0);
      const r = label.getBoundingClientRect();
      for (const o of others) {
        if (o === label) continue;
        const q = o.getBoundingClientRect();
        if (!q.width) continue;
        const sameRow = q.top < r.bottom && r.top < q.bottom;
        const g = sameRow && o.tagName === "LABEL" ? 0 : grow; // beside another option only the boxes must not collide; its text is padded clear of the ring
        if (r.left - g < q.right && q.left < r.right + g && r.top - g < q.bottom && q.top < r.bottom + g) bad.push(`${label.textContent} ring touches ${o.textContent}`);
      }
    }
    return bad;
  });
  check(bad.length === 0, `${label}: switch focus rings clear of neighbouring options (${bad.join("; ")})`);
};

// Tab from the top until focus comes back to the first stop; every step must be at or below the one before.
const walkTabs = async (page, label, minStops) => {
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  await page.mouse.click(1, 1); // the corner of the page: Tab starts from the top
  const stops = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate((n) => {
      const e = document.activeElement;
      const again = e.dataset.stop !== undefined;
      if (!again) e.dataset.stop = String(n);
      const r = e.getBoundingClientRect();
      return { again, wrapped: e === document.body || e === document.documentElement, id: e.dataset.stop, name: (e.getAttribute("aria-label") || e.id || e.textContent || e.tagName).trim().slice(0, 18), y: Math.round(r.top + scrollY) };
    }, i);
    if (stop.wrapped || (stop.again && stop.id === "0")) break; // focus left the page and came back around
    if (stop.again) { stops.push(stop); break; }
    stops.push(stop);
  }
  const backwards = stops.filter((s, i) => i > 0 && s.y < stops[i - 1].y - 12);
  check(backwards.length === 0 && stops.length >= minStops, `${label}: Tab walked ${stops.length} stops (>= ${minStops}) top to bottom, none backwards (${backwards.map((s) => s.name + "@" + s.y).join(", ")}) [${stops.map((s) => `${s.name}@${s.y}`).join(" > ")}]`);
};

try {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  // The matrix: 2 looks x 2 layouts x 3 screens, set the way a returning visitor has them (saved before load).
  for (const look of ["afterglow", "theset"]) for (const layout of ["side", "stacked"]) for (const [w, h] of [[1280, 800], [375, 812], [667, 375]]) {
    const page = await openPage({ width: w, height: h }, { saved: { "ttunes.look": look, "ttunes.layout": layout } });
    await rules(page, `${look}/${layout} @${w}x${h}`, { h, layout });
    if (SHOTS && layout === "stacked" && w !== 667) await page.screenshot({ path: `${SHOTS}stacked-${look}-${w}.png`, fullPage: true });
    await page.context().close();
  }
  // Small landscape, listener and owner, both layouts: the two switches must not push the player off the first screen.
  for (const owner of [false, true]) for (const layout of ["side", "stacked"]) for (const look of ["afterglow", "theset"]) for (const [w, h] of [[667, 375], [568, 320], [375, 812], [320, 568]]) {
    const page = await openPage({ width: w, height: h }, { owner, saved: { "ttunes.look": look, "ttunes.layout": layout } });
    const g = await geometry(page);
    check(g.layout === layout, `${owner ? "owner" : "listener"} ${look}/${layout} @${w}x${h}: the page is really in the ${layout} layout`);
    const hd = await page.locator("header").boundingBox();
    check(hd.height <= (h > 500 ? 200 : 150), `${owner ? "owner" : "listener"} ${look}/${layout} @${w}x${h}: header stays compact (${Math.round(hd.height)}px)`);
    if (SHOTS && !owner && layout === "stacked" && w === 320) await page.screenshot({ path: `${SHOTS}stacked-${look}-320.png`, fullPage: true });
    check(g.playerFirstScreenBottom <= h + 1 && g.player.h >= 199.5, `${owner ? "owner" : "listener"} ${look}/${layout} @${w}x${h}: player on first screen (bottom ${Math.round(g.playerFirstScreenBottom)} of ${h}, ${Math.round(g.player.h)}px tall)`);
    check(g.noHScroll, `${owner ? "owner" : "listener"} ${look}/${layout} @${w}x${h}: no horizontal scroll`);
    // The switches live in the Settings menu now: with it open their legends are visible, their focus rings clear, and the page still has no horizontal scroll.
    await openSettings(page);
    for (const lg of await page.locator(".look-switch legend").all()) check((await lg.boundingBox())?.width > 8, `${look}/${layout} @${w}x${h}: switch legend "${await lg.textContent()}" is visible`);
    await ringsClear(page, `${owner ? "owner" : "listener"} ${look}/${layout} @${w}x${h}`);
    check((await geometry(page)).noHScroll, `${owner ? "owner" : "listener"} ${look}/${layout} @${w}x${h}: menu open: no horizontal scroll`);
    await page.context().close();
  }

  // The switch: default, click, survives reload, unknown value, keyboard.
  const page = await openPage({ width: 1280, height: 800 });
  check((await page.evaluate(() => document.documentElement.dataset.layout)) === "side", "default layout is Side");
  await openSettings(page);
  await page.getByRole("radio", { name: "Stacked" }).check({ force: true });
  check((await geometry(page)).layout === "stacked", "choosing Stacked switches the page");
  check((await page.evaluate(() => localStorage.getItem("ttunes.layout"))) === "stacked", "choice saved in localStorage");
  await page.reload();
  await page.getByTestId("now-title").waitFor();
  await openSettings(page);
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
  await openSettings(page);
  check((await geometry(page)).layout === "side" && (await page.getByRole("radio", { name: "Side" }).isChecked()), "unknown saved layout falls back to Side");
  await page.context().close();

  // Switching must not rebuild the page: typed text stays, focus stays on the radio, the page does not scroll.
  for (const [w, h] of [[1280, 800], [375, 812]]) {
    const keep = await openPage({ width: w, height: h }, { saved: { "ttunes.layout": "side" }, ip: `203.0.113.${40 + w % 7}` });
    await keep.getByRole("button", { name: "Request a song" }).click();
    await keep.getByLabel("Your name").fill("Keeper");
    await keep.getByLabel("Song link").fill("https://youtu.be/musicVid001");
    await openSettings(keep);
    await keep.getByRole("radio", { name: "Side" }).focus();
    const before = await keep.evaluate(() => scrollY);
    for (const [key, to] of [["ArrowRight", "stacked"], ["ArrowLeft", "side"], ["ArrowRight", "stacked"]]) {
      await keep.keyboard.press(key);
      const now = await keep.evaluate(() => ({ layout: document.documentElement.dataset.layout, focus: document.activeElement?.getAttribute("name") + "=" + document.activeElement?.getAttribute("value"), y: scrollY, name: document.querySelector("#req-name")?.value, link: document.querySelector("#req-link")?.value }));
      check(now.layout === to, `@${w}: ${key} switches to ${to}`);
      check(now.name === "Keeper" && now.link === "https://youtu.be/musicVid001", `@${w}: typed name and link survive the switch to ${to}`);
      check(now.focus === `layout=${to}`, `@${w}: focus stays on the Layout radio (${now.focus})`);
      check(now.y === before, `@${w}: the page did not scroll (${before} -> ${now.y})`);
    }
    await keep.context().close();
  }
  // Escape must not close a drawer that is not on screen: open it in Side, go Stacked, Escape, come back.
  const esc = await openPage({ width: 1280, height: 800 });
  await esc.getByRole("button", { name: "Request a song" }).click();
  await openSettings(esc);
  await esc.getByRole("radio", { name: "Stacked" }).check({ force: true });
  await esc.getByRole("button", { name: "Settings" }).click(); // menu closed, focus on its button: Escape now goes to the page
  await esc.keyboard.press("Escape");
  await openSettings(esc);
  await esc.getByRole("radio", { name: "Side" }).check({ force: true });
  check((await esc.getByRole("button", { name: /^(Request a song|Requests)$/ }).getAttribute("aria-expanded")) === "true", "Escape in Stacked does not close the Side drawer");
  await esc.context().close();

  // Tab order in Stacked on a phone: top to bottom.
  const phone = await openPage({ width: 375, height: 812 }, { saved: { "ttunes.layout": "stacked" } });
  await walkTabs(phone, "phone Stacked listener", 9);
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
  await walkTabs(owner, "desktop Stacked owner", 20);
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}stacked-owner-1280.png`, fullPage: true });
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
