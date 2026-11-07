import type { IncomingMessage, ServerResponse } from "node:http";
import { insertSong, LONG_SEC, lookupVideo } from "../../lib/addSong.ts";
import { requireOwner, sendJson } from "../../lib/auth.ts";
import { readJson } from "../../lib/body.ts";
import { sharedDb } from "../../lib/db.ts";
import { parseVideoId } from "../../lib/ytlink.ts";

// POST /api/owner/songs {videoId, position, confirmLong?} (owner only): adds to library and queue.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  try {
    if (!(await requireOwner(req))) return sendJson(res, 401, { error: "owner only" });
    const body = await readJson(req);
    const videoId = typeof body.videoId === "string" && /^[\w-]{11}$/.test(body.videoId) ? parseVideoId(body.videoId) : null;
    if (!videoId || (body.position !== "next" && body.position !== "queue")) return sendJson(res, 400, { error: "videoId and position (next or queue) are required." });
    const found = await lookupVideo(videoId); // never trust client titles: always re-fetched
    if (!found.ok) return sendJson(res, found.status, { error: found.message });
    if (found.info.durationSec > LONG_SEC && body.confirmLong !== true) {
      return sendJson(res, 409, { error: `That video is ${Math.round(found.info.durationSec / 60)} minutes long. Add anyway?`, needsConfirm: true });
    }
    await insertSong(sharedDb(), found.info, body.position);
    sendJson(res, 200, { ok: true, videoId, title: found.info.title, position: body.position });
  } catch (error) {
    console.error("POST /api/owner/songs failed", error);
    sendJson(res, 500, { error: "add failed" });
  }
}
