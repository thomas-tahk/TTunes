import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import callback from "../api/auth/github/callback.ts";
import login from "../api/auth/github/login.ts";
import me from "../api/auth/me.ts";
import signoutAll from "../api/auth/signout-all.ts";
import { requireOwner } from "../lib/auth.ts";
import { createDb, sharedDb } from "../lib/db.ts";
import { migrate } from "../lib/migrate.ts";

let server: Server;
let base: string;
let githubUser = "thomas-tahk";
const realFetch = globalThis.fetch;

type H = (req: IncomingMessage, res: ServerResponse) => unknown;
const routes: Record<string, H> = {
  "/api/auth/github/login": login,
  "/api/auth/github/callback": callback,
  "/api/auth/me": me,
  "/api/auth/signout-all": signoutAll,
};

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
  process.env.GITHUB_CLIENT_ID = "cid";
  process.env.GITHUB_CLIENT_SECRET = "csecret";
  const db = createDb();
  await migrate(db);
  await db.end();
  server = createServer((req, res) => void routes[new URL(req.url!, "http://x").pathname]?.(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await sharedDb().end();
});
beforeEach(() => {
  githubUser = "thomas-tahk";
  // GitHub is stubbed; local calls pass through.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "tok" });
    if (url.startsWith("https://api.github.com/user")) return Response.json({ login: githubUser });
    if (!url.startsWith(base)) throw new Error(`unstubbed network call: ${url}`);
    return realFetch(input, init);
  });
});

/** Runs login, returns the state cookie header and the state sent to GitHub. */
async function startLogin(): Promise<{ stateCookie: string; state: string }> {
  const res = await fetch(`${base}/api/auth/github/login`, { redirect: "manual" });
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { stateCookie: res.headers.get("set-cookie")!.split(";")[0]!, state };
}

async function doCallback(query: (state: string) => string, withCookie = true): Promise<Response> {
  const { stateCookie, state } = await startLogin();
  return fetch(`${base}/api/auth/github/callback?${query(state)}`, { redirect: "manual", headers: withCookie ? { cookie: stateCookie } : {} });
}

async function ownerCookie(): Promise<string> {
  const res = await doCallback((s) => `code=abc&state=${s}`);
  return res.headers.getSetCookie().find((c) => c.startsWith("ttunes_session="))!.split(";")[0]!;
}

const post = (cookie?: string) => fetch(`${base}/api/auth/signout-all`, { method: "POST", headers: cookie ? { cookie } : {} });

it("refuses a different GitHub account and sets no session cookie", async () => {
  githubUser = "someone-else";
  const res = await doCallback((s) => `code=abc&state=${s}`);
  expect(res.status).toBe(403);
  expect(res.headers.getSetCookie().some((c) => c.startsWith("ttunes_session="))).toBe(false);
});

it("accepts thomas-tahk case-insensitively with a hardened cookie that passes requireOwner", async () => {
  githubUser = "Thomas-Tahk";
  const res = await doCallback((s) => `code=abc&state=${s}`);
  expect(res.status).toBe(302);
  const set = res.headers.getSetCookie().find((c) => c.startsWith("ttunes_session="))!;
  expect(set).toMatch(/HttpOnly/);
  expect(set).toMatch(/Secure/);
  expect(set).toMatch(/SameSite=Lax/);
  const cookie = set.split(";")[0]!;
  expect(await requireOwner({ headers: { cookie } } as IncomingMessage)).toBe(true);
  const meRes = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  expect(await meRes.json()).toEqual({ owner: true });
});

it("me says owner:false without a cookie", async () => {
  expect(await (await fetch(`${base}/api/auth/me`)).json()).toEqual({ owner: false });
});

it("signout-all is 401 with no cookie, a tampered cookie, or a forged one", async () => {
  expect((await post()).status).toBe(401);
  const good = await ownerCookie();
  expect((await post(good.slice(0, -3) + "AAA")).status).toBe(401);
  const forged = await new SignJWT({ ver: 1 }).setProtectedHeader({ alg: "HS256" }).setSubject("thomas-tahk").sign(new TextEncoder().encode("other-secret-other-secret-other"));
  expect((await post(`ttunes_session=${forged}`)).status).toBe(401);
});

it("after signout-all the earlier cookie is refused", async () => {
  const old = await ownerCookie();
  expect((await post(old)).status).toBe(200);
  expect((await post(old)).status).toBe(401);
  expect(await (await fetch(`${base}/api/auth/me`, { headers: { cookie: old } })).json()).toEqual({ owner: false });
  const fresh = await ownerCookie();
  expect(await requireOwner({ headers: { cookie: fresh } } as IncomingMessage)).toBe(true);
});

it("refuses a bad or missing state, and a missing state cookie", async () => {
  const bad = await doCallback(() => "code=abc&state=wrong");
  expect(bad.status).toBe(400);
  const none = await doCallback(() => "code=abc");
  expect(none.status).toBe(400);
  const noCookie = await doCallback((s) => `code=abc&state=${s}`, false);
  expect(noCookie.status).toBe(400);
  for (const r of [bad, none, noCookie]) expect(r.headers.getSetCookie().some((c) => c.startsWith("ttunes_session="))).toBe(false);
});

it("login redirects to GitHub with client_id and a state matching the cookie", async () => {
  const res = await fetch(`${base}/api/auth/github/login`, { redirect: "manual" });
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(loc.searchParams.get("client_id")).toBe("cid");
  expect(res.headers.get("set-cookie")).toContain(`ttunes_oauth_state=${loc.searchParams.get("state")}`);
});
