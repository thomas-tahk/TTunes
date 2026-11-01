// Drives the real UI: search -> click row 2 -> confirm card -> Discard keeps list -> row 2 again -> Queue last.
// Usage: APP_URL=http://localhost:8797 API_URL=http://localhost:8796 node test/e2e/search.cjs
// Needs test/e2e-server.ts on API_URL and vite (proxying to it) on APP_URL. Uses preinstalled playwright.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const APP_URL = process.env.APP_URL ?? "http://localhost:8797";
const API_URL = process.env.API_URL ?? "http://localhost:8796";
const SHOT = process.env.SHOT; // optional screenshot path

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(APP_URL);
  await page.fill(".yt__input", "neon coast – midnight drive");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".yt__result");
  assert.equal(await page.locator(".yt__result").count(), 5);
  if (SHOT) await page.screenshot({ path: SHOT });

  const row2 = page.locator(".yt__result").nth(1);
  const row2Title = await row2.locator(".yt__result-title").innerText();
  await row2.click();
  await page.waitForSelector(".yt--confirm");
  assert.equal(await page.locator(".yt__field input").first().inputValue(), row2Title);
  console.log("card title matches row 2:", row2Title);

  await page.getByRole("button", { name: /discard/i }).click();
  await page.waitForSelector(".yt__result");
  assert.equal(await page.locator(".yt__result").count(), 5);
  console.log("discard returned to the 5-row list");

  await page.locator(".yt__result").nth(1).click();
  await page.waitForSelector(".yt--confirm");
  await page.getByRole("button", { name: /queue last/i }).click();
  await page.waitForSelector(".yt--confirm", { state: "detached" });
  assert.equal(await page.locator(".yt__result").count(), 0);
  const titles = (await (await fetch(`${API_URL}/api/tracks`)).json()).map((t) => t.title);
  assert.deepEqual(titles, [row2Title]);
  console.log("in library:", titles, "- hits cleared after add");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
