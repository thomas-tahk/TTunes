import type { IncomingMessage, ServerResponse } from "node:http";
import { LONG_SEC, lookupVideo, thumbnailOf } from "../../addSong.ts";
import { requireOwner, sendJson } from "../../auth.ts";
import { readJson } from "../../body.ts";
import { parseVideoId } from "../../ytlink.ts";

// POST /api/owner/preview {url} (owner only): what the link is, or why it can't be added.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  try {
    if (!(await requireOwner(req))) return sendJson(res, 401, { error: "owner only" });
    const videoId = parseVideoId((await readJson(req)).url);
    if (!videoId) return sendJson(res, 400, { error: "That doesn't look like a YouTube link." });
    const found = await lookupVideo(videoId);
    if (!found.ok) return sendJson(res, found.status, { error: found.message });
    const { info } = found;
    sendJson(res, 200, { videoId, title: info.title, durationSec: info.durationSec, thumbnail: thumbnailOf(videoId), long: info.durationSec > LONG_SEC });
  } catch (error) {
    console.error("POST /api/owner/preview failed", error);
    sendJson(res, 500, { error: "preview failed" });
  }
}
