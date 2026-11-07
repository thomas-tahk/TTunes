import type { IncomingMessage, ServerResponse } from "node:http";
import { bumpSessionVersion, requireOwner, sendJson } from "../../lib/auth.ts";
import { sharedDb } from "../../lib/db.ts";

// POST /api/auth/signout-all (owner only): bumps the session version, so every existing cookie is refused.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
  try {
    if (!(await requireOwner(req))) return sendJson(res, 401, { error: "owner only" });
    await bumpSessionVersion(sharedDb());
    sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error("POST /api/auth/signout-all failed", error);
    sendJson(res, 500, { error: "signout failed" });
  }
}
