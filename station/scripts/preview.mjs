// Makes docs/preview/ttunes-preview.png (1200x630) and @2x: two real listener screens (Afterglow look) and the request feed on one frame.
// Run from station/ with Docker up (npm run db:up): npm run preview
// Headless only. Uses a throwaway local database, YouTube Data API stubbed server-side, the real YouTube embed (needs internet).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { chromium } from "playwright";
import { freePort, startDevServer } from "../test/e2e/devServer.mjs";

const OUT = new URL("../../docs/preview/", import.meta.url).pathname;
const ADMIN_URL = process.env.PREVIEW_ADMIN_URL ?? "postgres://ttunes:ttunes@127.0.0.1:55432/postgres";
const DB_NAME = `preview_${process.pid}`;
const DB_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${DB_NAME}`);
if (!/@(localhost|127\.0\.0\.1)(:|\/)/.test(ADMIN_URL)) throw new Error("preview only runs against a local database");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real embeddable videos from the third-party "Audio Library" channel (audiolibrary.com.co, free-to-use tracks; a person appears in the artwork, no names); checked with yt-dlp playable_in_embed.
// App-side titles are just the track names; the embed shows the real video title.
const REQUESTED = { id: "UTX12uC5ExE", title: "Floating", sec: 128 };
const LIBRARY = [
  { id: "qD44TeHeLWY", title: "Like a Dream", sec: 252 },
  { id: "ZGn1YED6_Ic", title: "Salt Air", sec: 142 },
];
const catalog = Object.fromEntries([REQUESTED, ...LIBRARY].map((s) => [s.id, s]));
const youtubeStub = createServer((req, res) => {
  const ids = (new URL(req.url, "http://x").searchParams.get("id") ?? "").split(",");
  const items = ids.filter((id) => catalog[id]).map((id) => ({
    id, snippet: { title: catalog[id].title, categoryId: "10" },
    contentDetails: { duration: `PT${catalog[id].sec}S` }, status: { embeddable: true },
  }));
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ items }));
});
await new Promise((r) => youtubeStub.listen(0, "127.0.0.1", r));

const admin = new pg.Pool({ connectionString: ADMIN_URL });
await admin.query(`create database ${DB_NAME}`);
const TMP = join(tmpdir(), `ttunes-preview-${process.pid}`);
let db, server, browser;
try {
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}/`;
const env = { ...process.env, DATABASE_URL: DB_URL, SESSION_SECRET: "preview-secret-preview-secret-0123456", YOUTUBE_API_KEY: "stub", YOUTUBE_API_BASE_URL: `http://127.0.0.1:${youtubeStub.address().port}/youtube/v3` };
await new Promise((ok, bad) => spawn("npm", ["run", "db:migrate"], { env, stdio: "ignore" }).on("exit", (c) => (c === 0 ? ok() : bad(new Error("migrate failed")))));
db = new pg.Pool({ connectionString: DB_URL });
await db.query("update settings set value = 'open' where key = 'request_mode'");
for (const s of LIBRARY) await db.query("insert into songs (video_id, title, duration_sec) values ($1,$2,$3)", [s.id, s.title, s.sec]);

