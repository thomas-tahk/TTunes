// Done check for the header Settings menu and the Afterglow Panel choice (5 panel colours).
// Run from station/ with a FRESH local database:
//   docker compose exec -T db createdb -U ttunes <name>
//   DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<name> node test/e2e/settings.e2e.mjs
// Optional: SHOTS_DIR=<dir/> writes the panel, menu and Stacked screenshots. The YouTube Data API is never called (stub key, dead URL).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { SignJWT } from "jose";
import pg from "pg";
import { chromium } from "playwright";
import { freePort, startDevServer } from "./devServer.mjs";
import { openDrawer, openSettings, overlaps } from "./drawer.mjs";

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const DB_URL = process.env.DATABASE_URL;
const SHOTS = process.env.SHOTS_DIR;
const check = (ok, msg) => {
  if (!ok && process.env.KEEP_GOING) return void console.log(`FAIL ${msg}`);
  if (!ok) throw new Error(`E2E FAIL: ${msg}`);
  console.log(`ok  ${msg}`);
};
if (!DB_URL || !/^postgres:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(DB_URL) || /ttunes_station$/.test(DB_URL)) {
  throw new Error("set DATABASE_URL to a fresh local database (not the shared ttunes_station)");
}

const env = { ...process.env, DATABASE_URL: DB_URL, SESSION_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123", YOUTUBE_API_KEY: "stub", YOUTUBE_API_BASE_URL: "http://127.0.0.1:1/youtube/v3" };
await new Promise((ok, bad) => spawn("npm", ["run", "db:migrate"], { env, stdio: "ignore" }).on("exit", (c) => (c === 0 ? ok() : bad(new Error("migrate failed")))));
const db = new pg.Pool({ connectionString: DB_URL });
await db.query("truncate queue, station_state, play_history, activity_log, songs, requests, request_attempts cascade");
await db.query("update settings set value = 'approve' where key = 'request_mode'");
await db.query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Sunrise',300),('seedSong002','Golden Hour',300)");
await db.query(`insert into requests (video_id, title, duration_sec, name, dedication, status, listener_id, queued_at) values
  ('seedSong001','Sunrise',300,'night shift','to stay awake','waiting','l1',null),
  ('seedSong002','Golden Hour',300,'3rd floor','for the coffee machine fixer','queued','l2',now()),
  ('seedSong003','Played One',200,'Olga','','played','l3',now()),
  ('seedSong004','Expired One',200,'Ivan','','expired','l4',now())`);
const server = await startDevServer(PORT, env);
const browser = await chromium.launch();
const { rows: [{ session_version: ver }] } = await db.query("select session_version from auth_state where id = 1");
const ownerToken = await new SignJWT({ ver }).setProtectedHeader({ alg: "HS256" }).setSubject("10647431").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(env.SESSION_SECRET));
const errors = [];

const openPage = async (viewport, { owner = false, saved = {}, init } = {}) => {
  const context = await browser.newContext({ viewport });
  if (owner) await context.addCookies([{ name: "ttunes_session", value: ownerToken, url: BASE, httpOnly: true }]);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(BASE);
  await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, { "ttunes.requestHintSeen": "1", ...saved });
  await page.reload();
  await page.getByTestId("now-title").waitFor();
  await page.waitForTimeout(300);
  return page;
};
const attr = (page, name) => page.evaluate((n) => document.documentElement.dataset[n], name);
const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

