import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import callback from "../api/auth/github/callback.ts";
import login from "../api/auth/github/login.ts";
import me from "../api/auth/me.ts";
import signoutAll from "../api/auth/signout-all.ts";
import { currentSessionVersion, requireOwner } from "../lib/auth.ts";
import { createDb, sharedDb } from "../lib/db.ts";
import { migrate } from "../lib/migrate.ts";

let server: Server;
let base: string;
let githubUser = { login: "thomas-tahk", id: 10647431 };
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
  githubUser = { login: "thomas-tahk", id: 10647431 };
  // GitHub is stubbed; local calls pass through.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "tok" });
    if (url.startsWith("https://api.github.com/user")) return Response.json(githubUser);
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

const ver = () => currentSessionVersion(sharedDb());
const post = (cookie?: string) => fetch(`${base}/api/auth/signout-all`, { method: "POST", headers: cookie ? { cookie } : {} });

it("refuses a different GitHub account and sets no session cookie", async () => {
  githubUser = { login: "someone-else", id: 1 };
  const res = await doCallback((s) => `code=abc&state=${s}`);
  expect(res.status).toBe(403);
  expect(res.headers.getSetCookie().some((c) => c.startsWith("ttunes_session="))).toBe(false);
});

it("refuses a user named thomas-tahk with a different id", async () => {
  githubUser = { login: "thomas-tahk", id: 999 };
  const res = await doCallback((s) => `code=abc&state=${s}`);
  expect(res.status).toBe(403);
  expect(res.headers.getSetCookie().some((c) => c.startsWith("ttunes_session="))).toBe(false);
});

it("accepts the owner id with a hardened cookie that passes requireOwner", async () => {
  githubUser = { login: "Thomas-Tahk", id: 10647431 };
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
  const forged = await new SignJWT({ ver: await ver() }).setProtectedHeader({ alg: "HS256" }).setSubject("10647431").setExpirationTime("1h").sign(new TextEncoder().encode("other-secret-other-secret-other"));
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

const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET);
const meWith = async (cookie: string) => (await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()) as { owner: boolean };

it("control: a hand-signed HS256 token with owner sub, current version and exp is accepted", async () => {
  const good = await new SignJWT({ ver: await ver() }).setProtectedHeader({ alg: "HS256" }).setSubject("10647431").setExpirationTime("1h").sign(secret());
  expect(await meWith(`ttunes_session=${good}`)).toEqual({ owner: true });
});

it("refuses alg:none, wrong-alg, expired and exp-less tokens without a 500", async () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "10647431", ver: await ver(), exp: 9999999999 })}.`;
  const hs512 = await new SignJWT({ ver: await ver() }).setProtectedHeader({ alg: "HS512" }).setSubject("10647431").setExpirationTime("1h").sign(secret());
  const expired = await new SignJWT({ ver: await ver() }).setProtectedHeader({ alg: "HS256" }).setSubject("10647431").setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(secret());
  const noExp = await new SignJWT({ ver: await ver() }).setProtectedHeader({ alg: "HS256" }).setSubject("10647431").sign(secret());
  for (const token of [none, hs512, expired, noExp]) {
    expect(await meWith(`ttunes_session=${token}`)).toEqual({ owner: false });
    expect((await post(`ttunes_session=${token}`)).status).toBe(401);
  }
});

it("a malformed cookie value is ignored, not a 500", async () => {
  expect(await meWith("ttunes_session=%E0%A4%A; other=%")).toEqual({ owner: false });
  const { state } = await startLogin();
  const res = await fetch(`${base}/api/auth/github/callback?code=abc&state=${state}`, { headers: { cookie: "x=%; ttunes_oauth_state=%zz" } });
  expect(res.status).toBe(400);
});

it("rejects a SESSION_SECRET shorter than 32 bytes", async () => {
  const saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "short";
  try {
    await expect(requireOwner({ headers: { cookie: "ttunes_session=abc" } } as IncomingMessage)).rejects.toThrow(/32 bytes/);
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

it("refuses a correctly signed token for a different subject", async () => {
  const other = await new SignJWT({ ver: await ver() }).setProtectedHeader({ alg: "HS256" }).setSubject("1").setExpirationTime("1h").sign(secret());
  expect(await meWith(`ttunes_session=${other}`)).toEqual({ owner: false });
  expect((await post(`ttunes_session=${other}`)).status).toBe(401);
});
