import type { IncomingMessage, ServerResponse } from "node:http";

// GET /api/time: server clock only, no database, never cached. Listeners use it to measure their clock offset.
export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ serverNow: Date.now() }));
}
