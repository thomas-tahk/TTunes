import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../auth.ts";
import { sharedDb } from "../../db.ts";
import { identifyListener } from "../../listener.ts";
import { reserveSearch, SEARCH_PAUSED_MESSAGE } from "../../listenerSearch.ts";
import { searchSongs } from "../../search.ts";
import { QuotaExceededError } from "../../youtube.ts";

const MAX_QUERY_LENGTH = 100;

// GET /api/requests/search?q= (public, never cached) -> {results:[{videoId,title,channelTitle,durationSec,thumbnail}]}, same ranking as the owner search.
// Refusals {error, code}: 400 bad_query, 403 off, 429 rate_limited (5/hour per cookie or network), 503 search_paused (60/day budget used) / youtube_unavailable.
export default async function search(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });
  try {
    const q = (new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "").trim();
    if (!q || q.length > MAX_QUERY_LENGTH) return sendJson(res, 400, { error: `Search needs 1 to ${MAX_QUERY_LENGTH} characters.`, code: "bad_query" });
    const listener = await identifyListener(req);
    if (listener.setCookie) res.setHeader("Set-Cookie", listener.setCookie);
    const refusal = await reserveSearch(sharedDb(), { listenerId: listener.id, ipHash: listener.ipHash }, Date.now);
    if (refusal) return sendJson(res, refusal.status, { error: refusal.message, code: refusal.code });
    const results = await searchSongs(q, { strict: true });
    sendJson(res, 200, { results: results.map(({ videoId, title, channelTitle, durationSec, thumbnail }) => ({ videoId, title, channelTitle, durationSec, thumbnail })) });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      const dailyLimit = error.reason === "quotaExceeded" && error.source === "search.list"; // only this means "100 searches a day used up"
      if (dailyLimit) return sendJson(res, 503, { error: SEARCH_PAUSED_MESSAGE, code: "search_paused" });
      return sendJson(res, 503, { error: "YouTube is busy — try again shortly, or paste a link.", code: "youtube_unavailable" });
    }
    console.error("GET /api/requests/search failed", error instanceof Error ? error.message : error);
    sendJson(res, 500, { error: "search failed", code: "server_error" });
  }
}
