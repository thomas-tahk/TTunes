import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestApp, type TestApp } from "./helpers.ts";

const AUTH = { password: "pw-correct", secret: "test-secret" };
const INDEX = "<!doctype html><title>TTunes</title><div id=root></div>";

describe("serving the built front end", () => {
  let t: TestApp | undefined;
  let dist: string;

  beforeEach(() => {
    t = undefined;
    dist = mkdtempSync(join(tmpdir(), "ttunes-dist-"));
    writeFileSync(join(dist, "index.html"), INDEX);
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets", "app.js"), "console.log('hi')");
  });
  afterEach(() => {
    t?.cleanup();
    rmSync(dist, { recursive: true, force: true });
  });

  it("serves index.html and assets publicly while /api and /audio stay behind auth", async () => {
    t = await makeTestApp({ auth: AUTH, staticDir: dist });

    const index = await request(t.app).get("/");
    expect(index.status).toBe(200);
    expect(index.headers["content-type"]).toMatch(/text\/html/);
    expect(index.text).toBe(INDEX);

    const asset = await request(t.app).get("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toMatch(/javascript/);

    for (const path of ["/api/tracks", "/api/nope", `/audio/${t.track.id}`]) {
      const res = await request(t.app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.text, path).not.toBe(INDEX);
    }
    expect((await request(t.app).get("/health")).text).toBe("ok");
  });

  it("falls back to index.html for client-side routes (GET/HEAD only)", async () => {
    t = await makeTestApp({ auth: AUTH, staticDir: dist });
    const res = await request(t.app).get("/library/some-track");
    expect(res.status).toBe(200);
    expect(res.text).toBe(INDEX);
    expect((await request(t.app).head("/library")).status).toBe(200);
    expect((await request(t.app).post("/library")).status).toBe(404);
  });

  it("never answers an unknown /api or /audio path with index.html", async () => {
    t = await makeTestApp({ staticDir: dist }); // auth off: nothing in front of the fallback
    for (const path of ["/api/nope", "/api", "/audio/missing-id", "/audio"]) {
      const res = await request(t.app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toBe(INDEX);
    }
  });

  it("serves nothing extra without a staticDir", async () => {
    t = await makeTestApp({ auth: AUTH });
    expect((await request(t.app).get("/")).status).toBe(404);
  });
});
