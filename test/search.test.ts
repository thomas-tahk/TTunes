import { describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, makeTestApp } from "./helpers.ts";
import { parseSearchLines, SearchError, type YtSearchRunner } from "../server/search.ts";

// ytsearch5.jsonl is hand-written, NOT recorded from real YouTube (see README-ytsearch5.txt).
const fixtureLines = readFileSync(join(FIXTURES, "ytsearch5.jsonl"), "utf8");
const fixtureSearch: YtSearchRunner = async () => parseSearchLines(fixtureLines);

describe("GET /api/search", () => {
  it("returns exactly 5 hits from the fixture", async () => {
    const { app } = makeTestApp(undefined, { search: fixtureSearch });

    const res = await request(app).get("/api/search?q=neon%20coast");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
    expect(res.body[1]).toEqual({
      url: "https://www.youtube.com/watch?v=fx000000002",
      title: "Neon Coast - Midnight Drive",
      channel: "Neon Coast - Topic",
      durationSec: 212,
    });
  });

  it("rejects an empty query with 400", async () => {
    const { app } = makeTestApp(undefined, { search: fixtureSearch });

    const res = await request(app).get("/api/search?q=%20");

    expect(res.status).toBe(400);
  });

  it("passes the trimmed query to the runner", async () => {
    const seen: string[] = [];
    const { app } = makeTestApp(undefined, { search: async (q) => (seen.push(q), []) });

    await request(app).get("/api/search?q=%20abc%20");

    expect(seen).toEqual(["abc"]);
  });

  it("returns 422 with a plain message when the runner throws", async () => {
    const search: YtSearchRunner = async () => {
      throw new SearchError("yt-dlp isn't installed or couldn't run.");
    };
    const { app } = makeTestApp(undefined, { search });

    const res = await request(app).get("/api/search?q=x");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("yt-dlp isn't installed or couldn't run.");
  });

  it("hides unexpected error details behind a generic message", async () => {
    const search: YtSearchRunner = async () => {
      throw new Error("boom /secret/path");
    };
    const { app } = makeTestApp(undefined, { search });

    const res = await request(app).get("/api/search?q=x");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Search failed.");
  });
});

describe("parseSearchLines", () => {
  it("builds the url from id and falls back to uploader when url/channel are missing", () => {
    const hits = parseSearchLines(fixtureLines);

    expect(hits[2]).toEqual({
      url: "https://www.youtube.com/watch?v=fx000000003",
      title: "Neon Coast - Midnight Drive (Live)",
      channel: "Synth Nights",
      durationSec: 305,
    });
  });

  it("skips blank lines and entries without an id/url or title", () => {
    const text = '\n{"title":"no id"}\n{"id":"abc","title":"ok","duration":null}\n{"id":"def"}\n';

    expect(parseSearchLines(text)).toEqual([
      { url: "https://www.youtube.com/watch?v=abc", title: "ok", channel: null, durationSec: null },
    ]);
  });

  it("throws SearchError on a malformed line", () => {
    expect(() => parseSearchLines("not json")).toThrow(SearchError);
  });
});
