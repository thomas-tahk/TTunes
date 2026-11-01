// Browser check for #14. Needs the API (test/e2e-server.ts) and vite (proxying to it) running.
//   APP_URL=http://localhost:5199 API_URL=http://localhost:8797 node test/e2e/drop.cjs
const { chromium } = require("playwright");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const assert = require("node:assert/strict");

const APP_URL = process.env.APP_URL;
const API_URL = process.env.API_URL;
if (!APP_URL || !API_URL) throw new Error("set APP_URL and API_URL");
const FIXTURES = join(__dirname, "..", "fixtures");
const SHOT = join(__dirname, "..", "..", "docs", "milestones", "M1-shots", "14-drop.png");

const load = (fixture, name, type) => ({ name, type, base64: readFileSync(join(FIXTURES, fixture)).toString("base64") });

// Dispatches a real `drop` DragEvent on window with a DataTransfer holding the files, in order.
async function dropFiles(page, files) {
  await page.evaluate((specs) => {
    const dt = new DataTransfer();
    for (const s of specs) {
      const bytes = Uint8Array.from(atob(s.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], s.name, { type: s.type }));
    }
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

const nowPlaying = (page) => page.locator(".playerbar__title").innerText();

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(APP_URL);

  // Seed one track and make it current so "Queue next" really queues.
  await dropFiles(page, [load("tone.mp3", "seed.mp3", "audio/mpeg")]);
  await page.getByText("Queue last").click();
  await page.locator(".playerbar__title", { hasText: "seed" }).waitFor();

  await dropFiles(page, [
    load("tone.mp4", "first-video.mp4", "video/mp4"),
    load("tone.mp3", "second.mp3", "audio/mpeg"),
    load("notes.txt", "notes.txt", "text/plain"),
    load("tone.mp3", "third.mp3", "audio/mpeg"),
  ]);
  await page.getByText("Added 3 tracks").waitFor();
  assert.deepEqual(await page.locator("[role=alert]").allTextContents(), ["notes.txt: That file isn't audio or video."]);
  await page.screenshot({ path: SHOT });
  await page.getByText("Queue next").click();

  const order = [];
  for (let i = 0; i < 3; i++) {
    await page.getByTitle("Next").click();
    await page.waitForTimeout(300);
    order.push(await nowPlaying(page));
  }
  assert.deepEqual(order, ["first-video", "second", "third"]);

  const tracks = await (await fetch(`${API_URL}/api/tracks`)).json();
  assert.equal(tracks.length, 4);
  assert.ok(tracks.every((t) => /\.(mp3|m4a)$/.test(t.storageKey)), "only audio files stored");
  console.log("OK: queue order", order.join(" -> "), "| stored:", tracks.map((t) => t.storageKey.split(".").pop()).join(","));
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
