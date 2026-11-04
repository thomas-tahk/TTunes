// Browser check for the first drop into an EMPTY library (#14 follow-up). Needs the API (test/e2e-server.ts) and vite (proxying to it) running.
//   APP_URL=http://localhost:5199 API_URL=http://localhost:8797 node test/e2e/first-drop.cjs
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { load, dropFiles } = require("./lib.cjs");

const APP_URL = process.env.APP_URL;
const API_URL = process.env.API_URL;
if (!APP_URL || !API_URL) throw new Error("set APP_URL and API_URL");
const SHOT = process.env.SHOT; // optional screenshot path

const nowPlaying = (page) => page.locator(".playerbar__title").innerText();

(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(APP_URL);
  assert.equal((await (await fetch(`${API_URL}/api/tracks`)).json()).length, 0, "library must start empty");

  await dropFiles(page, ["A", "B", "C"].map((n) => load("tone.mp3", `${n}.mp3`, "audio/mpeg")));
  await page.getByText("Added 3 tracks").waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".playerbar__title").count() ? (await nowPlaying(page)).trim() : "", "", "nothing plays before the choice");
  if (SHOT) await page.screenshot({ path: SHOT });
  await page.getByText("Queue next").click();

  const order = [];
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(300);
    order.push(await nowPlaying(page));
    await page.getByTitle("Next").click();
  }
  assert.deepEqual(order, ["A", "B", "C"]);
  assert.deepEqual(errors, [], "no console errors");
  console.log("OK: first drop order", order.join(" -> "));
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
