import type { IncomingMessage, ServerResponse } from "node:http";
import { requireOwner, sendJson } from "../../auth.ts";
import { searchSongs } from "../../search.ts";
import { QuotaExceededError } from "../../youtube.ts";

const MAX_QUERY_LENGTH = 100;
const QUOTA_MESSAGE = "Search limit for today is used up — paste a YouTube link instead, or try again tomorrow.";
const BUSY_MESSAGE = "YouTube is busy — try again shortly.";

// GET /api/owner/search?q= (owner only): ranked YouTube matches for a typed query.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });
  try {
    if (!(await requireOwner(req))) return sendJson(res, 401, { error: "owner only" });
    const q = (new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "").trim();
    if (!q || q.length > MAX_QUERY_LENGTH) return sendJson(res, 400, { error: `q must be 1-${MAX_QUERY_LENGTH} characters` });
    sendJson(res, 200, { results: await searchSongs(q) });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      const dailyLimit = error.reason === "quotaExceeded" && error.source === "search.list"; // only this means "100 searches a day used up"
      return sendJson(res, dailyLimit ? 429 : 503, { error: dailyLimit ? QUOTA_MESSAGE : BUSY_MESSAGE });
    }
    console.error("GET /api/owner/search failed", error instanceof Error ? error.message : error);
    sendJson(res, 500, { error: "search failed" });
  }
}
