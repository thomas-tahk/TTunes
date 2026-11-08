// Done check for the Afterglow look: wash colours from the thumbnail (and the fallback), contrast, drawer, error/off-air states.
// Run from station/ with a FRESH local database:
//   docker compose exec -T db createdb -U ttunes <name>
//   DATABASE_URL=postgres://ttunes:ttunes@localhost:55432/<name> node test/e2e/afterglow.e2e.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
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

const env = { ...process.env, DATABASE_URL: DB_URL, SESSION_SECRET: SECRET, YOUTUBE_API_KEY: "stub" };
const run = (cmd) => new Promise((ok, bad) => spawn("npm", ["run", cmd], { env, stdio: "ignore" }).on("exit", (c) => (c === 0 ? ok() : bad(new Error(`${cmd} failed`)))));
await run("db:migrate");
const db = new pg.Pool({ connectionString: DB_URL });
await db.query("truncate queue, station_state, play_history, activity_log, songs, requests, request_attempts cascade");
const server = await startDevServer(PORT, env);
const { rows: [{ session_version: ver }] } = await db.query("select session_version from auth_state where id = 1");
const token = await new SignJWT({ ver }).setProtectedHeader({ alg: "HS256" }).setSubject("10647431").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));

const browser = await chromium.launch();
const errors = [];
const FALLBACK = ["#c93c00", "#c2185b", "#3d0b5c"];

// A bright picture (cyan/blue left, yellow right) drawn by the browser itself, so the test needs no image file.
async function brightPicture() {
  const page = await browser.newPage({ viewport: { width: 160, height: 90 } });
  await page.setContent('<body style="margin:0;background:linear-gradient(90deg,#00c8ff,#0047ff 50%,#ffe600)"></body>');
  const png = await page.screenshot();
  await page.close();
  return png;
}
const PICTURE = await brightPicture();