server = await startDevServer(PORT, env);
browser = await chromium.launch();
  mkdirSync(OUT, { recursive: true });
  const listener = async (viewport, scale) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
    const page = await context.newPage();
    await page.goto(BASE);
    await page.getByTestId("now-title").waitFor();
    return page;
  };
  // 1. A listener requests a song with a dedication (the real request box).
  const poster = await listener({ width: 1000, height: 900 }, 1);
  await poster.getByRole("button", { name: "Request a song", exact: true }).click();
  await poster.getByLabel("Your name").fill("3rd floor");
  await poster.getByLabel("Dedication (optional)").fill("for whoever's on the late shift");
  await poster.getByLabel("Song link").fill(`https://youtu.be/${REQUESTED.id}`);
  await poster.getByRole("button", { name: "Look up" }).click();
  await poster.getByRole("button", { name: "Send request" }).click(); // the looked-up song expands in place
  await poster.getByTestId("mine").waitFor();
  await poster.close();
  // 2. The current song ends; the request becomes Now playing for everyone.
  await db.query("update station_state set started_at_ms = started_at_ms - 400000");

  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const shoot = async (scale) => {
    const laptop = await listener({ width: 640, height: 900 }, scale);
    const phone = await listener({ width: 375, height: 812 }, scale);
    const feedPage = await listener({ width: 360, height: 900 }, scale); // narrow window: the feed card at full text size
    for (const p of [laptop, phone]) {
      await p.waitForFunction((t) => document.querySelector('[data-testid="now-title"]')?.textContent === t, REQUESTED.title);
      await p.getByRole("button", { name: "Play" }).click();
      await p.waitForFunction(() => window.__ttunes && window.__ttunes.currentTime() > 1.5, null, { timeout: 30_000 });
    }
    for (const p of [laptop, phone, feedPage]) {
      for (let i = 0; i < 6 && !(await p.getByText("Playing now").count()); i++) {
        await sleep(2000); await p.reload();
        if (p !== feedPage) { await p.getByRole("button", { name: "Play" }).click(); await p.waitForFunction(() => window.__ttunes && window.__ttunes.currentTime() > 1.5, null, { timeout: 30_000 }); }
      }
      if (p === feedPage) await p.getByRole("button", { name: "Request a song", exact: true }).click(); await sleep(1200); // the request feed lives in the drawer
      await p.mouse.move(0, 0); // keep the pointer off the player so YouTube's hover bars fade
    }
    await sleep(4500);
    const dir = TMP;
    mkdirSync(dir, { recursive: true });
    const clipTo = async (p, w) => {
      const bottom = async (sel) => { const b = await p.locator(sel).boundingBox(); return b.y + b.height; };
      return { x: 0, y: 0, width: w, height: Math.ceil(Math.max(await bottom(".titles"), await bottom(".player-frame")) + 16) };
    };
    const files = { laptopPng: join(dir, `laptop-${scale}.png`), phonePng: join(dir, `phone-${scale}.png`), feedPng: join(dir, `feed-${scale}.png`) };
    const clips = [await clipTo(laptop, 640), await clipTo(phone, 375)];
    const read = (p) => p.evaluate(() => window.__ttunes.currentTime());
    const [tLaptop, tPhone] = await Promise.all([read(laptop), read(phone)]); // same moment, each screen's own player
    await Promise.all([laptop.screenshot({ path: files.laptopPng, clip: clips[0] }), phone.screenshot({ path: files.phonePng, clip: clips[1] })]);
    await feedPage.locator(".feed-row").first().scrollIntoViewIfNeeded();
    const fb = await feedPage.locator(".feed").boundingBox();
    await feedPage.screenshot({ path: files.feedPng, clip: { x: Math.max(0, fb.x - 14), y: fb.y - 10, width: Math.min(360, fb.width + 28), height: fb.height + 20 } });
    for (const p of [laptop, phone, feedPage]) await p.context().close();
    console.log(`times: laptop ${tLaptop.toFixed(2)}s, phone ${tPhone.toFixed(2)}s (gap ${Math.abs(tLaptop - tPhone).toFixed(2)}s)`);
    return { ...files, laptopTime: mmss(tLaptop), phoneTime: mmss(tPhone), laptopSize: [clips[0].width, clips[0].height], phoneSize: [clips[1].width, clips[1].height] };
  };
  const compose = async (shots, scale) => {
    const frame = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: scale });
    const page = await frame.newPage();
    const html = (await import("./preview-frame.mjs")).frameHtml(shots);
    const file = join(TMP, `frame-${scale}.html`);
    writeFileSync(file, html);
    await page.goto(`file://${file}`);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    await page.screenshot({ path: `${OUT}ttunes-preview${scale === 2 ? "@2x" : ""}.png` });
    await frame.close();
  };
  for (const scale of [1, 2]) await compose(await shoot(scale), scale);
  console.log(`wrote ${OUT}ttunes-preview.png and @2x`);
} finally {
  await browser?.close();
  if (server) try { process.kill(-server.pid); } catch {}
  youtubeStub.close();
  await db?.end();
  rmSync(TMP, { recursive: true, force: true });
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.end();
}
