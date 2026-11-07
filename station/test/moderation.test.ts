import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import nowApi from "../api/now.ts";
import ownerApi from "../api/owner.ts";
import requestsApi from "../api/requests.ts";
import { SESSION_COOKIE, issueSession } from "../lib/auth.ts";
import { createDb, sharedDb } from "../lib/db.ts";
import { lockStation } from "../lib/lock.ts";
import { migrate } from "../lib/migrate.ts";
import { getNowPlaying } from "../lib/schedule.ts";

const catalog: Record<string, { title: string; duration: string; category: string }> = {
  musicVid001: { title: "Synth Song", duration: "PT3M30S", category: "10" },
  musicVid002: { title: "Second Synth", duration: "PT2M", category: "10" },
  gamingVid01: { title: "Boss Theme", duration: "PT4M5S", category: "20" },
  gamingVid02: { title: "Other Boss", duration: "PT3M", category: "20" },
};

let server: Server;
let base: string;
let ownerCookie: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  process.env.YOUTUBE_API_KEY = "test-key";
  const db = createDb();
  await migrate(db);
  await db.end();
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    if (path.startsWith("/api/owner/")) return void ownerApi(req, res);
    if (path === "/api/now") return void nowApi(req, res);
    void requestsApi(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await sharedDb().end();
});
beforeEach(async () => {
  await sharedDb().query("truncate queue, station_state, play_history, activity_log, songs, requests, request_attempts cascade");
  await sharedDb().query("update settings set value = 'approve' where key = 'request_mode'");
  ownerCookie = `${SESSION_COOKIE}=${await issueSession(sharedDb())}`;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://www.googleapis.com/youtube/v3/videos")) {
      const ids = new URL(url).searchParams.get("id")!.split(",");
      const items = ids.filter((id) => catalog[id]).map((id) => ({
        id,
        snippet: { title: catalog[id]!.title, categoryId: catalog[id]!.category },
        contentDetails: { duration: catalog[id]!.duration },
        status: { embeddable: true },
      }));
      return Response.json({ items });
    }
    if (!url.startsWith(base)) throw new Error(`unstubbed network call: ${url}`);
    return realFetch(input, init);
  });
});