// ---- in-page measuring: text contrast and focus rings against the real, composited background ----
const measure = (page) => page.evaluate(() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const parse = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const shell = getComputedStyle(document.querySelector(".shell"));
  const washes = ["--wash-hot", "--wash-mid", "--wash-deep"].map((v) => parse(shell.getPropertyValue(v).trim()));
  // Layers behind an element, top to bottom, up to the first opaque one; whatever is still see-through is laid over each wash colour (the worst case counts).
  const layers = (el) => { const out = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] > 0) out.push(c); if (c[3] >= 0.999) break; } return out; };
  const backgrounds = (el) => washes.map((w) => layers(el).reduceRight((under, l) => over(l, under), over(w, [0, 0, 0, 1])));
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const worst = (fg, bgs) => Math.min(...bgs.map((b) => ratio(over(fg, b), b)));
  const label = (el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} "${(el.textContent || "").trim().slice(0, 24)}"`;

  const text = [];
  for (const root of document.querySelectorAll(".drawer, .drawer-tab")) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const cs = getComputedStyle(el);
      text.push({ el: label(el), ratio: worst(parse(cs.color), backgrounds(el)) });
    }
  }
  const rings = [];
  const focusables = [...document.querySelectorAll(".drawer button, .drawer input, .drawer textarea, .drawer a[href], .drawer-tab")].filter((e) => visible(e) && !e.disabled);
  for (const el of focusables.slice(0, 25)) {
    el.focus({ preventScroll: true });
    const cs = getComputedStyle(el);
    const colour = parse(cs.outlineColor);
    const ok = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2;
    const outside = (parseFloat(cs.outlineOffset) || 0) >= 0; // an offset ring sits on what is around the control, not on the control
    rings.push({ el: label(el), ok, ratio: ok ? worst(colour, backgrounds(outside ? el.parentElement : el)) : 0 });
  }
  return { text, rings, chips: [...document.querySelectorAll(".status-waiting, .mode-approve")].filter(visible).map(label) };
});

// ================= 1. The menu: closed state, keyboard, Escape =================
{
  const page = await openPage({ width: 1280, height: 800 });
  const button = page.getByRole("button", { name: "Settings" });
  check((await button.getAttribute("aria-expanded")) === "false" && (await page.locator("#settings-panel").count()) === 0, "Settings is a closed disclosure button; no Look/Layout/Panel radios until opened");
  check((await page.locator("header").getByRole("radio").count()) === 0, "no radios in the header while closed");
  await page.mouse.click(1, 1);
  await page.keyboard.press("Tab");
  check(await button.evaluate((el) => el === document.activeElement), "first Tab stop is the Settings button");
  await page.keyboard.press("Enter");
  check((await button.getAttribute("aria-expanded")) === "true", "Enter opens the menu");
  const groups = await page.locator("#settings-panel fieldset legend").allTextContents();
  check(groups.join(",") === "Look,Layout,Panel", `the menu holds Look, Layout and Panel (${groups})`);
  check((await page.getByRole("group", { name: "Panel" }).getByRole("radio").count()) === 5, "Panel has five options");
  const stops = [];
  for (let i = 0; i < 3; i++) { await page.keyboard.press("Tab"); stops.push(await page.evaluate(() => document.activeElement.name)); }
  check(stops.join(",") === "look,layout,panel", `Tab visits one stop per group in order (${stops})`);
  await page.keyboard.press("ArrowRight");
  check((await attr(page, "panel")) === "black" && (await stored(page, "ttunes.panel")) === "black", "ArrowRight on Panel picks Neutral black and saves it");
  await page.keyboard.press("ArrowDown");
  check((await attr(page, "panel")) === "frosted", "ArrowDown picks Frosted");
  await page.keyboard.press("Escape");
  check((await button.getAttribute("aria-expanded")) === "false" && (await button.evaluate((el) => el === document.activeElement)), "Escape closes the menu and returns focus to Settings");
  check((await attr(page, "panel")) === "frosted", "closing keeps the choice");
  // Escape closes only the menu when the drawer is open too.
  await openDrawer(page);
  await openSettings(page);
  await page.getByRole("radio", { name: "Cream" }).focus();
  await page.keyboard.press("Escape");
  check((await button.getAttribute("aria-expanded")) === "false" && (await page.getByRole("button", { name: /^(Request a song|Requests)$/ }).getAttribute("aria-expanded")) === "true", "Escape closes the menu, not the request drawer behind it");
  // The Set keeps its own panel: the Panel group goes away, the saved choice stays.
  await openSettings(page);
  await page.getByRole("radio", { name: "The Set" }).check();
  check((await page.getByRole("group", { name: "Panel" }).count()) === 0 && (await page.locator("#settings-panel fieldset").count()) === 2, "under The Set the menu shows only Look and Layout");
  check((await stored(page, "ttunes.panel")) === "frosted", "the saved panel is untouched while The Set is on");
  await page.getByRole("radio", { name: "Afterglow" }).check();
  check(await page.getByRole("radio", { name: "Frosted" }).isChecked(), "back in Afterglow the Panel group returns with the saved choice");
  await page.context().close();
}

// ================= 2. Header height at 375x812, and the menu never remounts the request section =================
{
  const page = await openPage({ width: 375, height: 812 });
  const closed = await page.locator("header").boundingBox();
  console.log(`header height @375x812: ${Math.round(closed.height)}px closed (was 176px with the switches in the header)`);
  check(closed.height <= 130, `header gives height back at 375x812 (${Math.round(closed.height)}px, was 176px)`);
  await page.getByRole("button", { name: "Request a song" }).click();
  await page.getByLabel("Your name").fill("Keeper");
  await page.getByLabel("Song link").fill("https://youtu.be/musicVid001");
  await page.getByRole("button", { name: "Settings" }).click();
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}menu-open-375.png` }); }
  const open = await page.locator("header").boundingBox();
  console.log(`header height @375x812: ${Math.round(open.height)}px with the menu open`);
  for (const [name, check1] of [["Stacked", "layout"], ["The Set", "look"], ["Afterglow", "look"], ["Cream", "panel"], ["Side", "layout"]]) {
    await page.getByRole("radio", { name }).check({ force: true });
    const now = await page.evaluate(() => ({ name: document.querySelector("#req-name")?.value, link: document.querySelector("#req-link")?.value }));
    check(now.name === "Keeper" && now.link === "https://youtu.be/musicVid001", `typed request text survives choosing ${name} (${check1})`);
  }
  await page.context().close();
}

