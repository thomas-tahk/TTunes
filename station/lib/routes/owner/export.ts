import type { IncomingMessage, ServerResponse } from "node:http";
import { requireOwner, sendJson } from "../../auth.ts";
import { sharedDb } from "../../db.ts";
import { exportLibrary } from "../../upkeep.ts";

// GET /api/owner/export (owner only): the whole library as a JSON download.
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") return sendJson(res, 405, { error: "GET only" });
  try {
    if (!(await requireOwner(req))) return sendJson(res, 401, { error: "owner only" });
    const data = await exportLibrary(sharedDb());
    res.setHeader("Content-Disposition", `attachment; filename="ttunes-library-${data.exportedAt.slice(0, 10)}.json"`);
    sendJson(res, 200, data);
  } catch (error) {
    console.error("GET /api/owner/export failed", error);
    sendJson(res, 500, { error: "export failed" });
  }
}