let nextIp = 0;
// A fresh listener (own IP and cookie) requests a song; returns the new request id.
async function listen(link: string): Promise<number> {
  const res = await fetch(`${base}/api/requests`, { method: "POST", headers: { "x-forwarded-for": `9.9.9.${++nextIp}` }, body: JSON.stringify({ link, name: "Sam", dedication: "hi" }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { request: { id: number } }).request.id;
}
const setMode = (mode: string) => sharedDb().query("update settings set value = $1 where key = 'request_mode'", [mode]);
const owner = (path: string, body?: object, cookie: string | null = ownerCookie) =>
  fetch(`${base}/api/owner/requests${path}`, { method: body ? "POST" : "GET", headers: cookie ? { cookie } : {}, body: body ? JSON.stringify(body) : undefined });
const act = async (id: number, action: string) => {
  const res = await owner("/moderate", { id, action });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const statusOf = async (id: number) => (await sharedDb().query("select status from requests where id = $1", [id])).rows[0].status as string;
const logWhats = async () => (await sharedDb().query("select what from activity_log order by id")).rows.map((r) => r.what as string);
const feedIds = async () => ((await (await fetch(`${base}/api/requests/feed`)).json()) as any).requests.map((r: any) => r.id) as number[];

describe("owner-only", () => {
  it("every moderation endpoint is 401 without the owner session", async () => {
    for (const [path, body] of [["", undefined], ["/moderate", { id: 1, action: "deny" }], ["/mode", undefined], ["/mode", { mode: "off" }]] as const) {
      expect((await owner(path, body, null)).status).toBe(401);
    }
    expect((await owner("", undefined, "ttunes_listener=abc")).status).toBe(401);
  });
});

describe("list", () => {
  it("returns waiting requests oldest first with the badge count, and the recent feed with ids and statuses", async () => {
    const first = await listen("gamingVid01");
    const second = await listen("gamingVid02");
    await act(second, "approve");
    const third = await listen("musicVid001"); // approve mode: waits too
    const body = (await (await owner("")).json()) as any;
    expect(body.mode).toBe("approve");
    expect(body.waitingCount).toBe(2);
    expect(body.waiting.map((r: any) => r.id)).toEqual([first, third]);
    expect(body.requests.map((r: any) => [r.id, r.status])).toEqual([[third, "waiting"], [second, "queued"], [first, "waiting"]]);
  });

  it("does not count a waiting request older than 24h", async () => {
    const id = await listen("gamingVid01");
    await sharedDb().query("update requests set created_at = now() - interval '25 hours' where id = $1", [id]);
    const body = (await (await owner("")).json()) as any;
    expect(body.waitingCount).toBe(0);
    expect(body.waiting).toEqual([]);
  });
});

describe("approve and deny", () => {
  it("approve puts the request behind the ones already in line, and it plays in that order", async () => {
    await setMode("open");
    await listen("musicVid001"); // auto-queued
    await setMode("approve");
    const gaming = await listen("gamingVid01"); // waits
    await setMode("open");
    await listen("musicVid002"); // auto-queued after the gaming request was made, before its approval
    expect((await act(gaming, "approve")).json.request.status).toBe("queued");
    let clock = Date.now();
    const play = async () => (await getNowPlaying(sharedDb(), () => clock)).current?.videoId;
    expect(await play()).toBe("musicVid001");
    clock += 211_000;
    expect(await play()).toBe("musicVid002");
    clock += 121_000;
    expect(await play()).toBe("gamingVid01");
  });

  it("a denied request never plays and drops off the public feed", async () => {
    const id = await listen("gamingVid01");
    const res = await act(id, "deny");
    expect(res.json.request.status).toBe("denied");
    expect(res.json.waitingCount).toBe(0);
    let clock = Date.now();
    expect((await getNowPlaying(sharedDb(), () => clock)).current).toBeNull();
    clock += 10_000_000;
    expect((await getNowPlaying(sharedDb(), () => clock)).current).toBeNull();
    expect(await feedIds()).toEqual([]);
  });
});

describe("remove", () => {
  it("works from waiting, queued, played and expired, and the row leaves the public feed", async () => {
    const waiting = await listen("gamingVid01");
    const expired = await listen("gamingVid02");
    await sharedDb().query("update requests set status = 'expired' where id = $1", [expired]);
    const queued = await listen("musicVid001");
    await act(queued, "approve");
    const played = await listen("musicVid002");
    await sharedDb().query("update requests set status = 'played' where id = $1", [played]);
    for (const id of [waiting, expired, queued, played]) {
      expect((await act(id, "remove")).status).toBe(200);
      expect(await statusOf(id)).toBe("denied");
    }
    expect(await feedIds()).toEqual([]);
    expect((await logWhats()).filter((w) => w === "request_remove")).toHaveLength(4);
  });

  it("a removed queued request leaves the play order", async () => {
    const id = await listen("musicVid001");
    await act(id, "approve");
    await act(id, "remove");
    expect((await getNowPlaying(sharedDb(), Date.now)).current).toBeNull();
  });

  it("removing the playing request hides it but the song keeps playing (no skip), then the station moves on", async () => {
    const a = await listen("musicVid001");
    const b = await listen("musicVid002");
    await act(a, "approve");
    await act(b, "approve");
    let clock = Date.now();
    const now = async () => (await getNowPlaying(sharedDb(), () => clock)).current?.videoId;
    expect(await now()).toBe("musicVid001");
    expect((await act(a, "remove")).status).toBe(200);
    clock += 60_000;
    expect(await now()).toBe("musicVid001"); // still playing
    expect(await feedIds()).toEqual([b]);
    clock += 200_000;
    expect(await now()).toBe("musicVid002");
    expect(await statusOf(a)).toBe("denied"); // not flipped to played
  });
});

describe("keep", () => {
  it("adds a playing or played request's song to the library once; repeating is idempotent; both logged", async () => {
    const id = await listen("gamingVid01");
    await act(id, "approve");
    await getNowPlaying(sharedDb(), Date.now);
    const first = await act(id, "keep"); // playing counts
    expect(first.status).toBe(200);
    expect(first.json.alreadyInLibrary).toBeUndefined();
    const second = await act(id, "keep");
    expect(second.status).toBe(200);
    expect(second.json.alreadyInLibrary).toBe(true);
    const songs = (await sharedDb().query("select video_id, title, duration_sec, deleted_at from songs")).rows;
    expect(songs).toEqual([{ video_id: "gamingVid01", title: "Boss Theme", duration_sec: 245, deleted_at: null }]);
    expect((await sharedDb().query("select count(*)::int as n from queue")).rows[0].n).toBe(0);
    expect(await logWhats()).toEqual(["request_approve", "song_added", "request_keep", "request_keep"]);
  });

  it("restores a trashed song, and refuses a request that has not played (409)", async () => {
    const id = await listen("gamingVid01");
    expect((await act(id, "keep")).status).toBe(409);
    await sharedDb().query("update requests set status = 'played' where id = $1", [id]);
    await sharedDb().query("insert into songs (video_id, title, duration_sec, deleted_at) values ('gamingVid01', 'Old', 10, now())");
    expect((await act(id, "keep")).status).toBe(200);
    expect((await sharedDb().query("select deleted_at from songs")).rows[0].deleted_at).toBeNull();
  });
});

describe("stale actions and races", () => {
  it("409 with the current request when already decided; 404 for an unknown id; 400 for bad input", async () => {
    const id = await listen("gamingVid01");
    await act(id, "approve");
    const again = await act(id, "approve");
    expect(again.status).toBe(409);
    expect(again.json.request).toMatchObject({ id, status: "queued" });
    expect((await act(id, "deny")).status).toBe(409);
    await act(id, "remove");
    const removedTwice = await act(id, "remove");
    expect(removedTwice.status).toBe(409);
    expect(removedTwice.json.request.status).toBe("denied");
    expect((await act(99999, "deny")).status).toBe(404);
    expect((await act(id, "explode")).status).toBe(400);
    expect((await act("1" as never, "deny")).status).toBe(400);
  });

  it("a waiting request past 24h cannot be approved", async () => {
    const id = await listen("gamingVid01");
    await sharedDb().query("update requests set created_at = now() - interval '25 hours' where id = $1", [id]);
    const res = await act(id, "approve");
    expect(res.status).toBe(409);
    expect(res.json.request.status).toBe("expired");
  });

  it("concurrent approve and deny on one request leave exactly one winner", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await listen(round % 2 ? "gamingVid01" : "gamingVid02");
      const results = await Promise.all([act(id, "approve"), act(id, "deny")]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)!;
      const loser = results.find((r) => r.status === 409)!;
      expect(await statusOf(id)).toBe(winner.json.request.status);
      expect(loser.json.request.status).toBe(winner.json.request.status);
      await sharedDb().query("update requests set status = 'played' where id = $1", [id]); // free the song for the next round
    }
    expect((await logWhats()).filter((w) => w === "request_approve" || w === "request_deny")).toHaveLength(5);
  });
});

describe("station lock", () => {
  it("moderation and mode changes wait for the station lock like the other writers", async () => {
    const id = await listen("gamingVid01");
    const holder = await sharedDb().connect();
    await holder.query("begin");
    await lockStation(holder);
    let done = 0;
    const pending = [act(id, "approve"), owner("/mode", { mode: "off" })].map((p) => p.then(() => done++));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(0);
    await holder.query("commit");
    holder.release();
    await Promise.all(pending);
    expect(done).toBe(2);
  });
});

describe("mode", () => {
  it("gets and sets the mode, logs it, and rejects an unknown one", async () => {
    expect(((await (await owner("/mode")).json()) as any).mode).toBe("approve");
    expect((await owner("/mode", { mode: "off" })).status).toBe(200);
    expect(((await (await owner("/mode")).json()) as any).mode).toBe("off");
    expect((await owner("/mode", { mode: "wide-open" })).status).toBe(400);
    expect((await owner("/mode", {})).status).toBe(400);
    expect(await logWhats()).toEqual(["request_mode"]);
  });

  it("off refuses new listener requests", async () => {
    await owner("/mode", { mode: "off" });
    const res = await fetch(`${base}/api/requests`, { method: "POST", body: JSON.stringify({ link: "gamingVid01", name: "Sam" }) });
    expect(res.status).toBe(403);
  });
});

describe("activity log", () => {
  it("each action writes one row with the request details", async () => {
    const a = await listen("gamingVid01");
    const b = await listen("gamingVid02");
    await act(a, "approve");
    await act(b, "deny");
    expect(await logWhats()).toEqual(["request_approve", "request_deny"]);
    const row = (await sharedDb().query("select who, details from activity_log order by id limit 1")).rows[0];
    expect(row).toMatchObject({ who: "owner", details: { id: a, videoId: "gamingVid01", title: "Boss Theme", name: "Sam" } });
  });
});
