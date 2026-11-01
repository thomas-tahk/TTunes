// M1 done-gate, one session from an EMPTY library: paste YouTube link, drop MP3, search + pick -> all "Queue last";
// they must play in that order, then >=3 more tracks must start with no clicks.
//   APP_URL=http://localhost:5251 API_URL=http://localhost:8951 [WIDTH=375] [SHOT=docs/milestones/M1-shots/gate] node test/e2e/done-gate.cjs
// Needs test/e2e-server.ts on API_URL (fake yt-dlp/search keyed by video id) and the UI on APP_URL. Restart the API for a fresh library.
const { chromium } = require("playwright");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const assert = require("node:assert/strict");

const APP_URL = process.env.APP_URL;
const API_URL = process.env.API_URL;
if (!APP_URL || !API_URL) throw new Error("set APP_URL and API_URL");
const WIDTH = Number(process.env.WIDTH) || 1280;
const SHOT = process.env.SHOT; // optional screenshot prefix; writes <SHOT>-<step>-<WIDTH>.png
const FIXTURES = join(__dirname, "..", "fixtures");
const shot = (page, step) => SHOT && page.screenshot({ path: `${SHOT}-${step}-${WIDTH}.png` });

async function dropMp3(page, name) {
  const base64 = readFileSync(join(FIXTURES, "tone.mp3")).toString("base64");
  await page.evaluate(({ name, base64 }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name, { type: "audio/mpeg" }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { name, base64 });
}

const tracks = async () => (await fetch(`${API_URL}/api/tracks`)).json();

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 800 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // Record every audio the app starts (src of each play() call), including repeats.
  await page.addInitScript(() => {
    window.__plays = [];
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.src && !this.closest?.("[class]")) window.__plays.push(this.src);
      return orig.apply(this, arguments);
    };
  });
  await page.goto(APP_URL);
  assert.equal((await tracks()).length, 0, "library must start empty (restart the API)");

  // 1. paste YouTube link
  await page.fill(".yt__input", "https://www.youtube.com/watch?v=fx000000001");
  await page.keyboard.press("Enter");
  await page.locator(".yt--confirm").waitFor();
  const ytTitle = await page.locator(".yt__field input").first().inputValue();
  await shot(page, "1-confirm");
  await page.getByText("Queue last").click();
  await page.locator(".yt--confirm").waitFor({ state: "detached" });

  // 2. drop MP3
  await dropMp3(page, "dropped-song.mp3");
  await page.getByText("Added 1 track").waitFor();
  await shot(page, "2-dropped");
  await page.getByText("Queue last").click();

  // 3. type a song name, 5 results, pick row 2
  await page.fill(".yt__input", "neon coast midnight drive");
  await page.keyboard.press("Enter");
  await page.locator(".yt__result").first().waitFor();
  assert.equal(await page.locator(".yt__result").count(), 5);
  await shot(page, "3-results");
  const pickTitle = await page.locator(".yt__result").nth(1).locator(".yt__result-title").innerText();
  await page.locator(".yt__result").nth(1).click();
  await page.locator(".yt--confirm").waitFor();
  await page.getByText("Queue last").click();
  await page.locator(".yt--confirm").waitFor({ state: "detached" });
  await shot(page, "4-added");

  const lib = await tracks();
  assert.equal(lib.length, 3, "three tracks in library");
  const byId = Object.fromEntries(lib.map((t) => [t.id, t.title]));
  const expected = [ytTitle, "dropped-song", pickTitle];

  // Let it play by itself: wait for >=6 play() starts (3 queued + 3 automatic), no clicks.
  await page.waitForFunction(() => window.__plays.length >= 6, null, { timeout: 30000 });
  await shot(page, "5-autoplay");
  const plays = (await page.evaluate(() => window.__plays)).map((src) => byId[new URL(src).pathname.split("/").pop().replace(/\..*$/, "")] ?? src);
  console.log(`[${WIDTH}px] play order:`, plays.join("  ->  "));
  assert.deepEqual(plays.slice(0, 3), expected, "first three plays are the three adds, in order");
  assert.ok(plays.length - 3 >= 3, "at least 3 more tracks auto-played");

  if (WIDTH <= 400) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `horizontal scroll of ${overflow}px at ${WIDTH}px`);
  }
  assert.deepEqual(errors, [], "no console errors");
  console.log(`PASS [${WIDTH}px]`);
  await browser.close();
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
