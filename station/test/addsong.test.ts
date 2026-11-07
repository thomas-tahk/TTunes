import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import nowApi from "../api/now.ts";
import preview from "../api/owner/preview.ts";
import songs from "../api/owner/songs.ts";
import { SESSION_COOKIE, issueSession } from "../lib/auth.ts";
import { createDb, sharedDb } from "../lib/db.ts";
import { insertSong } from "../lib/addSong.ts";
import { migrate } from "../lib/migrate.ts";
import { parseVideoId } from "../lib/ytlink.ts";

const ID = "dQw4w9WgXcQ";

describe("parseVideoId", () => {
  const forms = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&list=PL123&t=42s`,
    `https://www.youtube.com/watch?list=PL1&v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=30`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}?start=5`,
    `https://m.youtube.com/watch?v=${ID}`,
    `youtube.com/watch?v=${ID}`,
    `  ${ID}  `,
    `https://www.youtube-nocookie.com/embed/${ID}`,
  ];
  it.each(forms)("parses %s", (form) => expect(parseVideoId(form)).toBe(ID));
  it.each(["", "hello", "https://example.com/watch?v=" + ID, "https://www.youtube.com/watch", "https://youtu.be/short", "https://www.youtube.com/playlist?list=PL1", 42])(
    "rejects %s",
    (bad) => expect(parseVideoId(bad)).toBeNull(),
  );
});

interface Fake { title: string; duration: string; embeddable?: boolean; category?: string }
const catalog: Record<string, Fake> = {
  musicVid001: { title: "Synth Song", duration: "PT3M30S", category: "10" },
  gamingVid01: { title: "Boss Theme (Soundtrack)", duration: "PT4M5S", category: "20" },
  nullLength1: { title: "Odd Length", duration: "garbage" },
  longVideo01: { title: "Two Hour Mix", duration: "PT2H" },
  blockedVid1: { title: "No Embeds", duration: "PT3M", embeddable: false },
  liveVideo01: { title: "Live Radio", duration: "P0D" },
  secondVid01: { title: "Second", duration: "PT2M" },
};

let server: Server;
let base: string;
let cookie: string;
let youtubeCalls: string[] = [];
const realFetch = globalThis.fetch;

