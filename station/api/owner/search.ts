import type { IncomingMessage, ServerResponse } from "node:http";
import { requireOwner, sendJson } from "../../lib/auth.ts";
import { searchSongs } from "../../lib/search.ts";
import { QuotaExceededError } from "../../lib/youtube.ts";

const MAX_QUERY_LENGTH = 100;
const QUOTA_MESSAGE = "Search limit for today is used up — paste a YouTube link instead, or try again tomorrow.";

// GET /api/owner/search?q= (owner only): ranked YouTube matches for a typed query.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });
  try {
    if (!(await requireOwner(req))) return sendJson(res, 401, { error: "owner only" });
    const q = (new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "").trim();
    if (!q || q.length > MAX_QUERY_LENGTH) return sendJson(res, 400, { error: `q must be 1-${MAX_QUERY_LENGTH} characters` });
    sendJson(res, 200, { results: await searchSongs(q) });
  } catch (error) {
    if (error instanceof QuotaExceededError) return sendJson(res, 429, { error: QUOTA_MESSAGE });
    console.error("GET /api/owner/search failed", error instanceof Error ? error.message : error);
    sendJson(res, 500, { error: "search failed" });
  }
}
