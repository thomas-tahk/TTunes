import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ownerApi from "../api/owner.ts";
import requestsApi from "../api/requests.ts";
import { SESSION_COOKIE, issueSession } from "../lib/auth.ts";
import { createDb, sharedDb } from "../lib/db.ts";
import { pacificDayStart, SEARCH_PAUSED_MESSAGE } from "../lib/listenerSearch.ts";
import { migrate } from "../lib/migrate.ts";
import { purgeOldIpHashes, setMode } from "../lib/requests.ts";

let server: Server;
let base: string;
const realFetch = globalThis.fetch;
let searchCalls = 0;
let searchStatus: { status: number; reason: string } | null = null;
const videos: Record<string, { title: string; channel: string; category: string }> = {
  mv: { title: "Song (Official Video)", channel: "Artist", category: "10" },
  topic: { title: "Song", channel: "Artist - Topic", category: "10" },
  vlog: { title: "Song reaction", channel: "Someone", category: "22" },
};
const order = ["vlog", "mv", "topic"];

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  process.env.YOUTUBE_API_KEY = "test-key";
  const db = createDb();
  await migrate(db);
  await db.end();
  const routes = { "/api/requests/search": requestsApi, "/api/owner/search": ownerApi } as const;
  server = createServer((req, res) => void routes[new URL(req.url!, "http://x").pathname as keyof typeof routes]?.(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await sharedDb().end();
});
beforeEach(async () => {
  searchCalls = 0;
  searchStatus = null;
  await sharedDb().query("truncate search_attempts, activity_log cascade");
  await sharedDb().query("update settings set value = 'open' where key = 'request_mode'");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "www.googleapis.com") return realFetch(input, init);
    if (url.pathname.endsWith("/search")) {
      searchCalls++;
      if (searchStatus) return Response.json({ error: { errors: [{ reason: searchStatus.reason }] } }, { status: searchStatus.status });
      return Response.json({ items: order.map((videoId) => ({ id: { videoId }, snippet: { thumbnails: { medium: { url: `https://t/${videoId}` } } } })) });
    }
    const ids = url.searchParams.get("id")!.split(",").filter((id) => videos[id]);
    return Response.json({
      items: ids.map((id) => ({ id, snippet: { title: videos[id]!.title, channelTitle: videos[id]!.channel, categoryId: videos[id]!.category }, contentDetails: { duration: "PT4M" }, status: { embeddable: true } })),
    });
  });
});

