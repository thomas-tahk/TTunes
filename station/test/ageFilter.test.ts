import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ownerApi from "../api/owner.ts";
import requestsApi from "../api/requests.ts";
import { AGE_RESTRICTED_MESSAGE } from "../lib/addSong.ts";
import { SESSION_COOKIE, issueSession } from "../lib/auth.ts";
import { createDb, sharedDb } from "../lib/db.ts";
import { migrate } from "../lib/migrate.ts";
import { getNowPlaying } from "../lib/schedule.ts";

let server: Server;
let base: string;
const realFetch = globalThis.fetch;
let searchUrls: string[] = [];
const videos: Record<string, { title: string; restricted: boolean }> = {
  cleanVid001: { title: "Clean", restricted: false },
  adultVid001: { title: "Adult", restricted: true },
};
const TABLES = "queue, station_state, play_history, activity_log, songs, requests, request_attempts, preview_attempts, search_attempts";

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  process.env.YOUTUBE_API_KEY = "test-key";
  const db = createDb();
  await migrate(db);
  await db.end();
  server = createServer((req, res) => void (new URL(req.url!, "http://x").pathname.startsWith("/api/owner") ? ownerApi : requestsApi)(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await sharedDb().query(`truncate ${TABLES} cascade`);
  server.close();
  await sharedDb().end();
});
beforeEach(async () => {
  searchUrls = [];
  await sharedDb().query(`truncate ${TABLES} cascade`);
  await sharedDb().query("update settings set value = 'open' where key = 'request_mode'");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "www.googleapis.com") return realFetch(input, init);
    if (url.pathname.endsWith("/search")) {
      searchUrls.push(url.toString());
      return Response.json({ items: Object.keys(videos).map((videoId) => ({ id: { videoId }, snippet: {} })) });
    }
    const ids = url.searchParams.get("id")!.split(",").filter((id) => videos[id]);
    return Response.json({
      items: ids.map((id) => ({
        id,
        snippet: { title: videos[id]!.title, channelTitle: "Artist", categoryId: "10" },
        contentDetails: { duration: "PT3M", ...(videos[id]!.restricted ? { contentRating: { ytRating: "ytAgeRestricted" } } : {}) },
        status: { embeddable: true },
      })),
    });
  });
});

const ownerCookie = async () => `${SESSION_COOKIE}=${encodeURIComponent(await issueSession(sharedDb()))}`;
const post = (path: string, body: object, headers: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("age-restricted videos", () => {
  it("listener preview refuses with the listener-facing message", async () => {
    const res = await fetch(`${base}/api/requests/preview?link=adultVid001`, { headers: { "x-forwarded-for": "1.1.1.1" } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: AGE_RESTRICTED_MESSAGE, code: "age_restricted" });
    expect(AGE_RESTRICTED_MESSAGE).toBe("That video is age-restricted, so it can't be requested.");
  });

  it("listener preview still accepts a clean video", async () => {
    const res = await fetch(`${base}/api/requests/preview?link=cleanVid001`, { headers: { "x-forwarded-for": "1.1.1.1" } });
    expect(res.status).toBe(200);
  });

  it("listener request refuses and stores nothing", async () => {
    const res = await post("/api/requests", { link: "adultVid001", name: "Sam" }, { "x-forwarded-for": "2.2.2.2" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: AGE_RESTRICTED_MESSAGE, code: "age_restricted" });
    expect((await sharedDb().query("select 1 from requests")).rowCount).toBe(0);
  });

  it("owner preview is not filtered", async () => {
    const preview = await post("/api/owner/preview", { url: "adultVid001" }, { cookie: await ownerCookie() });
    expect(preview.status).toBe(200);
  });

  it("listener search sends safeSearch=strict; owner search does not", async () => {
    await fetch(`${base}/api/requests/search?q=song`, { headers: { "x-forwarded-for": "3.3.3.3" } });
    await fetch(`${base}/api/owner/search?q=song`, { headers: { cookie: await ownerCookie() } });
    expect(searchUrls).toHaveLength(2);
    expect(new URL(searchUrls[0]!).searchParams.get("safeSearch")).toBe("strict");
    expect(new URL(searchUrls[1]!).searchParams.has("safeSearch")).toBe(false);
  });

  it("a queued age-restricted request is denied at play time and the next one plays", async () => {
    const add = "insert into requests (video_id, title, duration_sec, name, status, listener_id, queued_at) values ($1, 'T', 100, 'Sam', 'queued', 'l', now() - $2::interval)";
    await sharedDb().query(add, ["adultVid001", "2 minutes"]);
    await sharedDb().query(add, ["cleanVid001", "1 minute"]);
    const now = await getNowPlaying(sharedDb(), Date.now);
    expect(now.current?.videoId).toBe("cleanVid001");
    const rows = (await sharedDb().query("select video_id, status from requests order by id")).rows.map((r) => `${r.video_id}:${r.status}`);
    expect(rows).toEqual(["adultVid001:denied", "cleanVid001:playing"]);
    expect((await sharedDb().query("select 1 from activity_log where what = 'request_age_restricted'")).rowCount).toBe(1);
  });
});
