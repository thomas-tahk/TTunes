// Browser check for #16. Needs a running app: API_URL (e2e server) and APP_URL (vite proxied to it).
//   PORT=8798 npx tsx test/e2e-server.ts
//   TTUNES_API_PORT=8798 npx vite --port 5188
//   API_URL=http://localhost:8798 APP_URL=http://localhost:5188 node test/e2e/never-silent.cjs
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const API_URL = process.env.API_URL;
const APP_URL = process.env.APP_URL;
const SHOT = process.env.SHOT; // optional screenshot path

async function upload(title) {
  const form = new FormData();
  const bytes = fs.readFileSync(path.join(__dirname, "../fixtures/tone.mp3"));
  form.append("file", new Blob([bytes], { type: "audio/mpeg" }), `${title}.mp3`);
  const res = await fetch(`${API_URL}/api/tracks`, { method: "POST", body: form });
  return (await res.json()).id;
}

(async () => {
  if (!API_URL || !APP_URL) throw new Error("set API_URL and APP_URL");
  const ids = {};
  for (const title of ["A", "B", "C"]) ids[title] = await upload(title);
  const titleOf = (src) => Object.keys(ids).find((t) => src.endsWith(ids[t]));

  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    window.__played = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.__played.push(this.src);
      return play.call(this);
    };
  });
  await page.goto(APP_URL);
  await page.waitForSelector(".row");
  await page.waitForFunction(() => window.__played.length >= 1);

  // Queue one track that is not the one playing; it must be next.
  const queuedTitle = await page.locator(".row:not(.row--playing) .row__title").first().textContent();
  const exactTitle = page.locator(".row__title", { hasText: new RegExp(`^${queuedTitle}$`) });
  await page.locator(".row").filter({ has: exactTitle }).locator(".row__queue").click();

  await page.waitForFunction(() => window.__played.length >= 6, null, { timeout: 30000 });
  const order = (await page.evaluate(() => window.__played)).map(titleOf);
  console.log("play order:", order.join(" > "), `(queued: ${queuedTitle})`);
  if (SHOT) await page.screenshot({ path: SHOT });
  await browser.close();

  const failures = [];
  if (order[1] !== queuedTitle) failures.push("queued track was not next");
  if (new Set(order.slice(0, 3)).size !== 3) failures.push("repeat inside the first cycle");
  order.slice(1).forEach((t, i) => t === order[i] && failures.push(`back-to-back repeat at ${i + 1}`));
  if (errors.length) failures.push(`console errors: ${errors.join(" | ")}`);
  if (failures.length) throw new Error(failures.join("; "));
  console.log("OK: >=5 automatic changes, queue honoured, no repeat within a cycle");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
