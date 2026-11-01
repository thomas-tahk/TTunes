import { describe, expect, it } from "vitest";
import request from "supertest";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, fakeYtDlp, makeTempDir, makeTestApp } from "./helpers.ts";
import { JsonTrackRepo } from "../server/repo.ts";
import { IngestError, YouTubeIngest } from "../server/ingest.ts";
import { runRealYtSearch } from "../server/search.ts";

const LINK = "https://www.youtube.com/watch?v=fixture0001";
const SIZE = readFileSync(join(FIXTURES, "tone.mp3")).length;

describe("no cross-origin access", () => {
  it("sends no Access-Control-Allow-Origin to a foreign origin", async () => {
    const { app } = makeTestApp();
    const res = await request(app).get("/api/tracks").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("tracks.json durability", () => {
  const track = { id: "a", title: "t", artist: "x", album: null, durationSec: 1, bitrate: 1, format: "mp3", sizeBytes: 1, storageKey: "k.mp3", createdAt: "now" };

  it("writes atomically and leaves no temp files", () => {
    const dir = makeTempDir("ttunes-repo-");
    const file = join(dir, "data", "tracks.json");
    new JsonTrackRepo(file).add(track);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
    expect(readdirSync(join(dir, "data"))).toEqual(["tracks.json"]);
  });

  it("moves a corrupt file aside, logs one line, and starts empty", () => {
    const dir = makeTempDir("ttunes-repo-");
    const file = join(dir, "tracks.json");
    writeFileSync(file, "{not json");
    const logs: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a) => void logs.push(a);
    try {
      expect(new JsonTrackRepo(file).all()).toEqual([]);
    } finally {
      console.warn = orig;
    }
    const aside = readdirSync(dir).filter((f) => f.startsWith("tracks.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]), "utf8")).toBe("{not json");
    expect(existsSync(file)).toBe(false);
    expect(logs).toHaveLength(1);
  });
});

describe("/audio ranges", () => {
  async function upload() {
    const t = makeTestApp();
    const added = await request(t.app).post("/api/tracks").attach("file", join(FIXTURES, "tone.mp3"));
    return { app: t.app, url: `/audio/${added.body.id}` };
  }
  const get = (app: Parameters<typeof request>[0], url: string, range: string) =>
    request(app)
      .get(url)
      .set("Range", range)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

  it.each(["bytes=abc-", "bytes=999999-", "bytes=5-2"])("416 for %s", async (range) => {
    const { app, url } = await upload();
    const res = await get(app, url, range);
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${SIZE}`);
  });

  it("serves the last 500 bytes for a suffix range", async () => {
    const { app, url } = await upload();
    const res = await get(app, url, "bytes=-500");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes ${SIZE - 500}-${SIZE - 1}/${SIZE}`);
    expect(res.body.length).toBe(500);
  });

  it("clamps an oversized end", async () => {
    const { app, url } = await upload();
    const res = await get(app, url, "bytes=0-99999999");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-${SIZE - 1}/${SIZE}`);
    expect(res.body.length).toBe(SIZE);
  });

  it("serves bytes=0-1", async () => {
    const { app, url } = await upload();
    const res = await get(app, url, "bytes=0-1");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-1/${SIZE}`);
    expect(res.body.length).toBe(2);
  });

  it("serves only the first of multiple ranges", async () => {
    const { app, url } = await upload();
    const res = await get(app, url, "bytes=0-1,10-20");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-1/${SIZE}`);
    expect(res.body.length).toBe(2);
  });
});

describe("staging preview ranges", () => {
  it("advertises Accept-Ranges and serves partial content", async () => {
    const { app } = makeTestApp(fakeYtDlp({ title: "A - B" }));
    const staged = await request(app).post("/api/ingest/youtube").send({ url: LINK });
    const url = `/api/ingest/youtube/${staged.body.id}/audio`;

    const full = await request(app).get(url);
    const part = await request(app).get(url).set("Range", "bytes=0-1");
    const bad = await request(app).get(url).set("Range", "bytes=999999-");

    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 0-1/${SIZE}`);
    expect(bad.status).toBe(416);
    expect(bad.headers["content-range"]).toBe(`bytes */${SIZE}`);
  });
});

describe("staging dir hygiene", () => {
  it("empties the staging dir on startup", () => {
    const dir = makeTempDir("ttunes-stage-");
    mkdirSync(join(dir, "s"));
    writeFileSync(join(dir, "s", "old.mp3"), "x");
    new YouTubeIngest(join(dir, "s"));
    expect(readdirSync(join(dir, "s"))).toEqual([]);
  });

  it("removes partial files when staging fails", async () => {
    const dir = makeTempDir("ttunes-stage-");
    const ingest = new YouTubeIngest(dir, async (_u, template) => {
      writeFileSync(template.replace("%(ext)s", "part"), "x");
      throw new IngestError("boom");
    });
    await expect(ingest.stage(LINK)).rejects.toThrow("boom");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("error copy", () => {
  it("says how to install yt-dlp when missing (ingest and search)", async () => {
    const original = process.env.PATH;
    process.env.PATH = makeTempDir("ttunes-empty-");
    try {
      const ingest = new YouTubeIngest(makeTempDir("ttunes-stage-"));
      await expect(ingest.stage(LINK)).rejects.toThrow("yt-dlp isn't installed — run: brew install yt-dlp");
      await expect(runRealYtSearch("x")).rejects.toThrow("yt-dlp isn't installed — run: brew install yt-dlp");
    } finally {
      process.env.PATH = original;
    }
  });

  it("appends the upgrade hint to yt-dlp failures", async () => {
    const original = process.env.PATH;
    const bin = makeTempDir("ttunes-bin-");
    writeFileSync(join(bin, "yt-dlp"), "#!/bin/sh\necho 'ERROR: nope' >&2\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${original}`;
    try {
      const ingest = new YouTubeIngest(makeTempDir("ttunes-stage-"));
      await expect(ingest.stage(LINK)).rejects.toThrow("nope (if this keeps happening, run: brew upgrade yt-dlp)");
    } finally {
      process.env.PATH = original;
    }
  });
});

describe("playlist links", () => {
  it("rejects a playlist-only URL but allows watch?v=&list=", async () => {
    const { app } = makeTestApp(fakeYtDlp({ title: "A - B" }));
    const bad = await request(app).post("/api/ingest/youtube").send({ url: "https://www.youtube.com/playlist?list=PL123" });
    const ok = await request(app).post("/api/ingest/youtube").send({ url: `${LINK}&list=PL123` });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("That's a playlist link — paste a single song's link.");
    expect(ok.status).toBe(201);
  });
});
