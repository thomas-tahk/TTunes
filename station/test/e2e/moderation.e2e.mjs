// Done check for owner moderation (#32): owner session + listener contexts, YouTube stubbed server-side.
// Run from station/ with a FRESH local database:
//   docker compose exec -T db createdb -U ttunes <name>
//   DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<name> node test/e2e/moderation.e2e.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { SignJWT } from "jose";
import pg from "pg";
import { freePort, startDevServer } from "./devServer.mjs";
import { chromium } from "playwright";

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const SHOTS = process.env.SHOTS_DIR ?? new URL("./screens/", import.meta.url).pathname;
const SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
const OWNER_ID = 10647431;
const DB_URL = process.env.DATABASE_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) throw new Error(`E2E FAIL: ${msg}`); console.log(`ok  ${msg}`); };

if (!DB_URL || !/^postgres:\/\/[^/]*(localhost|127\.0\.0\.1)/.test(DB_URL) || /ttunes_station$/.test(DB_URL)) {
  throw new Error("set DATABASE_URL to a fresh local database (not the shared ttunes_station)");
}

const catalog = {
  gameVid0001: { title: "Boss Fight Theme", duration: "PT3M20S", category: "20" },
  gameVid0002: { title: "Speedrun Marathon", duration: "PT4M", category: "20" },
  musicVid001: { title: "Neon Skyline (Official Audio)", duration: "PT3M42S", category: "10" },
};
const youtubeStub = createServer((req, res) => {
  const ids = (new URL(req.url, "http://x").searchParams.get("id") ?? "").split(",");
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ items: ids.filter((id) => catalog[id]).map((id) => ({
    id,
    snippet: { title: catalog[id].title, categoryId: catalog[id].category, channelTitle: "Chan" },
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
await db.query("truncate queue, station_state, play_history, activity_log, songs, requests, request_attempts cascade");
await db.query("update settings set value = 'open' where key = 'request_mode'");
await db.query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Seed Song One',300),('seedSong002','Seed Song Two',300)");

const server = await startDevServer(PORT, env);
const { rows: [{ session_version: ver }] } = await db.query("select session_version from auth_state where id = 1");
const token = await new SignJWT({ ver }).setProtectedHeader({ alg: "HS256" }).setSubject(String(OWNER_ID)).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const browser = await chromium.launch();
const errors = [];
const newPage = async (ip, owner) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: ip ? { "x-forwarded-for": ip } : {} });
  if (owner) await context.addCookies([{ name: "ttunes_session", value: token, url: BASE, httpOnly: true }]);
  await context.route("https://i.ytimg.com/**", (route) => route.fulfill({ contentType: "image/png", body: PIXEL }));
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(BASE);
  await page.getByTestId("next-title").waitFor();
  return page;
};
const listenerPost = async (page, name, videoId) => {
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Song link").fill(`https://youtu.be/${videoId}`);
  await page.getByRole("button", { name: "Send request" }).click();
  await page.getByTestId("mine").waitFor();
};
const rewind = () => db.query("update station_state set started_at_ms = started_at_ms - 400000");
const status = async (name) => (await db.query("select status from requests where name = $1", [name])).rows[0]?.status;
const logLabels = (page) => page.getByTestId("list-log").locator("li strong").allTextContents();

try {
  mkdirSync(SHOTS, { recursive: true });
  const owner = await newPage(null, true);
  await owner.getByRole("heading", { name: "Controls" }).waitFor();
  const badge = () => owner.getByTestId("waiting-badge").textContent();
  const reloadOwner = async () => { await owner.reload(); await owner.getByTestId("waiting-badge").waitFor(); await owner.waitForFunction(() => !document.body.textContent.includes("Loading requests")); };
  const rowOf = (name) => owner.getByTestId("feed-row").filter({ hasText: name });
  const shot = async (name) => {
    for (const [tag, w, h] of [["desktop-1280", 1280, 900], ["phone-375", 375, 812]]) {
      await owner.setViewportSize({ width: w, height: h });
      await sleep(300);
      await owner.screenshot({ path: `${SHOTS}${name}-${tag}.png`, fullPage: true });
      console.log(`screenshot ${SHOTS}${name}-${tag}.png`);
    }
    await owner.setViewportSize({ width: 1280, height: 900 });
  };
  const layoutOk = async (label) => {
    for (const width of [1280, 375]) {
      await owner.setViewportSize({ width, height: 900 });
      await sleep(200);
      const frame = await owner.locator(".player-frame").boundingBox();
      const box = await owner.locator(".requests").boundingBox();
      check(frame.width >= 200 && frame.height >= 200, `${label} @${width}px: player ${frame.width}x${frame.height} >= 200x200`);
      check(frame.y + frame.height <= box.y, `${label} @${width}px: requests sit below the player`);
      check(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${label} @${width}px: no horizontal scroll`);
      const small = await owner.evaluate(() => [...document.querySelectorAll(".feed button, .segmented button")].filter((b) => b.getBoundingClientRect().height < 44).length);
      check(small === 0, `${label} @${width}px: moderation buttons are >= 44px tall`);
    }
    await owner.setViewportSize({ width: 1280, height: 900 });
  };

  check((await owner.getByTestId("waiting-badge").textContent()) === "0", "owner starts with badge 0");
  check((await owner.getByRole("radio", { name: /^Open/ }).getAttribute("aria-checked")) === "true", "mode control shows Open");

  // 1. Alice's Gaming request waits; owner sees badge 1 and approves.
  const alice = await newPage("203.0.113.1");
  await listenerPost(alice, "Alice", "gameVid0001");
  check((await alice.getByTestId("mine").textContent()).toLowerCase().includes("waiting"), "Gaming request waits in open mode");
  await reloadOwner();
  check((await badge()) === "1", "owner sees badge 1");
  check((await rowOf("Alice").getByRole("button").allTextContents()).join("|") === "Approve|Deny|Remove", "waiting row offers Approve, Deny, Remove");
  await shot("owner-waiting");
  await layoutOk("waiting row");
  await rowOf("Alice").getByRole("button", { name: /^Approve/ }).click();
  await rowOf("Alice").getByText("Coming up").waitFor();
  check((await badge()) === "0", "badge drops to 0 right after approve");
  check((await status("Alice")) === "queued", "approved request is queued in the DB");
  await owner.getByTestId("mod-note").getByText("Approved. It is queued.").waitFor();
  await rewind();
  await reloadOwner();
  await owner.waitForFunction((t) => document.querySelector('[data-testid="now-title"]')?.textContent === t, catalog.gameVid0001.title);
  check(true, "approved Gaming request plays");
  await rewind();

  // 2. Bob's request: one tap deny, never plays, gone from the listener feed.
  const bob = await newPage("203.0.113.2");
  await listenerPost(bob, "Bob", "gameVid0002");
  await reloadOwner();
  check((await badge()) === "1", "badge 1 for the second waiting request");
  await rowOf("Bob").getByRole("button", { name: /^Deny/ }).click();
  await rowOf("Bob").getByText("Denied").waitFor();
  check((await badge()) === "0", "badge back to 0 after deny");
  check((await rowOf("Bob").getByRole("button").count()) === 0, "denied row has no actions left");
  check((await status("Bob")) === "denied", "denied in the DB");
  await rewind();
  await rewind();
  await owner.reload();
  await owner.getByTestId("now-title").waitFor();
  check((await owner.getByTestId("now-title").textContent()) !== catalog.gameVid0002.title, "denied request never plays");
  await bob.reload();
  await bob.getByTestId("next-title").waitFor();
  check((await bob.getByTestId("feed-row").filter({ hasText: "Bob" }).count()) === 0, "denied request is gone from the listener feed");
  await owner.getByTestId("feed-row").first().waitFor();

  // 3. Cara's music request auto-queues, plays, then the owner removes its text.
  const cara = await newPage("203.0.113.3");
  await listenerPost(cara, "Cara", "musicVid001");
  for (let i = 0; i < 2; i++) { await rewind(); await owner.reload(); await owner.getByTestId("now-title").waitFor(); } // each read moves the station on one song
  await reloadOwner();
  await rowOf("Cara").getByText("Played").waitFor();
  check(true, "Cara's request has played");
  await rowOf("Cara").getByRole("button", { name: /^Remove/ }).click();
  await owner.getByTestId("mod-note").getByText("Removed from the feed.").waitFor();
  check((await status("Cara")) === "denied", "removed request is hidden in the DB");
  const viewer = await newPage("203.0.113.4");
  await viewer.getByTestId("feed-row").first().waitFor();
  check((await viewer.getByTestId("feed-row").filter({ hasText: "Cara" }).count()) === 0, "removed text is gone from the listener feed after a reload");
  check((await viewer.getByTestId("feed-row").filter({ hasText: "Alice" }).count()) === 1, "other played requests remain in the listener feed");
  check((await viewer.getByRole("button", { name: /Approve|Deny|Remove|Keep/ }).count()) === 0, "listeners never see moderation buttons");

  // 4. Keep Alice's played request: it joins the library.
  await owner.getByTestId("feed-row").filter({ hasText: "Alice" }).first().waitFor();
  await rowOf("Alice").getByRole("button", { name: /^Keep/ }).click();
  await rowOf("Alice").getByText("In library").waitFor();
  check((await owner.evaluate(() => document.activeElement?.closest('[data-testid="feed-row"]')?.textContent.includes("Alice"))) === true, "focus stays in the row after Keep");
  // A later status change (the 30s re-check) must not pull focus out of the field the owner is typing in.
  await owner.getByLabel("Your name").focus();
  await db.query("update requests set status = 'expired' where name = 'Alice'");
  await rowOf("Alice").getByText("Expired").waitFor({ timeout: 60000 });
  check((await owner.getByLabel("Your name").evaluate((el) => el === document.activeElement)) === true, "a later status change leaves focus in the name field");
  check((await db.query("select 1 from songs where video_id = 'gameVid0001' and deleted_at is null")).rowCount === 1, "kept song is in the library table");
  await owner.getByRole("tab", { name: "Library" }).click();
  await owner.getByTestId("list-library").getByText(catalog.gameVid0001.title).waitFor();
  check(true, "kept song appears in the library list");

  // 5. 409 path: the request changed under the owner. Approve Dana's waiting request behind the page's back, then tap Approve.
  const dana = await newPage("203.0.113.5");
  await listenerPost(dana, "Dana", "gameVid0002");
  // Freeze the owner's list at "Dana waiting" so a background reload cannot refresh the row before the tap.
  const [snapshot] = await Promise.all([owner.waitForResponse((r) => r.url().endsWith("/api/owner/requests") && r.request().method() === "GET"), owner.reload()]);
  const frozen = await snapshot.text();
  await owner.route("**/api/owner/requests", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: frozen }) : route.continue()));
  await rowOf("Dana").getByRole("button", { name: /^Approve/ }).waitFor();
  await db.query("update requests set status = 'queued', queued_at = now() where name = 'Dana'");
  const [reply] = await Promise.all([
    owner.waitForResponse((r) => r.url().endsWith("/api/owner/requests/moderate")),
    rowOf("Dana").getByRole("button", { name: /^Approve/ }).click(),
  ]);
  const replyBody = await reply.json();
  check(reply.status() === 409 && typeof replyBody.error === "string" && replyBody.error.length > 5, `server answered 409: ${replyBody.error}`);
  await rowOf("Dana").getByText("Coming up").waitFor();
  await owner.unroute("**/api/owner/requests");
  const note = owner.getByTestId("mod-note");
  check((await note.textContent()) === replyBody.error, "note shows the server's exact 409 text");
  check(((await note.getAttribute("class")) ?? "").includes("owner-error"), "the 409 note is styled as an error");
  check((await badge()) === "0", "badge follows the server's count after the 409");

  // 5b. More than 30 newer rows push an old waiting request out of the public list: it must still be actionable, and clicking keeps focus.
  await db.query("insert into requests (video_id, title, duration_sec, name, status, listener_id, created_at) values ('oldWait0001', 'Old Waiting Song', 100, 'Olga', 'waiting', 'olga', now() - interval '2 hours')");
  await db.query(`insert into requests (video_id, title, duration_sec, name, status, listener_id)
    select 'fillSong' || g, 'Filler ' || g, 100, 'Filler ' || g, 'played', 'filler' || g from generate_series(1, 31) g`);
  await reloadOwner();
  check((await badge()) === "1", "badge counts the old waiting request");
  await rowOf("Filler 31").getByRole("button", { name: /^Remove/ }).click();
  await owner.getByTestId("mod-note").getByText("Removed from the feed.").waitFor();
  await owner.route("**/api/owner/requests/moderate", async (route) => { await sleep(800); await route.continue(); });
  await rowOf("Olga").getByRole("button", { name: /^Deny/ }).click();
  check((await owner.getByTestId("mod-note").count()) === 0, "the old note clears as soon as the next action starts");
  await rowOf("Olga").getByText("Denied").waitFor();
  await owner.unroute("**/api/owner/requests/moderate");
  check((await owner.evaluate(() => document.activeElement?.closest('[data-testid="feed-row"]')?.textContent.includes("Olga"))) === true, "focus stays on the row after a tap");
  check((await badge()) === "0", "old waiting request (beyond the newest 30) was actionable");

  // 6. Mode off: the listener's box disappears at its next refresh (the 30s re-check).
  await alice.reload();
  await alice.getByRole("heading", { name: "Request a song" }).waitFor();
  await owner.getByRole("radio", { name: /^Off/ }).click();
  await owner.waitForFunction(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.startsWith("Off"));
  check((await db.query("select value from settings where key = 'request_mode'")).rows[0].value === "off", "mode saved as off");
  check((await owner.getByRole("heading", { name: "Request a song" }).count()) === 0, "owner's own box follows the uncached mode (hidden when Off)");
  await alice.getByRole("heading", { name: "Request a song" }).waitFor({ state: "detached", timeout: 60000 });
  check(true, "listener's request box disappears on its next refresh");
  await owner.getByRole("radio", { name: /^Approve first/ }).click();
  await owner.waitForFunction(() => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.startsWith("Approve first"));
  check((await db.query("select value from settings where key = 'request_mode'")).rows[0].value === "approve", "Approve first is saved");
  check((await owner.getByRole("heading", { name: "Request a song" }).count()) === 1, "owner's own request box is back after leaving Off");
  await shot("owner-final");
  await layoutOk("final");

  // 7. Activity log shows every action.
  await owner.getByRole("tab", { name: "Activity" }).click();
  await owner.getByTestId("list-log").waitFor();
  const labels = await logLabels(owner);
  for (const want of ["Request approved", "Request denied", "Request removed", "Request kept in library", "Request mode changed"]) {
    check(labels.includes(want), `activity log has "${want}"`);
  }
  check(labels.filter((l) => l === "Request mode changed").length === 2, "both mode changes are logged");

  const real = errors.filter((e) => !/favicon|youtube|googlevideo|google|ERR_BLOCKED|Failed to load resource/i.test(e));
  check(real.length === 0, `no app console errors ${real.join(" | ")}`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
  youtubeStub.close();
  await db.end();
}