// ================= 3. Player rules, menu closed and open, listener and owner, both layouts =================
for (const owner of [false, true]) for (const layout of ["side", "stacked"]) for (const [w, h] of [[375, 812], [320, 568], [667, 375], [568, 320]]) {
  const page = await openPage({ width: w, height: h }, { owner, saved: { "ttunes.layout": layout } });
  const who = `${owner ? "owner" : "listener"} ${layout} @${w}x${h}`;
  for (const menu of ["closed", "open"]) {
    if (menu === "open") await openSettings(page);
    const g = await page.evaluate(() => {
      const r = document.querySelector(".player-host").getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const panel = document.querySelector("#settings-panel")?.getBoundingClientRect();
      return { r: { x: r.x, y: r.y + scrollY, width: r.width, height: r.height }, bottom: r.bottom, uncovered: document.querySelector(".player-host").contains(top), noH: document.documentElement.scrollWidth <= innerWidth, panel: panel && { x: panel.x, y: panel.y + scrollY, width: panel.width, height: panel.height } };
    });
    const label = `${who}, menu ${menu}`;
    check(g.r.height >= 199.5 && (Math.abs(g.r.width / g.r.height - 16 / 9) < 0.03 || g.r.height <= 200.5), `${label}: player ${Math.round(g.r.width)}x${Math.round(g.r.height)} is 16:9 and at least 200px tall`);
    check(g.uncovered && g.noH, `${label}: nothing covers the player, no horizontal scroll`);
    if (g.panel) check(!overlaps(g.panel, g.r), `${label}: the menu panel does not overlap the player`);
    // Open: an in-flow panel cannot fit a 200px player into a 320-375px tall screen as well, so only the tall phones keep it on the first screen (the player is still never covered; the page scrolls).
    if (menu === "closed" || h >= 800) check(g.bottom <= h + 1, `${label}: player on the first screen (bottom ${Math.round(g.bottom)} of ${h})`);
    else console.log(`    ${label}: menu open, player bottom at ${Math.round(g.bottom)} of ${h} (scroll to see it; not covered)`);
  }
  await page.context().close();
}

