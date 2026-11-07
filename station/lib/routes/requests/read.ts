import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../auth.ts";
import { sharedDb } from "../../db.ts";
import { identifyListener } from "../../listener.ts";
import { findMine, listFeed } from "../../requests.ts";

// GET /api/requests/feed (public, CDN-cached 10s) -> {mode, requests:[{id,name,dedication,videoId,title,durationSec,thumbnail,status,createdAt}]}
// Newest first, at most 30, denied hidden. No listener id, IP hash or attempt data ever leaves here.
export async function feed(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await listFeed(sharedDb(), Date.now);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=5");
    res.end(JSON.stringify(body));
  } catch (error) {
    console.error("GET /api/requests/feed failed", error);
    sendJson(res, 500, { error: "feed unavailable", code: "server_error" });
  }
}

// GET /api/requests/mine (never cached, personal) -> {request: {id,videoId,title,thumbnail,status,createdAt} | null}
// The caller's own waiting/queued/playing request. Does not issue a cookie.
export async function mine(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const listener = await identifyListener(req);
    sendJson(res, 200, { request: await findMine(sharedDb(), { listenerId: listener.id, ipHash: listener.ipHash }, Date.now) });
  } catch (error) {
    console.error("GET /api/requests/mine failed", error);
    sendJson(res, 500, { error: "lookup failed", code: "server_error" });
  }
}
