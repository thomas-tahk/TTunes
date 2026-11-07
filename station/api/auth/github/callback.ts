import type { IncomingMessage, ServerResponse } from "node:http";
import { cookieHeader, isOwnerId, issueSession, parseCookies, redirect, sendJson, SESSION_COOKIE, SESSION_SECONDS, STATE_COOKIE, statesMatch } from "../../../lib/auth.ts";
import { sharedDb } from "../../../lib/db.ts";

async function githubUserId(code: string): Promise<number> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code }),
  });
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!tokenRes.ok || !token.access_token) throw new Error("GitHub token exchange failed");
  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "ttunes-station" },
  });
  const user = (await userRes.json()) as { id?: number };
  if (!userRes.ok || !user.id) throw new Error("GitHub user lookup failed");
  return user.id;
}

function refuse(res: ServerResponse, status: number, error: string): void {
  res.setHeader("Set-Cookie", cookieHeader(STATE_COOKIE, "", 0));
  sendJson(res, status, { error });
}

// GET /api/auth/github/callback: check `state`, trade the code, admit only the owner.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!statesMatch(parseCookies(req.headers.cookie)[STATE_COOKIE], url.searchParams.get("state"))) return refuse(res, 400, "bad state");
  const code = url.searchParams.get("code");
  if (!code) return refuse(res, 400, "missing code");
  try {
    if (!isOwnerId(await githubUserId(code))) return refuse(res, 403, "not the owner");
    const session = await issueSession(sharedDb());
    res.setHeader("Set-Cookie", [cookieHeader(STATE_COOKIE, "", 0), cookieHeader(SESSION_COOKIE, session, SESSION_SECONDS)]);
    redirect(res, "/");
  } catch (error) {
    console.error("GET /api/auth/github/callback failed", error);
    refuse(res, 502, "login failed");
  }
}
