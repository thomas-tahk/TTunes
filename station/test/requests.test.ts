import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import nowApi from "../api/now.ts";
import ownerApi from "../api/owner.ts";
import requestsApi from "../api/requests.ts";
import { SESSION_COOKIE, issueSession, requireOwner } from "../lib/auth.ts";
import { createDb, sharedDb } from "../lib/db.ts";
import { LISTENER_COOKIE, hashIp, identifyListener } from "../lib/listener.ts";
import { migrate } from "../lib/migrate.ts";
import { expireStale, getMode, moderate, purgeOldIpHashes, setMode } from "../lib/requests.ts";
import { getNowPlaying } from "../lib/schedule.ts";

interface Fake { title: string; duration: string; category?: string; embeddable?: boolean }
const catalog: Record<string, Fake> = {
  musicVid001: { title: "Synth Song", duration: "PT3M30S", category: "10" },
  musicVid002: { title: "Second Synth", duration: "PT2M", category: "10" },
  musicVid003: { title: "Third Synth", duration: "PT2M", category: "10" },
  gamingVid01: { title: "Boss Theme", duration: "PT4M5S", category: "20" },
  musicTwelve: { title: "Twelve Minute Jam", duration: "PT12M", category: "10" },
  musicLong01: { title: "Twenty Minute Epic", duration: "PT20M", category: "10" },
  blockedVid1: { title: "No Embeds", duration: "PT3M", category: "10", embeddable: false },
};

let server: Server;
let base: string;
let youtubeCalls: string[] = [];
const realFetch = globalThis.fetch;
const HOUR = 3600_000;

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  process.env.YOUTUBE_API_KEY = "test-key";
  const db = createDb();
  await migrate(db);
  await db.end();
  const routes = { "/api/requests": requestsApi, "/api/now": nowApi, "/api/owner/skip": ownerApi };
  server = createServer((req, res) => void routes[new URL(req.url!, "http://x").pathname as keyof typeof routes]?.(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await sharedDb().end();
});
beforeEach(async () => {
  youtubeCalls = [];
  await sharedDb().query("truncate queue, station_state, play_history, activity_log, songs, requests cascade");
  await sharedDb().query("update settings set value = 'open' where key = 'request_mode'");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://www.googleapis.com/youtube/v3/videos")) {
      youtubeCalls.push(url);
      const ids = new URL(url).searchParams.get("id")!.split(",");
      const items = ids.filter((id) => catalog[id]).map((id) => ({
        id,
        snippet: { title: catalog[id]!.title, categoryId: catalog[id]!.category },
        contentDetails: { duration: catalog[id]!.duration },
        status: { embeddable: catalog[id]!.embeddable ?? true },
      }));
      return Response.json({ items });
    }
    if (!url.startsWith(base)) throw new Error(`unstubbed network call: ${url}`);
    return realFetch(input, init);
  });
});

