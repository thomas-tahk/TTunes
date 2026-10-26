import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { authFromEnv, createAuth } from "../auth.ts";
import { createApp } from "../app.ts";

const AUTH = { password: "pw-correct", secret: "test-secret" };

function sessionCookie(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith("ttunes_session="));
}

describe("owner password auth", () => {
  let t: TestApp;
  afterEach(() => t.cleanup());

  const protectedRoutes = (id: string) =>
    [
      ["get", "/api/tracks"],
      ["post", "/api/tracks"],
      ["delete", `/api/tracks/${id}`],
      ["get", "/api/anything-else"],
      ["get", `/audio/${id}`],
      ["get", "/audio/nope"],
    ] as const;

  it("returns 401 on every /api and /audio route without a session", async () => {
    t = await makeTestApp({ auth: AUTH });
    for (const [method, path] of protectedRoutes(t.track.id)) {
      const res = await request(t.app)[method](path);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
    // the rejected DELETE must not have deleted anything
    expect(await t.repo.get(t.track.id)).toBeDefined();
  });

  it("GET /api/session is 401 without a session", async () => {
    t = await makeTestApp({ auth: AUTH });
    expect((await request(t.app).get("/api/session")).status).toBe(401);
  });

  it("logs in with the right password, sets the cookie, and then routes work", async () => {
    t = await makeTestApp({ auth: AUTH });
    const agent = request.agent(t.app);
    const login = await agent.post("/api/login").send({ password: AUTH.password });
    expect(login.status).toBe(204);
    const cookie = sessionCookie(login);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=31536000/);
    expect(cookie).not.toMatch(/Secure/i);

    expect((await agent.get("/api/session")).status).toBe(204);
    const list = await agent.get("/api/tracks");
    expect(list.status).toBe(200);
    expect(list.body.map((x: { id: string }) => x.id)).toEqual([t.track.id]);
    const audio = await agent.get(`/audio/${t.track.id}`).set("Range", "bytes=0-99");
    expect(audio.status).toBe(206);
    const up = await agent.post("/api/tracks").attach("file", Buffer.alloc(10, 1), "a.mp3");
    expect(up.status).toBe(201);
    expect((await agent.delete(`/api/tracks/${t.track.id}`)).status).toBe(204);
  });

  it("rejects a wrong password with 401 and sets no session", async () => {
    t = await makeTestApp({ auth: AUTH });
    const agent = request.agent(t.app);
    const res = await agent.post("/api/login").send({ password: "nope" });
    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toBeUndefined();
    expect((await agent.get("/api/tracks")).status).toBe(401);
  });

  it("rejects a missing or non-string password with 401", async () => {
    t = await makeTestApp({ auth: AUTH });
    expect((await request(t.app).post("/api/login").send({})).status).toBe(401);
    expect((await request(t.app).post("/api/login").send({ password: 123 })).status).toBe(401);
    expect((await request(t.app).post("/api/login")).status).toBe(401);
  });

  it("rejects a tampered or forged cookie", async () => {
    t = await makeTestApp({ auth: AUTH });
    const login = await request(t.app).post("/api/login").send({ password: AUTH.password });
    const value = sessionCookie(login)!.split(";")[0];
    const tampered = value.slice(0, -2) + (value.endsWith("AA") ? "BB" : "AA");
    expect((await request(t.app).get("/api/tracks").set("Cookie", tampered)).status).toBe(401);
    expect((await request(t.app).get("/api/tracks").set("Cookie", "ttunes_session=garbage")).status).toBe(401);
    expect((await request(t.app).get("/api/tracks").set("Cookie", value)).status).toBe(200);
  });

  it("logout clears the cookie", async () => {
    t = await makeTestApp({ auth: AUTH });
    const agent = request.agent(t.app);
    await agent.post("/api/login").send({ password: AUTH.password });
    const out = await agent.post("/api/logout");
    expect(out.status).toBe(204);
    expect(sessionCookie(out)).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect((await agent.get("/api/session")).status).toBe(401);
  });

  it("invalidates sessions when the password or secret changes", async () => {
    t = await makeTestApp({ auth: AUTH });
    const login = await request(t.app).post("/api/login").send({ password: AUTH.password });
    const value = sessionCookie(login)!.split(";")[0];
    const deps = { repo: t.repo, storage: t.storage, uploadDir: t.uploadDir };
    const newPw = createApp({ ...deps, auth: createAuth({ ...AUTH, password: "changed" }) });
    const newSecret = createApp({ ...deps, auth: createAuth({ ...AUTH, secret: "other" }) });
    const same = createApp({ ...deps, auth: createAuth(AUTH) });
    expect((await request(newPw).get("/api/tracks").set("Cookie", value)).status).toBe(401);
    expect((await request(newSecret).get("/api/tracks").set("Cookie", value)).status).toBe(401);
    expect((await request(same).get("/api/tracks").set("Cookie", value)).status).toBe(200);
  });

  it("marks the cookie Secure when secure is on", async () => {
    t = await makeTestApp({ auth: { ...AUTH, secure: true } });
    const login = await request(t.app).post("/api/login").send({ password: AUTH.password });
    expect(sessionCookie(login)).toMatch(/; Secure/i);
  });

  it("returns 429 after 10 failed attempts and then blocks even the right password", async () => {
    t = await makeTestApp({ auth: AUTH });
    for (let i = 0; i < 10; i++) {
      expect((await request(t.app).post("/api/login").send({ password: "bad" })).status).toBe(401);
    }
    const blocked = await request(t.app).post("/api/login").send({ password: AUTH.password });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(sessionCookie(blocked)).toBeUndefined();
  });

  it("a successful login resets the failure counter", async () => {
    t = await makeTestApp({ auth: AUTH });
    for (let i = 0; i < 9; i++) await request(t.app).post("/api/login").send({ password: "bad" });
    expect((await request(t.app).post("/api/login").send({ password: AUTH.password })).status).toBe(204);
    for (let i = 0; i < 10; i++) {
      expect((await request(t.app).post("/api/login").send({ password: "bad" })).status).toBe(401);
    }
  });

  it("keeps /health public", async () => {
    t = await makeTestApp({ auth: AUTH });
    const res = await request(t.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
  });
});

describe("auth disabled (no auth dep)", () => {
  let t: TestApp;
  afterEach(() => t.cleanup());

  it("serves routes without a session and /api/session reports 204", async () => {
    t = await makeTestApp();
    expect((await request(t.app).get("/api/tracks")).status).toBe(200);
    expect((await request(t.app).get("/api/session")).status).toBe(204);
    expect((await request(t.app).get("/health")).status).toBe(200);
  });
});

describe("authFromEnv", () => {
  it("refuses to start in production without OWNER_PASSWORD", () => {
    expect(() => authFromEnv({ NODE_ENV: "production", SESSION_SECRET: "s" })).toThrow(/OWNER_PASSWORD/);
  });

  it("turns auth off with a warning in dev without OWNER_PASSWORD", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(authFromEnv({ NODE_ENV: "development" })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/auth is OFF/));
    warn.mockRestore();
  });

  it("requires SESSION_SECRET when a password is set", () => {
    expect(() => authFromEnv({ OWNER_PASSWORD: "pw" })).toThrow(/SESSION_SECRET/);
  });

  it("defaults the Secure cookie flag on in production, overridable by COOKIE_SECURE", async () => {
    const secureOf = async (env: NodeJS.ProcessEnv) => {
      const t = await makeTestApp();
      try {
        const app = createApp({ repo: t.repo, storage: t.storage, uploadDir: t.uploadDir, auth: authFromEnv(env) });
        const res = await request(app).post("/api/login").send({ password: "pw" });
        return /; Secure/i.test(sessionCookie(res) ?? "");
      } finally {
        t.cleanup();
      }
    };
    const base = { OWNER_PASSWORD: "pw", SESSION_SECRET: "s" };
    expect(await secureOf({ ...base, NODE_ENV: "production" })).toBe(true);
    expect(await secureOf({ ...base, NODE_ENV: "production", COOKIE_SECURE: "false" })).toBe(false);
    expect(await secureOf({ ...base })).toBe(false);
    expect(await secureOf({ ...base, COOKIE_SECURE: "true" })).toBe(true);
  });
});