type H = (req: IncomingMessage, res: ServerResponse) => unknown;
const routes: Record<string, H> = { "/api/owner/preview": preview, "/api/owner/songs": songs, "/api/now": nowApi };

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  process.env.YOUTUBE_API_KEY = "test-key";
  const db = createDb();
  await migrate(db);
  await db.end();
  cookie = `${SESSION_COOKIE}=${await issueSession(sharedDb())}`;
  server = createServer((req, res) => void routes[new URL(req.url!, "http://x").pathname]?.(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await sharedDb().end();
});
beforeEach(async () => {
  youtubeCalls = [];
  await sharedDb().query("truncate queue, station_state, play_history, activity_log, songs cascade");
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

const post = (path: string, body: unknown, withCookie = true) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(withCookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const add = (videoId: string, position: "next" | "queue", extra: object = {}) => post("/api/owner/songs", { videoId, position, ...extra });
const nowJson = async () => (await (await fetch(`${base}/api/now`)).json()) as { current: { videoId: string } | null; next: { videoId: string; title: string } | null };

describe("owner endpoints", () => {
  it("are 401 without the owner cookie, and never reach YouTube", async () => {
    expect((await post("/api/owner/preview", { url: ID }, false)).status).toBe(401);
    expect((await post("/api/owner/songs", { videoId: "musicVid001", position: "next" }, false)).status).toBe(401);
    expect((await fetch(`${base}/api/owner/preview`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=garbage` }, body: "{}" })).status).toBe(401);
    expect(youtubeCalls).toEqual([]);
  });

  it("preview returns title, duration and thumbnail", async () => {
    const res = await post("/api/owner/preview", { url: "https://music.youtube.com/watch?v=musicVid001&list=x" });
    expect(await res.json()).toEqual({ videoId: "musicVid001", title: "Synth Song", durationSec: 210, thumbnail: "https://i.ytimg.com/vi/musicVid001/hqdefault.jpg", long: false });
  });

  it("preview refuses bad links, missing, blocked and live videos with plain messages", async () => {
    const cases: [string, number, RegExp][] = [
      ["not a link", 400, /YouTube link/],
      ["notFound001", 404, /no public video/],
      ["blockedVid1", 422, /embedding is blocked/],
      ["liveVideo01", 422, /live or upcoming/],
    ];
    for (const [url, status, message] of cases) {
      const res = await post("/api/owner/preview", { url });
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
  });

  it("adds a Music video and a Gaming video; 'next' shows as next in /api/now; each add is logged", async () => {
    const db = sharedDb();
    await db.query("insert into songs (video_id, title, duration_sec) values ('seedSong0001','Seed',100),('seedSong0002','Seed 2',100)");
    await nowJson(); // station starts on a seed song
    expect((await add("musicVid001", "next")).status).toBe(200);
    expect((await nowJson()).next?.videoId).toBe("musicVid001");
    expect((await add("gamingVid01", "next")).status).toBe(200);
    expect((await nowJson()).next).toMatchObject({ videoId: "gamingVid01", title: "Boss Theme (Soundtrack)" });
    const lib = await db.query("select video_id from songs where video_id in ('musicVid001','gamingVid01') order by 1");
    expect(lib.rows.length).toBe(2);
    const log = await db.query("select who, what, details from activity_log order by id");
    expect(log.rows).toEqual([
      { who: "owner", what: "song_added", details: { videoId: "musicVid001", title: "Synth Song", position: "next" } },
      { who: "owner", what: "song_added", details: { videoId: "gamingVid01", title: "Boss Theme (Soundtrack)", position: "next" } },
    ]);
  });

  it("'queue' goes to the end, 'next' to the front, even on a non-empty queue", async () => {
    await sharedDb().query("insert into songs (video_id, title, duration_sec) values ('seedSong0001','Seed',100)");
    await nowJson();
    await add("musicVid001", "queue");
    await add("secondVid01", "queue");
    await add("gamingVid01", "next");
    const { rows } = await sharedDb().query("select video_id from queue order by position");
    expect(rows.map((r) => r.video_id)).toEqual(["gamingVid01", "musicVid001", "secondVid01"]);
  });

  it("two simultaneous adds both land, in a consistent order", async () => {
    await sharedDb().query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Seed',100)");
    await nowJson();
    const results = await Promise.all([add("musicVid001", "next"), add("secondVid01", "next"), add("gamingVid01", "queue")]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const { rows } = await sharedDb().query("select id, position, video_id from queue order by position");
    expect(rows.map((r) => r.video_id).sort()).toEqual(["gamingVid01", "musicVid001", "secondVid01"]);
    expect(new Set(rows.map((r) => String(r.position))).size).toBe(3);
  });

  it("a 2-hour video needs confirmLong", async () => {
    const refused = await add("longVideo01", "next");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Add anyway\?/);
    expect((await sharedDb().query("select 1 from songs where video_id = 'longVideo01'")).rowCount).toBe(0);
    expect((await add("longVideo01", "next", { confirmLong: "yes" })).status).toBe(409); // must be literally true
    expect((await add("longVideo01", "next", { confirmLong: true })).status).toBe(200);
    expect((await sharedDb().query("select duration_sec from songs where video_id = 'longVideo01'")).rows[0].duration_sec).toBe(7200);
  });

  it("refuses embed-blocked and live videos, and bad input; nothing is written", async () => {
    expect((await add("blockedVid1", "next")).status).toBe(422);
    expect((await add("liveVideo01", "next")).status).toBe(422);
    expect((await add("musicVid001", "sideways" as never)).status).toBe(400);
    expect((await post("/api/owner/songs", { position: "next" })).status).toBe(400);
    expect((await sharedDb().query("select (select count(*) from songs)::int + (select count(*) from activity_log)::int as n")).rows[0].n).toBe(0);
  });

  it("re-adding refreshes metadata instead of failing, and never trusts client titles", async () => {
    await sharedDb().query("insert into songs (video_id, title, duration_sec, metadata_refreshed_at) values ('musicVid001','Old title',5, now() - interval '20 days')");
    expect((await add("musicVid001", "queue", { title: "Evil title" })).status).toBe(200);
    const row = (await sharedDb().query("select title, duration_sec, metadata_refreshed_at > now() - interval '1 minute' as fresh from songs where video_id = 'musicVid001'")).rows[0];
    expect(row).toEqual({ title: "Synth Song", duration_sec: 210, fresh: true });
  });

  it("three 'next' adds on a fresh station: the last added plays first, then the earlier ones", async () => {
    await sharedDb().query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Seed',100)");
    await nowJson();
    for (const id of ["musicVid001", "gamingVid01", "secondVid01"]) expect((await add(id, "next")).status).toBe(200);
    const { rows } = await sharedDb().query("select video_id from queue order by position, id");
    expect(rows.map((r) => r.video_id)).toEqual(["secondVid01", "gamingVid01", "musicVid001"]);
    expect((await nowJson()).next?.videoId).toBe("secondVid01");
  });

  it("returns a fresh now-playing whose next is the added song", async () => {
    await sharedDb().query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Seed',100),('seedSong002','Seed 2',100)");
    await nowJson();
    const body = (await (await add("musicVid001", "next")).json()) as { playing: { next: { videoId: string } } };
    expect(body.playing.next.videoId).toBe("musicVid001");
  });

  it("refuses the song playing right now", async () => {
    await sharedDb().query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Seed',100)");
    const current = (await nowJson()).current!.videoId;
    catalog[current] = { title: "Seed", duration: "PT1M40S" };
    for (const position of ["next", "queue"] as const) {
      const res = await add(current, position);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("That's playing right now.");
    }
    expect((await sharedDb().query("select count(*)::int as n from queue")).rows[0].n).toBe(0);
    delete catalog[current];
  });

  it("re-adding a queued song moves it, without a duplicate row", async () => {
    await sharedDb().query("insert into songs (video_id, title, duration_sec) values ('seedSong001','Seed',100)");
    await nowJson();
    await add("musicVid001", "queue");
    await add("gamingVid01", "queue");
    await add("secondVid01", "queue");
    await add("musicVid001", "queue"); // to the end
    const order = async () => (await sharedDb().query("select video_id from queue order by position, id")).rows.map((r) => r.video_id);
    expect(await order()).toEqual(["gamingVid01", "secondVid01", "musicVid001"]);
    await add("musicVid001", "next"); // to the front
    expect(await order()).toEqual(["musicVid001", "gamingVid01", "secondVid01"]);
  });

  it("an add waits for a transaction holding the station lock (fails without `for update`)", async () => {
    const db = sharedDb();
    await db.query("insert into station_state (id) values (1) on conflict do nothing");
    const holder = await db.connect();
    await holder.query("begin");
    await holder.query("select 1 from station_state where id = 1 for update");
    let finished = false;
    const second = insertSong(db, { videoId: "musicVid001", title: "Synth Song", durationSec: 210, embeddable: true, categoryId: "10", channelTitle: "Test" }, "next").then((r) => ((finished = true), r));
    await new Promise((r) => setTimeout(r, 400));
    expect(finished).toBe(false); // blocked on the lock
    await holder.query("commit");
    holder.release();
    expect((await second).ok).toBe(true);
  });

  it("reports quota exhaustion and unusable lengths plainly", async () => {
    const was = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("https://www.googleapis.com") ? new Response("{}", { status: 403 }) : was(input, init));
    const quota = await post("/api/owner/preview", { url: ID });
    expect(((await quota.json()) as { error: string }).error).toBe("YouTube's daily limit is used up — try again tomorrow.");
    vi.stubGlobal("fetch", was);
    const odd = await post("/api/owner/preview", { url: "nullLength1" });
    expect(((await odd.json()) as { error: string }).error).toBe("YouTube didn't give a usable length for that video.");
  });
});
