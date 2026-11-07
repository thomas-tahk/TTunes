import type { IncomingMessage, ServerResponse } from "node:http";
import { cookieHeader, newState, redirect, sendJson, STATE_COOKIE } from "../../../lib/auth.ts";

// GET /api/auth/github/login: start the OAuth authorization-code flow with a fresh `state`.
export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return sendJson(res, 500, { error: "login not configured" });
  const state = newState();
  res.setHeader("Set-Cookie", cookieHeader(STATE_COOKIE, state, 600));
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  redirect(res, url.toString());
}