interface Caller { cookie?: string; ip: string }
const newListener = (ip: string): Caller => ({ ip });
// Posts as a listener; keeps the cookie the server hands out so the same Caller is "the same browser".
async function request(who: Caller, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/requests`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": who.ip, ...(who.cookie ? { cookie: who.cookie } : {}) },
    body: JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  if (set) who.cookie = set.split(";")[0];
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const ask = (who: Caller, link: string, extra: object = {}) => request(who, { link, name: "Sam", ...extra });
const nowJson = async () => (await (await fetch(`${base}/api/now`)).json()) as { current: { videoId: string } | null; next: { videoId: string } | null };
const statuses = async () => (await sharedDb().query("select video_id, status from requests order by id")).rows.map((r) => `${r.video_id}:${r.status}`);
const seedLibrary = () => sharedDb().query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Seed',100),('seedSong002','Seed 2',100)");

describe("POST /api/requests rules", () => {
  it("a Music request auto-queues and /api/now plays it before the owner queue", async () => {
    await seedLibrary();
    await sharedDb().query("insert into queue (video_id) values ('seedSong002')");
    const res = await ask(newListener("1.1.1.1"), "https://youtu.be/musicVid001", { dedication: "for Mia" });
    expect(res.status).toBe(201);
    expect(res.json.request).toMatchObject({ status: "queued", videoId: "musicVid001", title: "Synth Song", name: "Sam", dedication: "for Mia", thumbnail: "https://i.ytimg.com/vi/musicVid001/hqdefault.jpg" });
    expect((await nowJson()).current?.videoId).toBe("musicVid001");
    expect(await statuses()).toEqual(["musicVid001:playing"]);
    expect((await nowJson()).next?.videoId).toBe("seedSong002"); // then the owner queue
  });

  it("a Gaming request waits and never plays by itself", async () => {
    await seedLibrary();
    const res = await ask(newListener("1.1.1.1"), "gamingVid01");
    expect(res.json.request.status).toBe("waiting");
    expect(["seedSong001", "seedSong002"]).toContain((await nowJson()).current?.videoId);
    expect(await statuses()).toEqual(["gamingVid01:waiting"]);
  });

  it("a 12-minute Music request waits; a 20-minute one is refused", async () => {
    expect((await ask(newListener("1.1.1.1"), "musicTwelve")).json.request.status).toBe("waiting");
    const long = await ask(newListener("2.2.2.2"), "musicLong01");
    expect(long.status).toBe(422);
    expect(long.json.code).toBe("too_long");
    expect(await statuses()).toEqual(["musicTwelve:waiting"]);
  });

  it("mode approve makes even Music wait; mode off refuses without touching YouTube", async () => {
    await setMode(sharedDb(), "approve");
    expect((await ask(newListener("1.1.1.1"), "musicVid001")).json.request.status).toBe("waiting");
    await setMode(sharedDb(), "off");
    youtubeCalls = [];
    const res = await ask(newListener("2.2.2.2"), "musicVid002");
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("off");
    expect(youtubeCalls).toEqual([]);
  });

  it("the mode defaults to open", async () => {
    expect(await getMode(sharedDb())).toBe("open");
  });

  it("a second active request from the same cookie is refused, and so is a new cookie on the same IP", async () => {
    const sam = newListener("3.3.3.3");
    expect((await ask(sam, "gamingVid01")).status).toBe(201);
    const again = await ask(sam, "musicVid002");
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("active_request");
    const sameIp = await ask(newListener("3.3.3.3"), "musicVid003");
    expect(sameIp.status).toBe(409);
    expect(sameIp.json.code).toBe("active_request");
    expect((await ask(newListener("4.4.4.4"), "musicVid003")).status).toBe(201); // someone else is fine
  });

  it("the same browser on a new IP is still limited (cookie), and a played request frees the listener", async () => {
    const sam = newListener("5.5.5.5");
    await ask(sam, "gamingVid01");
    sam.ip = "6.6.6.6";
    expect((await ask(sam, "musicVid002")).status).toBe(409);
    await sharedDb().query("update requests set status = 'played'");
    expect((await ask(sam, "musicVid002")).status).toBe(201);
  });

  it("the 6th request in an hour is refused, even once the earlier ones have played", async () => {
    const sam = newListener("7.7.7.7");
    for (const id of ["musicVid001", "musicVid002", "musicVid003", "gamingVid01", "musicTwelve"]) {
      expect((await ask(sam, id)).status).toBe(201);
      await sharedDb().query("update requests set status = 'played'");
    }
    const sixth = await ask(sam, "musicVid001");
    expect(sixth.status).toBe(429);
    expect(sixth.json.code).toBe("rate_limited");
  });

  it("refuses a song already coming up: playing now, in the owner queue, or already requested", async () => {
    await seedLibrary();
    await sharedDb().query("insert into queue (video_id) values ('seedSong002')");
    await nowJson();
    const current = (await sharedDb().query("select current_video_id from station_state")).rows[0].current_video_id;
    for (const [i, id] of [current, "seedSong002"].entries()) {
      const res = await ask(newListener(`9.9.9.${i}`), id);
      expect(res.json.code, id).toBe("already_coming_up");
      expect(res.status).toBe(409);
    }
    expect((await ask(newListener("8.8.8.8"), "gamingVid01")).status).toBe(201);
    expect((await ask(newListener("8.8.8.9"), "gamingVid01")).json.code).toBe("already_coming_up");
  });

  it("a blocked, unknown or malformed link is refused with a plain message", async () => {
    expect((await ask(newListener("1.2.3.4"), "blockedVid1")).status).toBe(422);
    expect((await ask(newListener("1.2.3.5"), "notFound001")).status).toBe(404);
    const bad = await ask(newListener("1.2.3.6"), "https://example.com/x");
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("bad_link");
    expect(await statuses()).toEqual([]);
  });

  it("validates the text: name 1-30, dedication up to 140, plain text, unknown fields ignored", async () => {
    const who = () => newListener(`10.0.0.${Math.floor(Math.random() * 250)}`);
    const cases: [object, string][] = [
      [{ name: "" }, "bad_name"],
      [{ name: "   " }, "bad_name"],
      [{ name: "x".repeat(31) }, "bad_name"],
      [{ name: 7 }, "bad_input"],
      [{ name: "ok", dedication: "d".repeat(141) }, "bad_dedication"],
      [{ name: "ok", dedication: 5 }, "bad_input"],
      [{ name: "ok\u0000", dedication: "x" }, "bad_text"],
      [{ name: "ok", dedication: "line\nbreak" }, "bad_text"],
    ];
    for (const [fields, code] of cases) {
      const res = await request(who(), { link: "musicVid001", ...fields });
      expect([res.status, res.json.code], JSON.stringify(fields)).toEqual([400, code]);
    }
    const good = await request(who(), { link: "musicVid001", name: "x".repeat(30), dedication: "d".repeat(140), title: "hacked", status: "played", durationSec: 1, listenerId: "evil" });
    expect(good.status).toBe(201);
    expect(good.json.request.title).toBe("Synth Song"); // client metadata ignored, re-fetched
    expect(await statuses()).toEqual(["musicVid001:playing".replace("playing", "queued")]);
  });

  it("stores text verbatim as plain text (no HTML interpretation server-side)", async () => {
    await ask(newListener("1.1.1.1"), "gamingVid01", { name: "<b>Sam</b>", dedication: "<script>alert(1)</script>" });
    const row = (await sharedDb().query("select name, dedication from requests")).rows[0];
    expect(row).toEqual({ name: "<b>Sam</b>", dedication: "<script>alert(1)</script>" });
  });

  it("405 on GET, and non-JSON bodies are a 400 not a crash", async () => {
    expect((await fetch(`${base}/api/requests`)).status).toBe(405);
    const res = await fetch(`${base}/api/requests`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });
});

describe("play order and status moves", () => {
  it("requests play in order, then the owner queue, each moving queued -> playing -> played", async () => {
    await seedLibrary();
    await sharedDb().query("insert into queue (video_id) values ('seedSong002')");
    await ask(newListener("1.1.1.1"), "musicVid001");
    await ask(newListener("1.1.1.2"), "musicVid002");
    const db = sharedDb();
    let clock = Date.now();
    const play = async () => (await getNowPlaying(db, () => clock)).current?.videoId;
    expect(await play()).toBe("musicVid001");
    expect(await statuses()).toEqual(["musicVid001:playing", "musicVid002:queued"]);
    clock += 211_000;
    expect(await play()).toBe("musicVid002");
    expect(await statuses()).toEqual(["musicVid001:played", "musicVid002:playing"]);
    clock += 121_000;
    expect(await play()).toBe("seedSong002"); // owner queue next
    expect(await statuses()).toEqual(["musicVid001:played", "musicVid002:played"]);
    clock += 101_000;
    expect(["seedSong001", "seedSong002"]).toContain(await play()); // then shuffle
  });

  it("a request made while a library song plays waits for that song to end, and does not disturb the shuffle cycle", async () => {
    await seedLibrary();
    const db = sharedDb();
    let clock = Date.now();
    const first = (await getNowPlaying(db, () => clock)).current!.videoId;
    const cycleBefore = (await db.query("select cycle from station_state")).rows[0].cycle;
    await ask(newListener("1.1.1.1"), "musicVid001");
    expect((await getNowPlaying(db, () => clock)).current?.videoId).toBe(first);
    expect((await getNowPlaying(db, () => clock)).next?.videoId).toBe("musicVid001");
    clock += 101_000;
    expect((await getNowPlaying(db, () => clock)).current?.videoId).toBe("musicVid001");
    expect((await db.query("select cycle from station_state")).rows[0].cycle).toEqual(cycleBefore);
    clock += 211_000;
    const after = (await getNowPlaying(db, () => clock)).current!.videoId;
    expect(after).not.toBe(first); // the shuffle carries on from where it was
  });

  it("an owner skip of a playing request marks it played and starts the next one", async () => {
    await ask(newListener("1.1.1.1"), "musicVid001");
    await ask(newListener("1.1.1.2"), "musicVid002");
    await nowJson();
    const cookie = `${SESSION_COOKIE}=${await issueSession(sharedDb())}`;
    const res = await fetch(`${base}/api/owner/skip`, { method: "POST", headers: { cookie }, body: JSON.stringify({ expectedVideoId: "musicVid001" }) });
    expect(res.status).toBe(200);
    expect(await statuses()).toEqual(["musicVid001:played", "musicVid002:playing"]);
  });

  it("a never-started station is not started by a stale skip with a bogus id (M2 leftover)", async () => {
    const cookie = `${SESSION_COOKIE}=${await issueSession(sharedDb())}`;
    await seedLibrary();
    const res = await fetch(`${base}/api/owner/skip`, { method: "POST", headers: { cookie }, body: JSON.stringify({ expectedVideoId: "bogusVideo01" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.playing).toBeUndefined();
    expect((await sharedDb().query("select current_video_id from station_state")).rows.every((r) => r.current_video_id === null)).toBe(true);
    expect((await sharedDb().query("select count(*)::int as n from play_history")).rows[0].n).toBe(0);
  });
});

describe("expiry, moderation, purge (fake clock)", () => {
  it("waiting requests expire after 24h, queued ones do not; the listener is freed", async () => {
    const db = sharedDb();
    const sam = newListener("1.1.1.1");
    await ask(sam, "gamingVid01");
    await ask(newListener("1.1.1.2"), "musicVid001"); // queued
    const created = Date.now();
    expect(await expireStale(db, () => created + 24 * HOUR - 60_000)).toBe(0);
    expect(await expireStale(db, () => created + 24 * HOUR + 60_000)).toBe(1);
    expect(await statuses()).toEqual(["gamingVid01:expired", "musicVid001:queued"]);
    expect((await ask(sam, "gamingVid01")).status).toBe(201);
  });

  it("posting also expires stale waiting requests lazily (an old waiting request does not block)", async () => {
    await ask(newListener("1.1.1.1"), "gamingVid01");
    await sharedDb().query("update requests set created_at = now() - interval '25 hours'");
    // same song from someone else: the stale one is expired under the lock first, so it is not "already coming up"
    expect((await ask(newListener("1.1.1.2"), "gamingVid01")).status).toBe(201);
    expect((await statuses())[0]).toBe("gamingVid01:expired");
  });

  it("IP hashes older than 7 days are erased, newer ones kept; no raw IP is stored", async () => {
    const db = sharedDb();
    await ask(newListener("1.1.1.1"), "gamingVid01");
    await ask(newListener("1.1.1.2"), "musicVid001");
    await db.query("update requests set created_at = now() - interval '8 days' where video_id = 'gamingVid01'");
    expect(await purgeOldIpHashes(db, Date.now)).toBe(1);
    const rows = (await db.query("select video_id, ip_hash from requests order by id")).rows;
    expect(rows[0].ip_hash).toBeNull();
    expect(rows[1].ip_hash).toBe(hashIp("1.1.1.2"));
    expect(rows[1].ip_hash).not.toContain("1.1.1.2");
  });

  it("approve moves waiting to queued so it plays; deny never plays; remove drops a queued one; all logged", async () => {
    const db = sharedDb();
    await ask(newListener("1.1.1.1"), "gamingVid01");
    await ask(newListener("1.1.1.2"), "musicTwelve");
    const [gaming, twelve] = (await db.query("select id from requests order by id")).rows.map((r) => Number(r.id));
    expect(await moderate(db, twelve, "deny", Date.now)).toBe(true);
    expect(await moderate(db, twelve, "deny", Date.now)).toBe(false); // already decided
    expect(await moderate(db, gaming, "remove", Date.now)).toBe(false); // not queued yet
    expect(await moderate(db, gaming, "approve", Date.now)).toBe(true);
    expect((await nowJson()).current?.videoId).toBe("gamingVid01");
    expect(await statuses()).toEqual(["gamingVid01:playing", "musicTwelve:denied"]);
    expect((await db.query("select what from activity_log order by id")).rows.map((r) => r.what)).toEqual(["request_deny", "request_approve"]);
  });
});

describe("listener identity", () => {
  it("issues a signed httpOnly cookie once, then recognises it", async () => {
    const res = await fetch(`${base}/api/requests`, { method: "POST", body: JSON.stringify({ link: "gamingVid01", name: "Sam" }) });
    const header = res.headers.get("set-cookie")!;
    expect(header).toMatch(new RegExp(`^${LISTENER_COOKIE}=`));
    expect(header).toMatch(/HttpOnly/);
    const res2 = await fetch(`${base}/api/requests`, { method: "POST", headers: { cookie: header.split(";")[0] }, body: JSON.stringify({ link: "musicVid001", name: "Sam" }) });
    expect(res2.headers.get("set-cookie")).toBeNull();
  });

  it("a forged or owner cookie does not pass as a listener, and a listener cookie is not an owner session", async () => {
    const forged = await new SignJWT({ lid: "x" }).setProtectedHeader({ alg: "HS256" }).setAudience("ttunes-listener").sign(new TextEncoder().encode("another-secret-another-secret-12345"));
    const req = (cookie: string) => ({ headers: { cookie } }) as never;
    expect((await identifyListener(req(`${LISTENER_COOKIE}=${forged}`))).setCookie).not.toBeNull();
    const ownerJwt = await issueSession(sharedDb());
    expect((await identifyListener(req(`${LISTENER_COOKIE}=${ownerJwt}`))).setCookie).not.toBeNull();
    const who = newListener("1.1.1.1");
    await ask(who, "gamingVid01");
    const listenerToken = who.cookie!.slice(LISTENER_COOKIE.length + 1);
    expect(await requireOwner({ headers: { cookie: `${SESSION_COOKIE}=${decodeURIComponent(listenerToken)}` } } as never)).toBe(false);
  });
});
