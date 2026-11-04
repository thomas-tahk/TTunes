import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import express from "express";
import { Readable } from "node:stream";
import { sendRanged } from "../server/range.ts";
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

  it("quarantines valid JSON that is not an array", () => {
    const dir = makeTempDir("ttunes-repo-");
    const file = join(dir, "tracks.json");
    writeFileSync(file, '{"a":1}');
    const orig = console.warn;
    console.warn = () => {};
    try {
      expect(new JsonTrackRepo(file).all()).toEqual([]);
    } finally {
      console.warn = orig;
    }
    expect(readdirSync(dir).some((f) => f.startsWith("tracks.json.corrupt-"))).toBe(true);
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

  it.each(["bytes=999999-", "bytes=5-2"])("416 for %s", async (range) => {
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

  it.each(["bytes=abc-", "garbage", "items=0-1"])("serves the full file for malformed/unknown-unit %s", async (range) => {
    const { app, url } = await upload();
    const res = await get(app, url, range);
    expect(res.status).toBe(200);
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
  it("empties the staging dir only when clearStaging() is called", () => {
    const dir = makeTempDir("ttunes-stage-");
    mkdirSync(join(dir, "s"));
    writeFileSync(join(dir, "s", "old.mp3"), "x");
    const ingest = new YouTubeIngest(join(dir, "s"));
    expect(readdirSync(join(dir, "s"))).toEqual(["old.mp3"]);
    ingest.clearStaging();
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

  async function stageWithStderr(stderr: string): Promise<Error> {
    const original = process.env.PATH;
    const bin = makeTempDir("ttunes-bin-");
    writeFileSync(join(bin, "yt-dlp"), `#!/bin/sh\necho '${stderr}' >&2\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${original}`;
    try {
      return await new YouTubeIngest(makeTempDir("ttunes-stage-")).stage(LINK).then(() => new Error("no throw"), (e) => e);
    } finally {
      process.env.PATH = original;
    }
  }

  it("appends the upgrade hint only to generic yt-dlp failures", async () => {
    expect((await stageWithStderr("ERROR: nope")).message).toBe("nope (if this keeps happening, run: brew upgrade yt-dlp)");
  });

  it.each([
    ["ERROR: [youtube] abc: Private video. Sign in", "That video is private or unavailable."],
    ["ERROR: [youtube] abc: Video unavailable", "That video is private or unavailable."],
    ["ERROR: File is larger than max-filesize", "That video is too long/large to add (over 80 MB)."],
    ["ERROR: Postprocessing: ffprobe and ffmpeg not found", "ffmpeg isn't installed — run: brew install ffmpeg"],
  ])("maps %s to a plain message", async (stderr, expected) => {
    expect((await stageWithStderr(stderr)).message).toBe(expected);
  });

  it("gives search failures the upgrade hint", async () => {
    const original = process.env.PATH;
    const bin = makeTempDir("ttunes-bin-");
    writeFileSync(join(bin, "yt-dlp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${original}`;
    try {
      await expect(runRealYtSearch("x")).rejects.toThrow("YouTube search failed. (if this keeps happening, run: brew upgrade yt-dlp)");
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

describe("streaming robustness", () => {
  it("destroys the file stream when the client aborts", async () => {
    let source: Readable | undefined;
    const app = express();
    app.get("/x", (req, res) =>
      sendRanged(req, res, {
        size: 1e9,
        contentType: "audio/mpeg",
        open: () => (source = new Readable({ read() { this.push(Buffer.alloc(65536)); } })),
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve) => {
      const req = http.get({ port, host: "127.0.0.1", path: "/x" }, (res) => res.once("data", () => (req.destroy(), resolve())));
    });
    await vi.waitFor(() => expect(source?.destroyed).toBe(true));
    server.close();
  });

  it("404s a staged preview whose file was deleted, and keeps serving", async () => {
    const { app, root } = makeTestApp(fakeYtDlp({ title: "A - B" }));
    const staged = await request(app).post("/api/ingest/youtube").send({ url: LINK });
    rmSync(join(root, "staging", `${staged.body.id}.mp3`));

    const res = await request(app).get(`/api/ingest/youtube/${staged.body.id}/audio`);
    const after = await request(app).get("/api/tracks");

    expect(res.status).toBe(404);
    expect(after.status).toBe(200);
  });
});

describe("local-only guard", () => {
  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const { app } = makeTestApp();
    const res = await request(app).get("/api/tracks").set("Host", "evil.example:8787");
    expect(res.status).toBe(403);
  });

  it("accepts localhost Host headers", async () => {
    const { app } = makeTestApp();
    expect((await request(app).get("/api/tracks").set("Host", "localhost:8787")).status).toBe(200);
  });

  it.each(["post", "delete"] as const)("rejects a cross-site %s", async (method) => {
    const { app } = makeTestApp();
    const res = await request(app)[method]("/api/tracks/x").set("Origin", "https://evil.example");
    expect(res.status).toBe(403);
  });

  it("rejects a cross-site upload without storing it", async () => {
    const { app, repo } = makeTestApp();
    const res = await request(app).post("/api/tracks").set("Origin", "https://evil.example").attach("file", join(FIXTURES, "tone.mp3"));
    expect(res.status).toBe(403);
    expect(repo.all()).toEqual([]);
  });

  it("allows a same-host Origin on writes", async () => {
    const { app } = makeTestApp();
    const res = await request(app).delete("/api/tracks/x").set("Host", "localhost:5173").set("Origin", "http://localhost:5173");
    expect(res.status).toBe(404);
  });
});
