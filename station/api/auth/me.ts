import type { IncomingMessage, ServerResponse } from "node:http";
import { requireOwner, sendJson } from "../../lib/auth.ts";

// GET /api/auth/me: {owner:true|false}. Listeners need no login.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    sendJson(res, 200, { owner: await requireOwner(req) });
  } catch (error) {
    console.error("GET /api/auth/me failed", error);
    sendJson(res, 500, { error: "auth unavailable" });
  }
}
