import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, makeTestApp } from "./helpers.ts";

const INDEX_HTML = "<!doctype html><title>TTunes test</title>";
let staticDir: string;

beforeEach(() => {
  staticDir = makeTempDir("ttunes-dist-");
  writeFileSync(join(staticDir, "index.html"), INDEX_HTML);
});

describe("static UI serving", () => {
  it("serves index.html at /", async () => {
    const { app } = makeTestApp(undefined, { staticDir });
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toBe(INDEX_HTML);
  });

  it("falls back to index.html for client-side paths", async () => {
    const { app } = makeTestApp(undefined, { staticDir });
    const res = await request(app).get("/some/path");
    expect(res.status).toBe(200);
    expect(res.text).toBe(INDEX_HTML);
  });

  it("still answers /api/tracks with JSON", async () => {
    const { app } = makeTestApp(undefined, { staticDir });
    const res = await request(app).get("/api/tracks");
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body).toEqual([]);
  });

  it("keeps /audio/unknown a 404, not the SPA page", async () => {
    const { app } = makeTestApp(undefined, { staticDir });
    const res = await request(app).get("/audio/unknown");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("TTunes test");
  });

  it("does not serve the SPA for unknown /api paths", async () => {
    const { app } = makeTestApp(undefined, { staticDir });
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
  });

  it("treats bare /api and /audio like their subpaths, not the SPA", async () => {
    const { app } = makeTestApp(undefined, { staticDir });
    const api = await request(app).get("/api");
    const audio = await request(app).get("/audio");
    expect(api.text).not.toContain("TTunes test");
    expect(audio.text).not.toContain("TTunes test");
  });
});