const listenerSearch = (ip: string, q = "song", cookie?: string) =>
  fetch(`${base}/api/requests/search?q=${encodeURIComponent(q)}`, { headers: { "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) } });
const ownerSearch = async () => fetch(`${base}/api/owner/search?q=song`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(await issueSession(sharedDb()))}` } });
const fillBudget = (n: number) =>
  sharedDb().query("insert into search_attempts (listener_id, ip_hash, at) select 'l' || g, 'h' || g, now() from generate_series(1, $1) g", [n]);

describe("GET /api/requests/search", () => {
  it("returns the owner search's ranking with the frozen shape, uncached", async () => {
    const res = await listenerSearch("1.1.1.1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    const owner = await (await ownerSearch()).json();
    expect(body.results.map((r: { videoId: string }) => r.videoId)).toEqual(["topic", "mv", "vlog"]);
    expect(body.results.map((r: { videoId: string }) => r.videoId)).toEqual(owner.results.map((r: { videoId: string }) => r.videoId));
    expect(Object.keys(body.results[0]).sort()).toEqual(["channelTitle", "durationSec", "thumbnail", "title", "videoId"]);
  });

  it("rejects an empty or over-long query without counting or calling YouTube", async () => {
    for (const q of ["", "   ", "x".repeat(101)]) {
      const res = await listenerSearch("1.1.1.1", q);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("bad_query");
    }
    expect(searchCalls).toBe(0);
    expect((await sharedDb().query("select count(*)::int as n from search_attempts")).rows[0].n).toBe(0);
  });

  it("the 6th search in an hour from one cookie is 429 and never reaches YouTube", async () => {
    const first = await listenerSearch("2.2.2.2");
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    for (let i = 0; i < 4; i++) expect((await listenerSearch(`9.9.9.${i}`, "song", cookie)).status).toBe(200);
    expect(searchCalls).toBe(5);
    const sixth = await listenerSearch("9.9.9.9", "song", cookie);
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).code).toBe("rate_limited");
    expect(searchCalls).toBe(5);
  });

  it("the hourly limit also holds per network when the cookie is dropped", async () => {
    for (let i = 0; i < 5; i++) expect((await listenerSearch("3.3.3.3")).status).toBe(200);
    expect((await listenerSearch("3.3.3.3")).status).toBe(429);
    expect((await listenerSearch("4.4.4.4")).status).toBe(200);
  });

  it("after the daily listener budget is used, listeners get the plain message and the owner still searches", async () => {
    await fillBudget(60);
    const res = await listenerSearch("5.5.5.5");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Search is resting for today — paste a YouTube link instead.", code: "search_paused" });
    expect(searchCalls).toBe(0);
    expect((await ownerSearch()).status).toBe(200);
  });

  it("the last budgeted search succeeds (59 used -> 200), the next is paused", async () => {
    await fillBudget(60 - 1);
    expect((await listenerSearch("6.6.6.6")).status).toBe(200);
    expect((await listenerSearch("7.7.7.7")).status).toBe(503);
  });

  it("concurrent searches cannot overshoot the budget", async () => {
    await fillBudget(60 - 3);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => listenerSearch(`10.0.0.${i}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 503)).toHaveLength(9);
    expect(searchCalls).toBe(3);
    expect((await sharedDb().query("select count(*)::int as n from search_attempts")).rows[0].n).toBe(60);
  });

  it("yesterday's (Pacific) attempts do not count against today", async () => {
    await sharedDb().query("insert into search_attempts (listener_id, ip_hash, at) select 'l' || g, 'h' || g, $2 from generate_series(1, $1) g", [60, new Date(pacificDayStart(Date.now()) - 60_000)]);
    expect((await listenerSearch("8.8.8.8")).status).toBe(200);
  });

  it("mode off is 403 and does not count or call YouTube", async () => {
    await setMode(sharedDb(), "off");
    const res = await listenerSearch("1.2.3.4");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("off");
    expect(searchCalls).toBe(0);
    expect((await sharedDb().query("select count(*)::int as n from search_attempts")).rows[0].n).toBe(0);
  });

  it("YouTube's daily search quota used up says search_paused", async () => {
    searchStatus = { status: 403, reason: "quotaExceeded" };
    const res = await listenerSearch("1.2.3.4");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("search_paused");
    expect(body.error).toBe(SEARCH_PAUSED_MESSAGE);
    expect((await sharedDb().query("select count(*)::int as n from search_attempts")).rows[0].n).toBe(1);
  });

  it("counts the attempt when YouTube is merely rate-limiting, and says youtube_unavailable", async () => {
    searchStatus = { status: 403, reason: "rateLimitExceeded" };
    const res = await listenerSearch("1.2.3.4");
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("youtube_unavailable");
    expect((await sharedDb().query("select count(*)::int as n from search_attempts")).rows[0].n).toBe(1);
  });

  it("the daily cron purge deletes search attempts older than 7 days", async () => {
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    await sharedDb().query("insert into search_attempts (listener_id, ip_hash, at) values ('a','b',$1), ('c','d',now())", [old]);
    await purgeOldIpHashes(sharedDb(), Date.now);
    expect((await sharedDb().query("select listener_id from search_attempts")).rows.map((r) => r.listener_id)).toEqual(["c"]);
  });
});

describe("pacificDayStart", () => {
  it("is midnight Pacific in winter (UTC-8) and summer (UTC-7), and on DST change days", () => {
    expect(pacificDayStart(Date.UTC(2026, 0, 15, 12))).toBe(Date.UTC(2026, 0, 15, 8));
    expect(pacificDayStart(Date.UTC(2026, 6, 15, 5))).toBe(Date.UTC(2026, 6, 14, 7)); // 22:00 on the 14th Pacific
    expect(pacificDayStart(Date.UTC(2026, 2, 8, 20))).toBe(Date.UTC(2026, 2, 8, 8)); // spring forward day
    expect(pacificDayStart(Date.UTC(2026, 10, 1, 20))).toBe(Date.UTC(2026, 10, 1, 7)); // fall back day
  });
});