// ================= 4. Each Afterglow panel (owner, so every tab and chip exists) =================
const PANELS = [["dark", "Dark tinted"], ["black", "Neutral black"], ["frosted", "Frosted"], ["cream", "Cream"], ["yellow", "Yellow"]];
for (const [id, name] of PANELS) {
  const page = await openPage({ width: 1280, height: 800 }, { owner: true, saved: { "ttunes.panel": id }, init: () => { new MutationObserver(() => { (window.__panels ??= []).push(document.documentElement.dataset.panel); }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-panel"] }); } });
  check((await attr(page, "panel")) === id && (await attr(page, "look")) === "afterglow", `${id}: data-panel applied`);
  await openDrawer(page);
  await page.waitForTimeout(400);
  for (const tab of ["Requests", "Add song", "Owner tools"]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await page.waitForTimeout(500);
    if (tab === "Requests") {
      await page.locator(".feed-row").first().waitFor();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}panel-${id}-1280.png` });
    }
    await page.keyboard.press("Shift"); // keyboard modality, so a script focus() shows the :focus-visible ring
    const m = await measure(page);
    const lows = m.text.filter((t) => t.ratio < 4.5);
    check(m.text.length > 5 && lows.length === 0, `${id} / ${tab}: all ${m.text.length} text items >= 4.5:1 ${lows.map((t) => `${t.el} ${t.ratio.toFixed(2)}`).join("; ")}`);
    const bad = m.rings.filter((r) => !r.ok || r.ratio < 3);
    check(m.rings.length >= 2 && bad.length === 0, `${id} / ${tab}: focus ring visible (>= 2px, >= 3:1) on ${m.rings.length} controls ${bad.map((r) => `${r.el} ${r.ratio.toFixed(2)}`).join("; ")}`);
    if (tab === "Requests") check(m.chips.length >= 2 && m.text.filter((t) => /status-waiting|mode-approve/.test(t.el)).every((t) => t.ratio >= 4.5), `${id}: waiting and approve chips are shown and readable (${m.chips.length} chips)`);
  }
  await page.reload();
  await page.getByTestId("now-title").waitFor();
  check((await attr(page, "panel")) === id, `${id}: survives a reload`);
  check((await page.evaluate(() => window.__panels?.[0])) === id || id === "dark", `${id}: set on <html> before the app starts (first change is ${id})`);
  await openSettings(page);
  check(await page.getByRole("radio", { name }).isChecked(), `${id}: the menu shows ${name} checked after reload`);
  await page.context().close();
}

// ================= 5. Choosing through the menu, bad values, blocked storage =================
{
  const page = await openPage({ width: 1280, height: 800 });
  check((await attr(page, "panel")) === "dark" && (await stored(page, "ttunes.panel")) === null, "default is Dark tinted and nothing is saved until chosen");
  await openSettings(page);
  await page.getByRole("radio", { name: "Cream" }).check();
  check((await stored(page, "ttunes.panel")) === "cream" && (await attr(page, "panel")) === "cream", "choosing Cream applies and saves it");
  const drawerBg = (p) => p.evaluate(() => getComputedStyle(document.querySelector(".drawer")).backgroundColor);
  const cream = await drawerBg(page);
  await page.getByRole("radio", { name: "Yellow" }).check();
  check((await drawerBg(page)) !== cream, "the drawer colour really changes between panels");
  await page.getByRole("radio", { name: "The Set" }).check();
  const setBg = await drawerBg(page);
  await page.evaluate(() => { document.documentElement.dataset.panel = "dark"; });
  check((await drawerBg(page)) === setBg, "The Set's drawer ignores the panel choice");
  await page.context().close();

  for (const bad of ["neon", "", "CREAM", "__proto__"]) {
    const p = await openPage({ width: 1280, height: 800 }, { saved: { "ttunes.panel": bad } });
    check((await attr(p, "panel")) === "dark", `bad stored value ${JSON.stringify(bad)} gives Dark tinted`);
    await openSettings(p);
    check(await p.getByRole("radio", { name: "Dark tinted" }).isChecked(), `bad stored value ${JSON.stringify(bad)}: the menu shows Dark tinted`);
    await p.context().close();
  }

  const blocked = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await blocked.addInitScript(() => { const boom = () => { throw new Error("storage blocked"); }; Storage.prototype.getItem = boom; Storage.prototype.setItem = boom; });
  const bp = await blocked.newPage();
  bp.on("pageerror", (e) => errors.push(String(e)));
  await bp.goto(BASE);
  await bp.getByTestId("now-title").waitFor();
  check((await attr(bp, "panel")) === "dark" && (await attr(bp, "look")) === "afterglow" && (await attr(bp, "layout")) === "side", "storage throws: Dark tinted, Afterglow, Side, and the page loads");
  await openSettings(bp);
  await bp.getByRole("radio", { name: "Frosted" }).check();
  check((await attr(bp, "panel")) === "frosted", "storage throws: choosing a panel still works for this visit");
  await blocked.close();
}

// ================= 6. Stacked on a phone with Dark tinted =================
{
  const page = await openPage({ width: 375, height: 812 }, { saved: { "ttunes.layout": "stacked", "ttunes.panel": "dark" } });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}stacked-dark-375.png`, fullPage: true });
  const p = await page.locator(".player-host").boundingBox();
  const d = await page.locator(".drawer").boundingBox();
  check(p.y + p.height <= 812 && d.y > p.y + p.height, "Stacked 375 with Dark tinted: player on the first screen, requests below it");
  await page.context().close();
}

check(errors.length === 0, `no console errors (${errors.join(" | ").slice(0, 300)})`);
console.log("E2E PASS");
await browser.close();
server.kill();
await db.end();
