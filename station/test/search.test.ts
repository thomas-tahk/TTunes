import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import search from "../api/owner.ts";
import { issueSession, SESSION_COOKIE } from "../lib/auth.ts";
import { createDb, sharedDb } from "../lib/db.ts";
import { migrate } from "../lib/migrate.ts";
import { rankResults } from "../lib/search.ts";

interface Vid { title: string; channel: string; category: string; duration: string; embeddable?: boolean }
let server: Server;
let base: string;
const realFetch = globalThis.fetch;
const calls: URL[] = [];
let order: string[] = []; // video ids search.list returns, in order
let videos: Record<string, Vid> = {};
let searchStatus: { status: number; reason: string } | null = null;
let videosStatus: { status: number; reason: string } | null = null;

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  process.env.YOUTUBE_API_KEY = "test-key";
  const db = createDb();
  await migrate(db);
  await db.end();
  server = createServer((req: IncomingMessage, res: ServerResponse) => void search(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await sharedDb().end();
});
beforeEach(() => {
  calls.length = 0;
  order = [];
  videos = {};
  searchStatus = null;
  videosStatus = null;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "www.googleapis.com") {
      if (!String(input).startsWith(base)) throw new Error(`unstubbed network call: ${input}`);
      return realFetch(input, init);
    }
    calls.push(url);
    if (url.pathname.endsWith("/search")) {
      if (searchStatus) return Response.json({ error: { errors: [{ reason: searchStatus.reason }] } }, { status: searchStatus.status });
      return Response.json({ items: order.map((videoId) => ({ id: { videoId }, snippet: { thumbnails: { medium: { url: `https://t/${videoId}` } } } })) });
    }
    if (videosStatus) return Response.json({ error: { errors: [{ reason: videosStatus.reason }] } }, { status: videosStatus.status });
    const ids = url.searchParams.get("id")!.split(",").filter((id) => videos[id]);
    return Response.json({
      items: ids.map((id) => ({
        id,
        snippet: { title: videos[id]!.title, channelTitle: videos[id]!.channel, categoryId: videos[id]!.category },
        contentDetails: { duration: videos[id]!.duration },
        status: { embeddable: videos[id]!.embeddable ?? true },
      })),
    });
  });
});

const ownerCookie = async () => `${SESSION_COOKIE}=${encodeURIComponent(await issueSession(sharedDb()))}`;
const get = async (q: string, owner = true) =>
  fetch(`${base}/api/owner/search?q=${encodeURIComponent(q)}`, { headers: owner ? { cookie: await ownerCookie() } : {} });

it("ranks a Topic upload above a music video for the same song", async () => {
  order = ["mv", "topic"];
  videos = {
    mv: { title: "Song (Official Video)", channel: "Artist", category: "10", duration: "PT4M" },
    topic: { title: "Song", channel: "Artist - Topic", category: "10", duration: "PT4M" },
  };
  const body = await (await get("artist song")).json();
  expect(body.results.map((r: { videoId: string }) => r.videoId)).toEqual(["topic", "mv"]);
  expect(body.results[0]).toEqual({
    videoId: "topic", title: "Song", channelTitle: "Artist - Topic", durationSec: 240, categoryId: "10", thumbnail: "https://t/topic", isTopic: true,
  });
  const s = calls.find((u) => u.pathname.endsWith("/search"))!;
  expect(Object.fromEntries(s.searchParams)).toMatchObject({ part: "snippet", type: "video", videoEmbeddable: "true", maxResults: "15", q: "artist song" });
});

it("keeps a Gaming-category soundtrack", async () => {
  order = ["ost"];
  videos = { ost: { title: "Main Theme", channel: "Game OST", category: "20", duration: "PT3M" } };
  const body = await (await get("game theme")).json();
  expect(body.results).toHaveLength(1);
  expect(body.results[0].categoryId).toBe("20");
});

it("drops unembeddable and zero-length results", async () => {
  order = ["ok", "noembed", "live", "gone"];
  videos = {
    ok: { title: "ok", channel: "c", category: "10", duration: "PT1M" },
    noembed: { title: "x", channel: "c", category: "10", duration: "PT1M", embeddable: false },
    live: { title: "y", channel: "c", category: "10", duration: "P0D" },
  };
  const body = await (await get("q")).json();
  expect(body.results.map((r: { videoId: string }) => r.videoId)).toEqual(["ok"]);
});

it("maps a quota error to 429 with the plain message", async () => {
  searchStatus = { status: 403, reason: "quotaExceeded" };
  const res = await get("q");
  expect(res.status).toBe(429);
  expect((await res.json()).error).toBe("Search limit for today is used up — paste a YouTube link instead, or try again tomorrow.");
  expect(res.headers.get("cache-control")).toBe("no-store");
});

it("a rate limit or a videos.list quota error says YouTube is busy, not that the daily search limit is used up", async () => {
  searchStatus = { status: 403, reason: "rateLimitExceeded" };
  const rate = await get("q");
  expect(rate.status).toBe(503);
  expect((await rate.json()).error).toBe("YouTube is busy — try again shortly.");
  searchStatus = null;
  order = ["ok"];
  videosStatus = { status: 403, reason: "quotaExceeded" };
  const detail = await get("q");
  expect(detail.status).toBe(503);
  expect((await detail.json()).error).toBe("YouTube is busy — try again shortly.");
});

it("drops a result whose duration YouTube sent in an unparseable form", async () => {
  order = ["ok", "weird"];
  videos = {
    ok: { title: "ok", channel: "c", category: "10", duration: "PT1M" },
    weird: { title: "w", channel: "c", category: "10", duration: "garbage" },
  };
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const body = await (await get("q")).json();
    expect(body.results.map((r: { videoId: string }) => r.videoId)).toEqual(["ok"]);
  } finally {
    err.mockRestore();
  }
});

it("a channel called 'Topic Records' is not an art-track Topic channel", async () => {
  order = ["rec", "topic"];
  videos = {
    rec: { title: "Song", channel: "Topic Records", category: "20", duration: "PT3M" },
    topic: { title: "Song", channel: "Artist - Topic", category: "20", duration: "PT3M" },
  };
  const body = await (await get("q")).json();
  expect(body.results.map((r: { videoId: string; isTopic: boolean }) => [r.videoId, r.isTopic])).toEqual([["topic", true], ["rec", false]]);
});

it("a non-quota YouTube failure is a 500, not a quota message", async () => {
  searchStatus = { status: 403, reason: "forbidden" };
  expect((await get("q")).status).toBe(500);
});

it("rejects non-owners with 401 and never calls YouTube", async () => {
  expect((await get("q", false)).status).toBe(401);
  expect(calls).toHaveLength(0);
});

it("rejects empty and over-long q with 400", async () => {
  expect((await get("")).status).toBe(400);
  expect((await get("   ")).status).toBe(400);
  expect((await get("a".repeat(101))).status).toBe(400);
  expect((await get("a".repeat(100))).status).toBe(200);
});

it("rankResults: Topic, then Music, then rest, stable, nothing dropped", () => {
  const r = (id: string, isTopic: boolean, categoryId: string) => ({ id, isTopic, categoryId });
  const out = rankResults([r("g1", false, "20"), r("m1", false, "10"), r("t1", true, "20"), r("g2", false, "24"), r("m2", false, "10"), r("t2", true, "10")]);
  expect(out.map((x) => x.id)).toEqual(["t1", "t2", "m1", "m2", "g1", "g2"]);
});
