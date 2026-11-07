// Done check for the listener page: two browsers click Play and stay in sync across a song change.
// Run: npm run e2e (from station/). Needs Docker for Postgres and internet for YouTube.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import pg from "pg";
import { freePort, startDevServer } from "./devServer.mjs";
import { chromium } from "playwright";

const T0 = Date.now();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const SHOTS = new URL("./screens/", import.meta.url).pathname;
const MAX_SYNC_GAP_SEC = 3;
const MAX_SCHEDULE_GAP_SEC = 2.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { throw new Error(`E2E FAIL: ${msg}`); };
const check = (ok, msg) => { if (!ok) fail(msg); console.log(`ok  ${msg}`); };

const DB_URL = process.env.DATABASE_URL ?? "postgres://ttunes:ttunes@localhost:55432/ttunes_station";

async function songStarts() {
  const db = new pg.Pool({ connectionString: DB_URL });
  const { rows } = await db.query("select count(*)::int as n from play_history");
  await db.end();
  return rows[0].n;
}

function assertLocalDatabase() {
  const host = new URL(DB_URL).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") fail(`refusing to truncate tables on non-local database host "${host}"`);
}

async function resetStation() {
  assertLocalDatabase();
  execSync("npm run db:up && npm run db:migrate && npm run db:seed", { stdio: "inherit" });
  const db = new pg.Pool({ connectionString: DB_URL });
  await db.query("truncate queue, station_state, play_history");
  await db.end();
}

const SKEW_MS = 20_000;

async function openListener(browser, { skewMs = 0 } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Wrong local clock, main frame only (the YouTube iframe keeps real time): the offset logic must absorb it.
  if (skewMs) await context.addInitScript((skew) => { if (window.top === window) { const real = Date.now; Date.now = () => real() + skew; } }, skewMs);
  const page = await context.newPage();
  const listener = { page, nowRequests: 0, times: [], errors: [] };
  page.on("request", (req) => { if (new URL(req.url()).pathname === "/api/now") { listener.nowRequests++; listener.times.push(Math.round((Date.now() - T0) / 1000)); } });
  page.on("pageerror", (e) => listener.errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && listener.errors.push(m.text()));
  await page.goto(BASE);
  await page.getByRole("button", { name: "Play" }).click(); // the real path: one click
  await page.waitForFunction(() => window.__ttunes && window.__ttunes.currentTime() > 0.5, null, { timeout: 30_000 });
  return listener;
}

const snapshot = (l) => l.page.evaluate(() => ({ id: window.__ttunes.videoId(), t: window.__ttunes.currentTime() }));

async function assertInSync(a, b, label) {
  const [x, y] = await Promise.all([snapshot(a), snapshot(b)]);
  check(x.id === y.id, `${label}: same video (${x.id})`);
  check(Math.abs(x.t - y.t) < MAX_SYNC_GAP_SEC, `${label}: currentTime ${x.t.toFixed(1)}s vs ${y.t.toFixed(1)}s differ < ${MAX_SYNC_GAP_SEC}s`);
}

async function assertOnServerSchedule(l, label) {
  const snap = await snapshot(l);
  const now = await (await fetch(`${BASE}api/now`)).json();
  const { serverNow } = await (await fetch(`${BASE}api/time`)).json();
  const expected = (serverNow - now.startedAt) / 1000;
  check(now.current.videoId === snap.id, `${label}: playing the server's current video (${snap.id})`);
  check(Math.abs(snap.t - expected) < MAX_SCHEDULE_GAP_SEC, `${label}: currentTime ${snap.t.toFixed(1)}s vs server schedule ${expected.toFixed(1)}s differ < ${MAX_SCHEDULE_GAP_SEC}s`);
}

async function assertPlayerVisible(page, label) {
  const box = await page.locator(".player-host iframe").boundingBox();
  check(box && box.width >= 200 && box.height >= 200, `${label}: player ${box?.width}x${box?.height} >= 200x200`);
  const covered = await page.evaluate(() => {
    const r = document.querySelector(".player-host iframe").getBoundingClientRect();
    const pts = [[0.1, 0.1], [0.9, 0.1], [0.5, 0.5], [0.1, 0.9], [0.9, 0.9]];
    return pts.some(([fx, fy]) => document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)?.tagName !== "IFRAME");
  });
  check(!covered, `${label}: nothing covers the player`);
}

async function waitForSongChange(listeners, fromId) {
  await Promise.all(listeners.map((l) => l.page.waitForFunction((id) => window.__ttunes.videoId() !== id, fromId, { timeout: 130_000 })));
  await sleep(6_000); // let both players load and re-align
}

async function screenshots(page) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [name, width, height] of [["phone-390x844", 390, 844], ["desktop-1280x800", 1280, 800]]) {
    await page.setViewportSize({ width, height });
    await sleep(500);
    await assertPlayerVisible(page, name);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(!overflow, `${name}: no horizontal scroll`);
    await page.screenshot({ path: `${SHOTS}${name}.png` });
    console.log(`screenshot ${SHOTS}${name}.png`);
  }
}

function assertRequestCounts(listeners, songChanges) {
  for (const [i, l] of listeners.entries()) {
    const expected = 1 + songChanges; // join + one per song end
    const observedSec = Math.round((Date.now() - T0) / 1000) - l.times[0];
    const rechecks = Math.floor(observedSec / 30) + 1; // one per 30s of listening, plus rounding
    console.log(`  /api/now at t+${l.times.join("s, ")}s`);
    check(l.nowRequests >= expected && l.nowRequests <= expected + rechecks, `context ${i + 1}: /api/now requested ${l.nowRequests}x (join + ${songChanges} song end(s) + at most ${rechecks} 30s re-check(s) in ${observedSec}s)`);
  }
}

await resetStation();
const server = await startDevServer(PORT);
const browser = await chromium.launch();
try {
  const listeners = [await openListener(browser), await openListener(browser, { skewMs: SKEW_MS })]; // second one has a clock 20s fast
  const [first] = listeners;
  const startId = (await snapshot(first)).id;
  await assertPlayerVisible(first.page, "playing");
  await assertInSync(first, listeners[1], "before song change");
  await assertOnServerSchedule(listeners[0], "context 1 before song change");
  await assertOnServerSchedule(listeners[1], "context 2 (clock +20s) before song change");
  await waitForSongChange(listeners, startId);
  await assertInSync(first, listeners[1], "after song change");
  await assertOnServerSchedule(listeners[0], "context 1 after song change");
  await assertOnServerSchedule(listeners[1], "context 2 (clock +20s) after song change");
  check((await snapshot(first)).id !== startId, "page followed the song change");
  await screenshots(first.page);
  assertRequestCounts(listeners, (await songStarts()) - 1); // every song start after the first is a song end
  const errors = listeners.flatMap((l) => l.errors).filter((e) => !/favicon|youtube|googlevideo|google|doubleclick|ERR_BLOCKED|Failed to load resource/i.test(e));
  check(errors.length === 0, `no app console errors ${errors.join(" | ")}`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
}
