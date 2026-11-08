import type { IncomingMessage, ServerResponse } from "node:http";
import { lookupVideo, thumbnailOf } from "../../addSong.ts";
import { sendJson } from "../../auth.ts";
import { sharedDb } from "../../db.ts";
import { identifyListener } from "../../listener.ts";
import { reservePreview } from "../../listenerPreview.ts";
import { parseVideoId } from "../../ytlink.ts";

// GET /api/requests/preview?link= (public, never cached) -> {videoId,title,channelTitle,durationSec,thumbnail}: what a pasted link is, before sending.
// One YouTube lookup. Refusals {error, code}: 400 bad_link, 403 off, 429 rate_limited (30/hour per cookie or network, separate from requests),
// 503 paused (shared daily lookup cap) and the lookup's own refusals (unavailable, embed blocked).
// POST /api/requests still re-fetches the video itself; this route is only a preview.
export default async function preview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });
  try {
    const videoId = parseVideoId(new URL(req.url ?? "/", "http://x").searchParams.get("link"));
    if (!videoId) return sendJson(res, 400, { error: "That doesn't look like a YouTube link.", code: "bad_link" });
    const listener = await identifyListener(req);
    if (listener.setCookie) res.setHeader("Set-Cookie", listener.setCookie);
    const refusal = await reservePreview(sharedDb(), { listenerId: listener.id, ipHash: listener.ipHash }, Date.now);
    if (refusal) return sendJson(res, refusal.status, { error: refusal.message, code: refusal.code });
    const found = await lookupVideo(videoId);
    if (!found.ok) return sendJson(res, found.status, { error: found.message, code: "video_unavailable" });
    const { info } = found;
    sendJson(res, 200, { videoId, title: info.title, channelTitle: info.channelTitle, durationSec: info.durationSec, thumbnail: thumbnailOf(videoId) });
  } catch (error) {
    console.error("GET /api/requests/preview failed", error);
    sendJson(res, 500, { error: "preview failed", code: "server_error" });
  }
}
