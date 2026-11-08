// Done check for typed search + owner controls (#24/#25): owner session, YouTube Data API stubbed server-side.
// Run from station/ with a FRESH local database:
//   docker compose exec -T db createdb -U ttunes <name>
//   DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<name> node test/e2e/controls.e2e.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { SignJWT } from "jose";
import pg from "pg";
import { openDrawer, playerClearOfDrawer } from "./drawer.mjs";
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
  topicSong01: { title: "Neon Skyline", channel: "Nova Echo - Topic", duration: "PT3M42S", category: "10" },
  musicVid001: { title: "Neon Skyline (Official Music Video)", channel: "Nova Echo", duration: "PT3M50S", category: "10" },
  otherVid001: { title: "Neon Skyline Reaction", channel: "Some Vlogger", duration: "PT9M", category: "24" },
  lateNight01: { title: "Late Night Drive", channel: "Nova Echo - Topic", duration: "PT4M10S", category: "10" },
  longVideo01: { title: "Eight Hours of Rain", channel: "Rain Co", duration: "PT2H", category: "10" },
};
const searches = { neon: ["musicVid001", "otherVid001", "topicSong01"], drive: ["lateNight01"], rain: ["longVideo01"] };
const youtubeStub = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("Content-Type", "application/json");
  if (url.pathname.endsWith("/search")) {
    const q = url.searchParams.get("q");
    if (q === "quota") { res.statusCode = 403; return res.end(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } })); }
    return res.end(JSON.stringify({ items: (searches[q] ?? []).map((id) => ({ id: { videoId: id }, snippet: { thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } } } })) }));
  }
  const ids = url.searchParams.get("id").split(",");
  res.end(JSON.stringify({ items: ids.filter((id) => catalog[id]).map((id) => ({
    id,
    snippet: { title: catalog[id].title, categoryId: catalog[id].category, channelTitle: catalog[id].channel },
    contentDetails: { duration: catalog[id].duration },
    status: { embeddable: true },
  })) }));
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
  const listeners = [];
  for (let i = 0; i < 2; i++) {
    const lp = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await lp.goto(BASE);
    await lp.getByTestId("now-title").waitFor();
    listeners.push(lp);
  }
  check((await listeners[0].locator(".owner-panel").count()) === 0, "listeners see no owner panel (no search, skip or lists)");

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: "ttunes_session", value: token, url: BASE, httpOnly: true }]);
  await context.route("https://i.ytimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(BASE);
  await openDrawer(page, "Add song");

  const shot = async (name) => {
    for (const [tag, w, h] of [["desktop-1280", 1280, 900], ["phone-375", 375, 812]]) {
      await page.setViewportSize({ width: w, height: h });
      await sleep(300);
      await page.screenshot({ path: `${SHOTS}controls-${name}-${tag}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  const assertPlayerClear = async (label) => {
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await sleep(200);
      const { frame, ok } = await playerClearOfDrawer(page);
      check(ok, `${label} @${width}px: player ${frame.width}x${frame.height} >= 200x200 and the drawer covers none of it`);
      check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `${label} @${width}px: no horizontal scroll`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  };
  const search = async (q) => {
    await page.getByLabel("Search YouTube").fill(q);
    await page.getByRole("button", { name: "Search", exact: true }).click();
  };
  const tab = (name) => page.getByRole("tab", { name }).click();
  const waitText = (testid, text) => page.waitForFunction(([id, t]) => document.querySelector(`[data-testid="${id}"]`)?.textContent === t, [testid, text]);

  // 1. Typed search: Topic upload ranks above the music video (the stub returns it LAST); pick -> play next.
  await search("neon");
  const results = page.getByTestId("search-results").locator("li");
  await results.first().waitFor();
  const titles = await results.locator("strong").allTextContents();
  check(titles[0] === "Neon Skyline" && titles[1] === "Neon Skyline (Official Music Video)", `Topic upload ranks first: ${titles.join(" | ")}`);
  const firstText = await results.first().textContent();
  check(firstText.includes("Nova Echo - Topic") && firstText.includes("3:42"), "result shows channel and length");
  check((await results.first().locator("img").count()) === 1, "result shows a thumbnail");
  await shot("search");
  await assertPlayerClear("search results");
  await page.getByRole("button", { name: "Choose Neon Skyline", exact: true }).click();
  await page.getByRole("button", { name: "Play next" }).click();
  await waitText("next-title", "Neon Skyline");
  check(true, "picked result is Up next");

  // 2. Search, pick, add to queue.
  await search("drive");
  await page.getByRole("button", { name: "Choose Late Night Drive" }).click();
  await page.getByRole("button", { name: "Add to queue" }).click();
  await page.getByText(/Added "Late Night Drive" to the end of the queue/).waitFor();
  // No tab click: the open Queue list must refresh by itself after an add.
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="list-queue"] li').length === 2);
  const queued = await page.getByTestId("list-queue").locator("li strong").allTextContents();
  check(queued.join("|") === "Neon Skyline|Late Night Drive", "queue lists both picks in order");
  check((await db.query("select 1 from songs where video_id = 'lateNight01'")).rowCount === 1, "searched song is in the library");

  // 3. A long result asks before adding.
  await search("rain");
  await page.getByRole("button", { name: "Choose Eight Hours of Rain" }).click();
  await page.getByRole("button", { name: "Add to queue" }).click();
  await page.getByText(/Add anyway\?/).waitFor();
  check((await db.query("select 1 from songs where video_id = 'longVideo01'")).rowCount === 0, "2-hour result not added before confirming");
  check(await page.getByRole("button", { name: "Add anyway" }).evaluate((el) => el === document.activeElement), "focus lands on Add anyway");
  await page.getByRole("button", { name: "Add anyway" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="list-queue"] li').length === 3);
  check(true, "queue list shows the confirmed long add without clicking a tab");

  // 4. Quota error shown plainly.
  await search("quota");
  await page.getByRole("alert").filter({ hasText: "Search limit for today is used up" }).waitFor();
  check(true, "quota error shows the server's message");
  await shot("quota");

  // 5. Queue edit.
  await openDrawer(page, "Owner tools");
  await page.getByRole("button", { name: "Move Neon Skyline down" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="list-queue"] li strong')?.textContent === "Late Night Drive");
  await waitText("next-title", "Late Night Drive");
  check(true, "moving down changes Up next immediately");
  await page.getByRole("button", { name: "Move Neon Skyline up" }).click();
  await waitText("next-title", "Neon Skyline");
  check(true, "moving back up restores Up next");
  await page.getByRole("button", { name: "Remove Eight Hours of Rain from queue" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="list-queue"] li').length === 2);
  check(true, "Remove takes the long song out of the queue list");

  // 6. Skip: the owner's screen updates at once, both listeners (after pressing Play) follow at their 30s re-check.
  const before = await Promise.all(listeners.map((p) => p.getByTestId("now-title").textContent()));
  for (const l of listeners) await l.getByRole("button", { name: "Play" }).click(); // only a listening tab re-checks every 30s
  await page.getByRole("button", { name: "Skip song" }).click();
  await waitText("now-title", "Neon Skyline");
  check(true, "owner's screen shows the skipped-to song immediately");
  for (const [i, l] of listeners.entries()) {
    await l.waitForFunction(() => document.querySelector('[data-testid="now-title"]')?.textContent === "Neon Skyline", null, { timeout: 60000 });
    check(true, `listener ${i + 1} moved from "${before[i]}" to Neon Skyline`);
  }

  // 7. Delete from the library: leaves library + queue; Undo brings it back.
  await tab("Library");
  await page.getByRole("button", { name: "Delete Late Night Drive" }).click();
  await page.getByRole("button", { name: "Undo" }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="list-library"] li strong')].some((e) => e.textContent === "Late Night Drive"));
  check(true, "deleted song left the library list");
  await page.waitForFunction(() => document.querySelector('[data-testid="next-title"]')?.textContent !== "Late Night Drive");
  check(true, "deleting the Up next song changes Up next immediately");
  check((await db.query("select 1 from queue where video_id = 'lateNight01'")).rowCount === 0, "deleted song is out of the queue");
  await tab("Trash");
  await page.getByTestId("list-trash").getByText("Late Night Drive").waitFor();
  await page.getByRole("button", { name: "Restore Late Night Drive" }).click();
  await page.getByText(/Restored "Late Night Drive"/).waitFor();
  await waitText("next-title", "Late Night Drive");
  check(true, "restoring puts it back as Up next immediately");
  await tab("Queue");
  await page.getByTestId("list-queue").getByText("Late Night Drive").waitFor();
  check(true, "restore returned the song to the queue");
  await tab("Library");
  await page.getByTestId("list-library").getByText("Late Night Drive").waitFor();
  check(true, "restore returned the song to the library");
  await tab("Trash");
  await page.getByText("Trash is empty.").waitFor();
  check(true, "trash shows its empty state");

  // 7b. The inline Undo link itself.
  await tab("Library");
  await page.getByRole("button", { name: "Delete Late Night Drive" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByText(/Restored "Late Night Drive"/).waitFor();
  check((await db.query("select 1 from songs where video_id = 'lateNight01' and deleted_at is null")).rowCount === 1, "inline Undo restores the song");

  // 8. Activity log, newest first.
  await tab("Activity");
  await page.getByTestId("list-log").waitFor();
  const labels = await page.getByTestId("list-log").locator("li strong").allTextContents();
  const want = ["Restored", "Deleted", "Restored", "Deleted", "Skipped", "Removed from queue", "Moved in queue", "Moved in queue", "Added", "Added", "Added"];
  check(labels.join("|") === want.join("|"), `log, newest first: ${labels.join(", ")}`);
  await shot("activity");
  await assertPlayerClear("after actions");

  // 10. Account: export link, in-page confirm (no window.confirm), sign out everywhere ends the session.
  page.on("dialog", () => { throw new Error("E2E FAIL: window.confirm used"); });
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export library" }).click()]);
  check(/^ttunes-library-.*\.json$/.test(download.suggestedFilename()), `Export library downloads ${download.suggestedFilename()}`);
  const confirmFocus = async () => page.evaluate(() => document.activeElement?.textContent);
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await page.getByRole("button", { name: "Yes, sign out everywhere" }).waitFor();
  check((await confirmFocus()) === "Yes, sign out everywhere", "opening the confirm focuses its Yes button");
  await shot("signout-confirm");
  await page.getByRole("button", { name: "Cancel" }).last().click();
  check((await confirmFocus()) === "Sign out everywhere", "Cancel returns focus to the Sign out everywhere button");
  check((await page.getByRole("button", { name: "Yes, sign out everywhere" }).count()) === 0, "Cancel closes the confirm");
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await page.getByRole("button", { name: "Yes, sign out everywhere" }).click();
  await page.getByRole("link", { name: /^Owner sign-in/ }).waitFor();
  check((await page.locator(".owner-panel").count()) === 0, "after sign out everywhere the page is signed out");
  check((await page.request.get(`${BASE}api/owner/queue`)).status() === 401, "the old session cookie is refused");

  const real = errors.filter((e) => !/favicon|youtube|googlevideo|google|ERR_BLOCKED|Failed to load resource|compute-pressure|Permissions policy/i.test(e));
  check(real.length === 0, `no app console errors ${real.join(" | ")}`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
  youtubeStub.close();
  await db.end();
}
