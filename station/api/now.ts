import type { IncomingMessage, ServerResponse } from "node:http";
import { sharedDb } from "../lib/db.ts";
import { cacheSeconds, getNowPlaying } from "../lib/schedule.ts";

function send(res: ServerResponse, status: number, body: unknown, cacheControl: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", cacheControl);
  res.end(JSON.stringify(body));
}

// GET /api/now: what plays now and next. Lazily moves the station on when the song has ended.
export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const playing = await getNowPlaying(sharedDb(), Date.now);
    const seconds = cacheSeconds(playing);
    send(res, 200, playing, seconds > 0 ? `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=5` : "no-store");
  } catch (error) {
    console.error("GET /api/now failed", error);
    send(res, 500, { error: "station unavailable" }, "no-store");
  }
}
