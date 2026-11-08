import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import requestsApi from "../api/requests.ts";
import { createDb, sharedDb } from "../lib/db.ts";
import { MAX_PREVIEWS_PER_DAY, MAX_PREVIEWS_PER_HOUR } from "../lib/listenerPreview.ts";
import { migrate } from "../lib/migrate.ts";
import { DAILY_LOOKUP_CAP, purgeOldIpHashes } from "../lib/requests.ts";

let server: Server;
let base: string;
const realFetch = globalThis.fetch;
let videoCalls = 0;
const videos: Record<string, { title: string; embeddable: boolean; duration: string }> = {
  goodVideo01: { title: "Good Song", embeddable: true, duration: "PT4M" },
  blockedVid1: { title: "Blocked", embeddable: false, duration: "PT4M" },
};

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  process.env.YOUTUBE_API_KEY = "test-key";
  const db = createDb();
  await migrate(db);
  await db.end();
  server = createServer((req, res) => void requestsApi(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await sharedDb().query("truncate preview_attempts, request_attempts, requests cascade"); // leave the shared test DB clean for the files that follow
  server.close();
  await sharedDb().end();
});
beforeEach(async () => {
  videoCalls = 0;
  await sharedDb().query("truncate preview_attempts, request_attempts, requests cascade");
  await sharedDb().query("update settings set value = 'open' where key = 'request_mode'");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "www.googleapis.com") return realFetch(input, init);
    videoCalls++;
    const ids = url.searchParams.get("id")!.split(",").filter((id) => videos[id]);
    return Response.json({
      items: ids.map((id) => ({ id, snippet: { title: videos[id]!.title, channelTitle: "Artist", categoryId: "10" }, contentDetails: { duration: videos[id]!.duration }, status: { embeddable: videos[id]!.embeddable } })),
    });
  });
});

const preview = (ip: string, link: string, cookie?: string) =>
  fetch(`${base}/api/requests/preview?link=${encodeURIComponent(link)}`, { headers: { "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) } });
const attempts = async (table: string) => (await sharedDb().query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

describe("GET /api/requests/preview", () => {
  it("returns the song's card data, uncached, from one lookup", async () => {
    const res = await preview("1.1.1.1", "https://youtu.be/goodVideo01?t=4");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ videoId: "goodVideo01", title: "Good Song", channelTitle: "Artist", durationSec: 240, thumbnail: "https://i.ytimg.com/vi/goodVideo01/hqdefault.jpg" });
    expect(videoCalls).toBe(1);
  });

  it("rejects a non-link without counting or calling YouTube", async () => {
    const res = await preview("1.1.1.1", "not a link");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("bad_link");
    expect(videoCalls).toBe(0);
    expect(await attempts("preview_attempts")).toBe(0);
  });

  it("refuses an embed-blocked video and an unknown one with the server's words", async () => {
    const blocked = await preview("1.1.1.1", "blockedVid1");
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).error).toContain("embedding is blocked");
    expect((await preview("1.1.1.1", "missingVid1")).status).toBe(404);
  });

  it("is refused while requests are off", async () => {
    await sharedDb().query("update settings set value = 'off' where key = 'request_mode'");
    const res = await preview("1.1.1.1", "goodVideo01");
    expect(res.status).toBe(403);
    expect(videoCalls).toBe(0);
  });

  it("has its own hourly limit per cookie and never touches the 5-requests allowance", async () => {
    const first = await preview("2.2.2.2", "goodVideo01");
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    for (let i = 1; i < MAX_PREVIEWS_PER_HOUR; i++) expect((await preview(`9.9.9.${i}`, "goodVideo01", cookie)).status).toBe(200);
    const over = await preview("9.9.9.99", "goodVideo01", cookie);
    expect(over.status).toBe(429);
    expect((await over.json()).code).toBe("rate_limited");
    expect(videoCalls).toBe(MAX_PREVIEWS_PER_HOUR);
    expect(await attempts("request_attempts")).toBe(0);
  });

  it("previews count toward the shared daily lookup cap, and the cap pauses them", async () => {
    await sharedDb().query("insert into request_attempts (listener_id, ip_hash, at) select 'l' || g, 'h' || g, now() from generate_series(1, $1) g", [DAILY_LOOKUP_CAP - 1]);
    expect((await preview("3.3.3.3", "goodVideo01")).status).toBe(200);
    const paused = await preview("4.4.4.4", "goodVideo01");
    expect(paused.status).toBe(503);
    expect((await paused.json()).code).toBe("paused");
  });

  it("previews have their own daily cap inside the shared one", async () => {
    await sharedDb().query("insert into preview_attempts (listener_id, ip_hash, at) select 'l' || g, 'h' || g, now() from generate_series(1, $1) g", [MAX_PREVIEWS_PER_DAY]);
    const res = await preview("5.5.5.5", "goodVideo01");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("Link checks are paused");
    expect(videoCalls).toBe(0);
  });

  it("a full day of previews pauses requests too (they share the 2000 lookups)", async () => {
    await sharedDb().query("insert into preview_attempts (listener_id, ip_hash, at) select 'l' || g, 'h' || g, now() from generate_series(1, $1) g", [DAILY_LOOKUP_CAP]);
    const res = await fetch(`${base}/api/requests`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "6.6.6.6" }, body: JSON.stringify({ link: "goodVideo01", name: "Ann" }) });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("paused");
  });

  it("the daily cleanup deletes preview attempts older than 7 days and keeps recent ones", async () => {
    await sharedDb().query("insert into preview_attempts (listener_id, ip_hash, at) values ('old', 'h', now() - interval '8 days'), ('fresh', 'h', now() - interval '1 hour')");
    await purgeOldIpHashes(sharedDb(), Date.now);
    expect((await sharedDb().query("select listener_id from preview_attempts")).rows).toEqual([{ listener_id: "fresh" }]);
  });

  it("only allows GET", async () => {
    expect((await fetch(`${base}/api/requests/preview`, { method: "POST" })).status).toBe(405);
  });
});