async function open({ viewport, owner = false, cors = true }) { // cors=false: the thumbnail request fails, as when it is blocked
  const context = await browser.newContext({ viewport });
  if (owner) await context.addCookies([{ name: "ttunes_session", value: token, url: BASE, httpOnly: true }]);
  await context.route("https://i.ytimg.com/**", (route) => (cors ? route.fulfill({ contentType: "image/png", body: PICTURE, headers: { "access-control-allow-origin": "*" } }) : route.abort()));
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return page;
}
const wash = (page) => page.evaluate(() => {
  const css = getComputedStyle(document.querySelector(".shell"));
  const hex = (v) => "#" + (css.getPropertyValue(v).match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  return ["--wash-hot", "--wash-mid", "--wash-deep"].map(hex);
});
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const whiteOn = (hex) => 1.05 / (lum(hex) + 0.05);
const shot = async (page, name, w, h) => {
  await page.setViewportSize({ width: w, height: h });
  await sleep(1800); // the background colour fades over 1.4s
  await page.screenshot({ path: `${SHOTS}afterglow-${name}-${w}.png` });
  console.log(`screenshot ${SHOTS}afterglow-${name}-${w}.png`);
};
const noScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

try {
  mkdirSync(SHOTS, { recursive: true });

  // Off air: library empty.
  const off = await open({ viewport: { width: 1280, height: 800 } });
  await off.goto(BASE);
  await off.getByRole("heading", { name: "Off air" }).waitFor();
  await shot(off, "offair", 1280, 800);
  await shot(off, "offair", 375, 812);
  check(await noScroll(off), "off air: no horizontal scroll at 375px");

  await db.query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Strawberry Letter 23',300),('seedSong002','Ain''t No Mountain High Enough',300)");

  // Error: the schedule fails to load.
  const bad = await open({ viewport: { width: 1280, height: 800 } });
  await bad.route("**/api/now**", (route) => route.fulfill({ status: 500, body: "{}" }));
  await bad.goto(BASE);
  await bad.getByRole("heading", { name: "Can't reach the station" }).waitFor();
  check((await bad.getByRole("button", { name: "Try again" }).count()) === 1, "error state keeps its Try again button");
  await shot(bad, "error", 375, 812);

  // Listener, thumbnail readable: the wash is taken from the picture and still passes AA.
  const listener = await open({ viewport: { width: 1280, height: 800 } });
  await listener.goto(BASE);
  await listener.getByTestId("now-title").waitFor();
  await sleep(2500); // thumbnail read, then the 1.4s fade
  const colours = await wash(listener);
  check(colours.every((c) => whiteOn(c) >= 4.5), `wash from thumbnail ${colours.join(" ")} all pass AA with white text`);
  check(colours.join() !== FALLBACK.join(), "wash differs from the fixed fallback gradient");
  await shot(listener, "listener", 1280, 800);
  await shot(listener, "listener", 375, 812);
  check(await noScroll(listener), "listener: no horizontal scroll at 375px");
  const frame = await listener.locator(".player-host").boundingBox();
  check(frame.height >= 200 && Math.abs(frame.width / frame.height - 16 / 9) < 0.03, `player is 16:9 and >= 200px tall (${frame.width}x${frame.height})`);

  // First-visit hint: shows, never covers the player, gone for good after dismiss + reload.
  await listener.setViewportSize({ width: 1280, height: 800 });
  const hint = listener.getByRole("region", { name: "Tip" });
  await hint.waitFor();
  check((await hint.textContent()).includes("Got a song? Request it here."), "first visit shows the request hint");
  check((await listener.getByRole("button", { name: "Request a song", exact: true }).count()) === 1, "tab is labelled Request a song");
  check((await listener.getByText("Anyone can request a song.").count()) === 1, "Up next shows 'Anyone can request a song.'");
  for (const [w, h] of [[1280, 800], [375, 812]]) {
    await listener.setViewportSize({ width: w, height: h });
    await sleep(200);
    const hb = await hint.boundingBox();
    const pf = await listener.locator(".player-frame").boundingBox();
    check(!(hb.x < pf.x + pf.width && pf.x < hb.x + hb.width && hb.y < pf.y + pf.height && pf.y < hb.y + hb.height), `hint @${w} does not cover the player`);
    await shot(listener, "hint", w, h);
  }
  await listener.setViewportSize({ width: 1280, height: 800 });
  await hint.getByRole("button", { name: "Close tip" }).click();
  check((await hint.count()) === 0, "hint closes on dismiss");
  await listener.reload();
  await listener.getByTestId("now-title").waitFor();
  await sleep(500);
  check((await listener.getByRole("region", { name: "Tip" }).count()) === 0, "hint stays gone after reload");
  const opener = await open({ viewport: { width: 1280, height: 800 } });
  await opener.goto(BASE);
  await opener.getByRole("region", { name: "Tip" }).waitFor();
  await opener.getByRole("button", { name: "Request a song", exact: true }).click();
  await opener.reload();
  await opener.getByTestId("now-title").waitFor();
  await sleep(500);
  check((await opener.getByRole("region", { name: "Tip" }).count()) === 0, "opening the drawer also retires the hint");
  check((await listener.getByRole("link", { name: /^Owner sign-in \(station owner only\)$/ }).count()) === 1, "footer owner sign-in link present");
  check((await listener.getByRole("link", { name: "Sign in", exact: true }).count()) === 0, "no header Sign in button");

  // Requests off: no hint, no request line, tab says Requests.
  await db.query("update settings set value = 'off' where key = 'request_mode'");
  const offPage = await open({ viewport: { width: 1280, height: 800 } });
  await offPage.goto(BASE);
  await offPage.getByRole("button", { name: "Requests", exact: true }).waitFor();
  await sleep(500);
  check((await offPage.getByRole("region", { name: "Tip" }).count()) === 0, "requests off: no hint");
  check((await offPage.getByText("Anyone can request a song.").count()) === 0, "requests off: request line hidden");
  await db.query("update settings set value = 'open' where key = 'request_mode'");

  // Drawer: listener view, keyboard, focus.
  await listener.setViewportSize({ width: 1280, height: 800 });
  const tab = listener.getByRole("button", { name: "Request a song", exact: true });
  check((await tab.getAttribute("aria-expanded")) === "false", "drawer starts closed");
  await tab.click();
  await listener.getByRole("heading", { name: "Request a song" }).waitFor();
  check((await playerClearOfDrawer(listener)).ok, "listener drawer open @1280: covers none of the player");
  await shot(listener, "listener-drawer", 1280, 800);
  await listener.keyboard.press("Escape");
  check((await tab.getAttribute("aria-expanded")) === "false", "Escape closes the drawer");
  check(await tab.evaluate((el) => el === document.activeElement), "focus returns to the yellow tab");
  await listener.setViewportSize({ width: 375, height: 812 });
  await tab.click(); // opened AT phone width
  await listener.getByRole("heading", { name: "Request a song" }).waitFor();
  await sleep(600);
  const inView = await playerInViewport(listener);
  check(inView.ok, `listener drawer open @375: player still inside the viewport (top ${Math.round(inView.box.y)})`);
  check((await playerClearOfDrawer(listener)).ok, "listener drawer open @375: sits below the player");
  check(await noScroll(listener), "listener drawer open @375: no horizontal scroll");
  await shot(listener, "listener-drawer", 375, 812);

  // Picture the browser cannot load or read: falls back to the fixed gradient, no console error from the app.
  const tainted = await open({ viewport: { width: 1280, height: 800 }, cors: false });
  await tainted.goto(BASE);
  await tainted.getByTestId("now-title").waitFor();
  await sleep(1500);
  check((await wash(tainted)).join() === FALLBACK.join(), "thumbnail unavailable: fixed magenta/orange/violet fallback");
  await shot(tainted, "fallback", 1280, 800);

  // Long title still fits and passes AA on the fallback.
  await db.query("update songs set title = 'A Very Long Song Title That Goes On And On (Official Extended Remastered Audio) feat. Many Guests' where video_id = 'seedSong001'");
  const long = await open({ viewport: { width: 375, height: 812 }, cors: false });
  await long.goto(BASE);
  await long.getByTestId("now-title").waitFor();
  check(await noScroll(long), "long title: no horizontal scroll at 375px");
  await shot(long, "long-title", 375, 812);
  check(FALLBACK.every((c) => whiteOn(c) >= 4.5), "fixed fallback colours pass AA");

  // Player size: the video area (inside the border) is >= 200px tall and 16:9 at every width, no sideways scroll.
  const sizes = await open({ viewport: { width: 1280, height: 800 } });
  await sizes.goto(BASE);
  await sizes.getByTestId("now-title").waitFor();
  await sizes.getByRole("button", { name: /^Play/ }).click(); // the real YouTube iframe (needs internet)
  await sizes.locator("iframe").waitFor({ state: "attached" });
  for (const [w, h] of [[1000, 800], [1100, 800], [1280, 800], [320, 700], [375, 812]]) {
    await sizes.setViewportSize({ width: w, height: h });
    await sleep(300);
    const host = await sizes.locator(".player-host").boundingBox();
    const ifr = await sizes.locator(".player-host iframe").boundingBox();
    check(host.height >= 200 && ifr.height >= 200 && ifr.width >= 200, `@${w}: player host ${Math.round(host.width)}x${Math.round(host.height)}, iframe ${Math.round(ifr.width)}x${Math.round(ifr.height)} (>= 200 tall)`);
    check(await noScroll(sizes), `@${w}: no horizontal scroll`);
  }
  await shot(sizes, "desktop", 1000, 800);

  // The bottom bar never covers the player: at scroll 0 and at the very bottom, on short and tall phones alike.
  for (const [w, h] of [[667, 375], [844, 390], [900, 600], [375, 812], [375, 667]]) {
    await sizes.setViewportSize({ width: w, height: h });
    await sleep(300);
    for (const at of ["top", "bottom"]) {
      await sizes.evaluate((where) => window.scrollTo(0, where === "top" ? 0 : document.documentElement.scrollHeight), at);
      await sleep(200);
      const hit = await sizes.evaluate(() => {
        const host = document.querySelector(".player-host").getBoundingClientRect();
        const covers = (sel) => [...document.querySelectorAll(sel)].some((el) => {
          const r = el.getBoundingClientRect();
          const on = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
          return on && r.left < host.right && host.left < r.right && r.top < host.bottom && host.top < r.bottom;
        });
        return { bar: covers(".drawer-tab"), hint: covers(".hint-bubble"), onScreen: host.top >= 0 && host.bottom <= window.innerHeight };
      });
      check(!hit.bar && !hit.hint, `@${w}x${h} scroll ${at}: nothing overlaps the player`);
      if (at === "top" && w === 900) check(hit.onScreen, `@${w}x${h}: whole player visible on first view`);
    }
    if (w === 667) {
      await sizes.evaluate(() => window.scrollTo(0, 0));
      await shot(sizes, "landscape", 667, 375);
    }
  }

  // Owner check is slow: nothing owner-or-listener-only flashes before /api/auth/me answers; owner never sees hint or link.
  for (const isOwner of [true, false]) {
    const slow = await open({ viewport: { width: 1280, height: 800 }, owner: isOwner });
    await slow.route("**/api/auth/me", async (route) => { await sleep(1500); await route.continue(); });
    await slow.goto(BASE);
    await slow.getByTestId("now-title").waitFor();
    await sleep(500);
    check((await slow.getByRole("region", { name: "Tip" }).count()) === 0 && (await slow.getByRole("link", { name: /^Owner sign-in/ }).count()) === 0, `${isOwner ? "owner" : "listener"}: no hint or sign-in link while /api/auth/me is pending`);
    await sleep(1500);
    if (isOwner) {
      await sleep(500);
      check((await slow.getByRole("region", { name: "Tip" }).count()) === 0 && (await slow.getByRole("link", { name: /^Owner sign-in/ }).count()) === 0, "owner: never sees the hint or sign-in link");
    } else {
      check((await slow.getByRole("region", { name: "Tip" }).count()) === 1 && (await slow.getByRole("link", { name: /^Owner sign-in/ }).count()) === 1, "listener: hint and link appear once /api/auth/me answers");
    }
  }

  // Hint is only for a working station: not on the error page.
  const errHint = await open({ viewport: { width: 1280, height: 800 } });
  await errHint.route("**/api/now**", (route) => route.fulfill({ status: 500, body: "{}" }));
  await errHint.goto(BASE);
  await errHint.getByRole("heading", { name: "Can't reach the station" }).waitFor();
  await sleep(500);
  check((await errHint.getByRole("region", { name: "Tip" }).count()) === 0, "error page: no hint");

  // Owner: drawer with tabs, both widths.
  const owner = await open({ viewport: { width: 1280, height: 800 }, owner: true });
  await owner.goto(BASE);
  await owner.getByTestId("now-title").waitFor();
  for (const [name, heading] of [["Requests", "Request a song"], ["Add song", "Add song"], ["Owner tools", "Controls"]]) {
    for (const [w, h] of [[1280, 800], [375, 812]]) {
      await owner.setViewportSize({ width: w, height: h });
      if ((await owner.locator(".drawer-tab").getAttribute("aria-expanded")) === "true") await owner.keyboard.press("Escape");
      await openDrawer(owner, name);
      await sleep(600);
      if (w === 375) check((await playerInViewport(owner)).ok, `owner "${name}" @375: opened at phone width, player still in the viewport`);
      await owner.getByRole("heading", { name: heading }).first().waitFor();
      check((await playerClearOfDrawer(owner)).ok, `owner "${name}" @${w}: player >= 200px tall, drawer covers none of it`);
      check(await noScroll(owner), `owner "${name}" @${w}: no horizontal scroll`);
      const small = await owner.evaluate(() => [...document.querySelectorAll(".drawer button:not([hidden] *)")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).length);
      check(small === 0, `owner "${name}" @${w}: every visible drawer button is >= 44px tall`);
      await shot(owner, `owner-${name.replace(" ", "-").toLowerCase()}`, w, h);
    }
  }
  const real = errors.filter((e) => !/favicon|youtube|googlevideo|google|ERR_BLOCKED|Failed to load resource|compute-pressure|Permissions policy/i.test(e));
  check(real.length === 0, `no app console errors ${real.join(" | ")}`);
  console.log("E2E PASS");
} finally {
  await browser.close();
  server.kill();
  await db.end();
}
