// Done check for "Add by YouTube link": owner session, YouTube Data API stubbed server-side.
// Run from station/ with a FRESH local database:
//   docker compose exec -T db createdb -U ttunes <name>
//   DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<name> node test/e2e/addlink.e2e.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { SignJWT } from "jose";
import pg from "pg";
import { freePort, startDevServer } from "./devServer.mjs";
import { chromium } from "playwright";

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const SHOTS = new URL("./screens/", import.meta.url).pathname;
const SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
const OWNER_ID = 10647431;
const DB_URL = process.env.DATABASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) throw new Error(`E2E FAIL: ${msg}`); console.log(`ok  ${msg}`); };

if (!DB_URL || !/^postgres:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(DB_URL) || /ttunes_station$/.test(DB_URL)) {
  throw new Error("set DATABASE_URL to a fresh local database (not the shared ttunes_station)");
}

const catalog = {
  musicVid001: { title: "Neon Skyline (Official Audio)", duration: "PT3M42S", category: "10" },
  gamingVid01: { title: "Final Boss Theme - Game Soundtrack", duration: "PT4M18S", category: "20" },
  longVideo01: { title: "Eight Hours of Rain", duration: "PT2H" },
  blockedVid1: { title: "Label Blocked Embeds", duration: "PT3M", embeddable: false },
};
let youtubeCalls = 0;
const youtubeStub = createServer((req, res) => {
  youtubeCalls++;
  res.setHeader("Content-Type", "application/json");
  if (new URL(req.url, "http://x").pathname.endsWith("/search")) return res.end(JSON.stringify({ items: [] }));
  const ids = new URL(req.url, "http://x").searchParams.get("id").split(",");
  const items = ids.filter((id) => catalog[id]).map((id) => ({
    id,
    snippet: { title: catalog[id].title, categoryId: catalog[id].category },
    contentDetails: { duration: catalog[id].duration },
    status: { embeddable: catalog[id].embeddable ?? true },
  }));
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ items }));
});
await new Promise((r) => youtubeStub.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${youtubeStub.address().port}/youtube/v3`;

const env = { ...process.env, DATABASE_URL: DB_URL, SESSION_SECRET: SECRET, YOUTUBE_API_KEY: "stub", YOUTUBE_API_BASE_URL: stubUrl };
const run = (cmd) => new Promise((ok, bad) => spawn("npm", ["run", cmd], { env, stdio: "ignore" }).on("exit", (c) => (c === 0 ? ok() : bad(new Error(`${cmd} failed`)))));
await run("db:migrate");
const db = new pg.Pool({ connectionString: DB_URL });
await db.query("truncate queue, station_state, play_history, activity_log, songs cascade");
await db.query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Seed Song One',300),('seedSong002','Seed Song Two',300)");

const server = await startDevServer(PORT, env);

const { rows: [{ session_version: ver }] } = await db.query("select session_version from auth_state where id = 1");
const token = await new SignJWT({ ver }).setProtectedHeader({ alg: "HS256" }).setSubject(String(OWNER_ID)).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const browser = await chromium.launch();
try {
  mkdirSync(SHOTS, { recursive: true });
  const listener = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const lp = await listener.newPage();
  await lp.goto(BASE);
  await lp.getByTestId("next-title").waitFor();
  check((await lp.getByRole("link", { name: "Sign in" }).count()) === 1, "listener sees the Sign in link");
  check((await lp.getByRole("heading", { name: "Add song" }).count()) === 0, "listener sees no Add song panel");

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: "ttunes_session", value: token, url: BASE, httpOnly: true }]);
  await context.route("https://i.ytimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(BASE);
  await page.getByRole("heading", { name: "Add song" }).waitFor();
  check((await page.getByRole("link", { name: "Sign in" }).count()) === 0, "owner no longer sees Sign in");
  const nextBefore = await page.getByTestId("next-title").textContent();

  const assertPlayerClear = async (label) => {
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await sleep(200);
      await assertPlayerClearAt(`${label} @${width}px`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  const assertPlayerClearAt = async (label) => {
    const frame = await page.locator(".player-frame").boundingBox();
    const panel = await page.locator(".owner-panel").boundingBox();
    check(frame.width >= 200 && frame.height >= 200, `${label}: player ${frame.width}x${frame.height} >= 200x200`);
    check(frame.y + frame.height <= panel.y, `${label}: panel sits below the player, covering nothing`);
    check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `${label}: no horizontal scroll`);
  };
  const lookUp = async (url) => {
    await page.getByLabel("YouTube link").fill(url);
    await page.getByRole("button", { name: "Preview" }).click();
  };
  const shot = async (name) => {
    for (const [tag, w, h] of [["desktop-1280", 1280, 900], ["phone-375", 375, 812]]) {
      await page.setViewportSize({ width: w, height: h });
      await sleep(300);
      await page.screenshot({ path: `${SHOTS}addlink-${name}-${tag}.png`, fullPage: true });
      console.log(`screenshot ${SHOTS}addlink-${name}-${tag}.png`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  };

  // 1. Music link: preview, then Play next, shows as Up next.
  await lookUp("https://music.youtube.com/watch?v=musicVid001&list=RDx&t=5");
  await page.getByTestId("preview-title").waitFor();
  check((await page.getByTestId("preview-title").textContent()) === catalog.musicVid001.title, "preview shows the title");
  check((await page.getByTestId("preview").textContent()).includes("3:42"), "preview shows the length 3:42");
  check((await page.getByRole("img", { name: /Thumbnail of Neon Skyline/ }).getAttribute("src")) === "https://i.ytimg.com/vi/musicVid001/hqdefault.jpg", "preview shows the thumbnail");
  await shot("preview");
  await assertPlayerClear("preview");
  await page.getByRole("button", { name: "Play next" }).click();
  await page.getByText(/Added "Neon Skyline.*" as up next/).waitFor();
  await page.waitForFunction((t) => document.querySelector('[data-testid="next-title"]').textContent === t, catalog.musicVid001.title);
  check(nextBefore !== catalog.musicVid001.title, `Up next changed from "${nextBefore}" to the new song`);
  await shot("added");

  // 2. Gaming soundtrack, youtu.be form.
  await lookUp("https://youtu.be/gamingVid01?t=9");
  await page.getByTestId("preview-title").waitFor();
  await page.getByRole("button", { name: "Play next" }).click();
  await page.waitForFunction((t) => document.querySelector('[data-testid="next-title"]').textContent === t, catalog.gamingVid01.title);
  check(true, "Gaming-category soundtrack is added and shows as Up next");

  // 3. Two-hour video asks first.
  await lookUp("longVideo01");
  await page.getByTestId("preview-title").waitFor();
  await page.getByRole("button", { name: "Add to queue" }).click();
  await page.getByText(/Add anyway\?/).waitFor();
  check((await db.query("select 1 from songs where video_id = 'longVideo01'")).rowCount === 0, "2-hour video not added before confirming");
  await shot("confirm-long");
  await page.getByRole("button", { name: "Add anyway" }).click();
  await page.getByText(/Added "Eight Hours of Rain" to the end of the queue/).waitFor();
  check((await db.query("select duration_sec from songs where video_id = 'longVideo01'")).rows[0].duration_sec === 7200, "2-hour video added after confirming");

  // 4. Embed-blocked is refused.
  await lookUp("https://www.youtube.com/watch?v=blockedVid1");
  await page.getByRole("alert").filter({ hasText: "embedding is blocked" }).waitFor();
  check((await page.getByRole("button", { name: "Play next" }).count()) === 0, "blocked video offers no add buttons");
  check((await db.query("select 1 from songs where video_id = 'blockedVid1'")).rowCount === 0, "embed-blocked video not added");
  await shot("refused");
  await assertPlayerClear("after adds");

  const log = await db.query("select what, details->>'videoId' as vid from activity_log order by activity_log.id");
  check(log.rows.map((r) => r.vid).join() === "musicVid001,gamingVid01,longVideo01", "each add wrote an activity_log row");
  check(youtubeCalls > 0, `YouTube was only ever the local stub (${youtubeCalls} calls)`);
  const real = errors.filter((e) => !/favicon|youtube|googlevideo|google|ERR_BLOCKED|Failed to load resource/i.test(e));
  check(real.length === 0, `no app console errors ${real.join(" | ")}`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
  youtubeStub.close();
  await db.end();
}
