import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../auth.ts";
import { readJson } from "../../body.ts";
import { sharedDb } from "../../db.ts";
import { identifyListener } from "../../listener.ts";
import { postRequest, validateText } from "../../requests.ts";
import { parseVideoId } from "../../ytlink.ts";

// POST /api/requests {link, name, dedication?} (public). `link` is any YouTube link or a bare video id; unknown fields are ignored.
// 201 {ok, request:{id,status:"waiting"|"queued",videoId,title,durationSec,thumbnail,name,dedication}}
// Refusals: {error, code} with 400 bad input, 403 off, 409 active_request / network_busy / already_coming_up, 422 too_long / video_unavailable, 429 rate_limited, 5xx YouTube trouble.
export default async function post(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  try {
    const listener = await identifyListener(req);
    if (listener.setCookie) res.setHeader("Set-Cookie", listener.setCookie);
    const body = await readJson(req);
    const text = validateText(body.name, body.dedication);
    if (!text.ok) return sendJson(res, text.status, { error: text.message, code: text.code });
    const videoId = parseVideoId(body.link);
    if (!videoId) return sendJson(res, 400, { error: "That doesn't look like a YouTube link.", code: "bad_link" });
    const result = await postRequest(sharedDb(), { videoId, name: text.name, dedication: text.dedication }, { listenerId: listener.id, ipHash: listener.ipHash }, Date.now);
    if (!result.ok) return sendJson(res, result.status, { error: result.message, code: result.code });
    sendJson(res, 201, { ok: true, request: result.request });
  } catch (error) {
    console.error("POST /api/requests failed", error);
    sendJson(res, 500, { error: "request failed", code: "server_error" });
  }
}
